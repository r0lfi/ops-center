//! Local Claude Code agents: each one is a long-running `claude -p` process on
//! this host speaking stream-json on stdin/stdout, with the user's own account,
//! settings, CLAUDE.md rules, MCP servers and permission mode.
//!
//! Permission prompts and AskUserQuestion come back as `can_use_tool`
//! control requests (`--permission-prompts host --permission-prompt-tool
//! stdio`); opstui shows them as approvals and answers on stdin, the way the
//! interactive CLI asks in the terminal. A closed process is resumed
//! (`--resume <session>`) on the next message.
//!
//! These agents live only in this opstui process. They are shown next to the
//! Ops-Center agents but are not registered in the backend.

use crate::mask::mask;
use crate::model::Task;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, mpsc::Sender, Notify};

pub const RUNTIME: &str = "claude-local";

#[derive(Debug, Clone)]
pub struct Settings {
    pub bin: String,
    pub dir: String,
    pub permission_mode: String,
}

#[derive(Debug)]
pub struct Session {
    pub slug: String,
    pub name: String,
    pub session_id: String,
    /// The first process creates the session, later ones resume it.
    pub started: bool,
    pub turns: Vec<Task>,
    pub model: Option<String>,
    pub activity: Option<String>,
    pub busy: bool,
    pub failed: bool,
    /// An interrupt was sent; the running turn ends as cancelled.
    pub interrupting: bool,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Lines for the process's stdin; None when no process runs.
    pub input: Option<mpsc::UnboundedSender<String>>,
    pub cancel: Arc<Notify>,
}

impl Session {
    pub fn new(n: usize) -> Self {
        Self::named(format!("claude-{n}"), format!("Claude {n}"))
    }

    /// Session with a fixed name, e.g. the default agent from the config.
    pub fn named(slug: String, name: String) -> Self {
        Self {
            slug,
            name,
            session_id: uuid::Uuid::new_v4().to_string(),
            started: false,
            turns: Vec::new(),
            model: None,
            activity: None,
            busy: false,
            failed: false,
            interrupting: false,
            cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            input: None,
            cancel: Arc::new(Notify::new()),
        }
    }

    pub fn agent_id(&self) -> String {
        format!("local:{}", self.slug)
    }

    pub fn conversation_key(&self) -> String {
        format!("claude:{}", self.slug)
    }

    pub fn status(&self) -> &'static str {
        if self.busy {
            "working"
        } else if self.failed {
            "error"
        } else {
            "idle"
        }
    }

    /// Writes one stream-json line to the running process.
    pub fn write(&self, line: String) -> bool {
        self.input.as_ref().is_some_and(|i| i.send(line).is_ok())
    }
}

/// A `can_use_tool` request: Claude waits until it is answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    pub request_id: String,
    pub tool: String,
    pub input: Value,
    pub description: Option<String>,
    /// Rules Claude suggests for "always allow" (permission_suggestions).
    pub suggestions: Value,
}

impl Prompt {
    pub fn is_question(&self) -> bool {
        self.tool == "AskUserQuestion"
    }

    /// The questions of an AskUserQuestion request.
    pub fn questions(&self) -> Vec<Question> {
        self.input
            .get("questions")
            .and_then(Value::as_array)
            .map(|qs| {
                qs.iter()
                    .map(|q| Question {
                        question: q
                            .get("question")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        header: q
                            .get("header")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        multi: q
                            .get("multiSelect")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        options: q
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|o| {
                                o.iter()
                                    .map(|x| {
                                        (
                                            x.get("label")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string(),
                                            x.get("description")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string(),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub multi: bool,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Init {
        model: Option<String>,
    },
    Text(String),
    ToolUse {
        name: String,
        summary: String,
    },
    ToolResult {
        error: bool,
        text: String,
    },
    Permission(Prompt),
    Done {
        text: Option<String>,
        error: bool,
        cost: f64,
        input: i64,
        output: i64,
        denials: usize,
    },
    Exit {
        ok: bool,
        detail: String,
    },
}

// ------------------------------------------------------------------ stdin lines

pub fn init_line() -> String {
    json!({"type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(),
           "request": {"subtype": "initialize", "hooks": null}})
    .to_string()
}

pub fn user_line(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
}

pub fn interrupt_line() -> String {
    json!({"type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(),
           "request": {"subtype": "interrupt"}})
    .to_string()
}

/// Allow a tool call with `input` (for a question: with the answers added);
/// `always` also stores Claude's suggested permission rules.
pub fn allow_line(p: &Prompt, input: Value, always: bool) -> String {
    let mut response = json!({"behavior": "allow", "updatedInput": input});
    if always && p.suggestions.as_array().is_some_and(|a| !a.is_empty()) {
        response["updatedPermissions"] = p.suggestions.clone();
    }
    json!({"type": "control_response",
           "response": {"subtype": "success", "request_id": p.request_id, "response": response}})
    .to_string()
}

pub fn deny_line(p: &Prompt, message: &str) -> String {
    json!({"type": "control_response",
           "response": {"subtype": "success", "request_id": p.request_id,
                        "response": {"behavior": "deny", "message": message}}})
    .to_string()
}

/// AskUserQuestion input with the chosen answers (question text → label).
pub fn with_answers(p: &Prompt, answers: &[(String, String)]) -> Value {
    let mut input = p.input.clone();
    let map: serde_json::Map<String, Value> = answers
        .iter()
        .map(|(q, a)| (q.clone(), Value::String(a.clone())))
        .collect();
    input["answers"] = Value::Object(map);
    input
}

// ------------------------------------------------------------------ stdout

/// What a tool call is about, in one line (command, file, pattern …).
pub fn summarize_input(name: &str, input: &Value) -> String {
    let field = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let s = match name {
        "Bash" => field("command"),
        "Read" | "Write" | "Edit" | "NotebookEdit" => field("file_path"),
        "Grep" | "Glob" => field("pattern"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Agent" | "Task" => field("description"),
        _ => None,
    }
    .unwrap_or_else(|| input.to_string());
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    mask(&one.chars().take(160).collect::<String>())
}

/// Turns one stream-json line into events (an assistant message can hold
/// several text and tool_use blocks).
pub fn parse_line(line: &str) -> Vec<Event> {
    let Ok(e) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let content = || {
        e.pointer("/message/content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    match (
        e.get("type").and_then(Value::as_str),
        e.get("subtype").and_then(Value::as_str),
    ) {
        (Some("system"), Some("init")) => {
            vec![Event::Init {
                model: e.get("model").and_then(Value::as_str).map(str::to_string),
            }]
        }
        (Some("control_request"), _) => {
            let r = e.get("request").cloned().unwrap_or(Value::Null);
            if r.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
                return Vec::new();
            }
            vec![Event::Permission(Prompt {
                request_id: e
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                tool: r
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                input: r.get("input").cloned().unwrap_or(json!({})),
                description: r
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                suggestions: r
                    .get("permission_suggestions")
                    .cloned()
                    .unwrap_or(json!([])),
            })]
        }
        (Some("assistant"), _) => content()
            .iter()
            .filter_map(|c| match c.get("type").and_then(Value::as_str) {
                Some("text") => c
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| Event::Text(t.to_string())),
                Some("tool_use") => {
                    let name = c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let summary = summarize_input(&name, c.get("input").unwrap_or(&Value::Null));
                    Some(Event::ToolUse { name, summary })
                }
                _ => None,
            })
            .collect(),
        (Some("user"), _) => content()
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("tool_result"))
            .map(|c| {
                let text = match c.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter_map(|x| x.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" "),
                    _ => String::new(),
                };
                let first = text
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect::<String>();
                Event::ToolResult {
                    error: c.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                    text: mask(&first),
                }
            })
            .collect(),
        (Some("result"), _) => {
            let u = e.get("usage").cloned().unwrap_or(Value::Null);
            let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
            vec![Event::Done {
                text: e.get("result").and_then(Value::as_str).map(str::to_string),
                error: e.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                    || e.get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s != "success"),
                cost: e
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                input: n("input_tokens")
                    + n("cache_creation_input_tokens")
                    + n("cache_read_input_tokens"),
                output: n("output_tokens"),
                denials: e
                    .get("permission_denials")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0),
            }]
        }
        _ => Vec::new(),
    }
}

/// Starts the process and returns the stdin channel; the future runs until
/// the process ends (stdin closed, killed via `cancel`, or exit).
pub fn spawn(
    cfg: Settings,
    session_id: String,
    resume: bool,
    slug: String,
    tx: Sender<crate::sync::Msg>,
    cancel: Arc<Notify>,
) -> (
    mpsc::UnboundedSender<String>,
    impl std::future::Future<Output = ()> + Send + 'static,
) {
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    (in_tx, run(cfg, session_id, resume, slug, tx, in_rx, cancel))
}

async fn run(
    cfg: Settings,
    session_id: String,
    resume: bool,
    slug: String,
    tx: Sender<crate::sync::Msg>,
    mut input: mpsc::UnboundedReceiver<String>,
    cancel: Arc<Notify>,
) {
    let send = |ev: Event| {
        let (tx, slug) = (tx.clone(), slug.clone());
        async move {
            let _ = tx.send(crate::sync::Msg::Claude(slug, ev)).await;
        }
    };
    let mut cmd = tokio::process::Command::new(&cfg.bin);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]);
    cmd.args([
        "--permission-prompts",
        "host",
        "--permission-prompt-tool",
        "stdio",
    ]);
    if !cfg.permission_mode.is_empty() {
        cmd.args(["--permission-mode", &cfg.permission_mode]);
    }
    cmd.args([
        if resume { "--resume" } else { "--session-id" },
        &session_id,
    ]);
    cmd.current_dir(&cfg.dir)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return send(Event::Exit {
                ok: false,
                detail: format!("cannot start {}: {e}", cfg.bin),
            })
            .await
        }
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return send(Event::Exit {
            ok: false,
            detail: "no pipes to claude".into(),
        })
        .await;
    };
    let mut stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.take(8192).read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).to_string()
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut stdin_open = true;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    for ev in parse_line(&l) {
                        send(ev).await;
                    }
                }
                _ => break,
            },
            msg = input.recv(), if stdin_open => match msg {
                Some(m) => {
                    if stdin.write_all(format!("{m}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                        stdin_open = false;
                    }
                }
                None => {
                    // Channel closed (agent closed): EOF ends the process.
                    let _ = stdin.shutdown().await;
                    stdin_open = false;
                }
            },
            _ = cancel.notified() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return send(Event::Exit { ok: false, detail: "stopped".into() }).await;
            }
        }
    }
    let status = child.wait().await;
    let err = err_task.await.unwrap_or_default();
    let ok = status.as_ref().is_ok_and(|s| s.success());
    let tail: String = err
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ");
    let detail = match (&status, ok, tail.is_empty()) {
        (_, true, _) => String::new(),
        (Ok(s), false, true) => format!("claude exited with {s}"),
        (Ok(s), false, false) => format!("claude exited with {s}: {}", mask(&tail)),
        (Err(e), _, _) => e.to_string(),
    };
    send(Event::Exit { ok, detail }).await;
}

/// Tool call as stored in a turn's `tools_used` (same shape as backend tasks).
pub fn tool_entry(name: &str, summary: &str) -> Value {
    json!({"tool": name, "arguments": {"summary": summary}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_stream_json_turn() {
        let lines = [
            r#"{"type":"system","subtype":"init","cwd":"/x","session_id":"s","model":"claude-opus-5-5"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"pwd","description":"d"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"/data\nmore","is_error":false}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"/data","total_cost_usd":0.15,"usage":{"input_tokens":4,"cache_creation_input_tokens":10,"cache_read_input_tokens":6,"output_tokens":89},"permission_denials":[{"tool_name":"Bash"}]}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"init"}}"#,
            "not json",
        ];
        let ev: Vec<Event> = lines.iter().flat_map(|l| parse_line(l)).collect();
        assert_eq!(
            ev,
            vec![
                Event::Init {
                    model: Some("claude-opus-5-5".into())
                },
                Event::Text("Looking".into()),
                Event::ToolUse {
                    name: "Bash".into(),
                    summary: "pwd".into()
                },
                Event::ToolResult {
                    error: false,
                    text: "/data".into()
                },
                Event::Done {
                    text: Some("/data".into()),
                    error: false,
                    cost: 0.15,
                    input: 20,
                    output: 89,
                    denials: 1
                },
            ]
        );
    }

    #[test]
    fn permission_requests_and_answers_round_trip() {
        let line = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash",
            "input":{"command":"touch x"},"description":"Create x","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch x"}],"behavior":"allow","destination":"localSettings"}]}}"#;
        let [Event::Permission(p)] = &parse_line(line)[..] else {
            panic!("no prompt")
        };
        assert_eq!(
            (p.tool.as_str(), p.description.as_deref()),
            ("Bash", Some("Create x"))
        );
        let allow: Value = serde_json::from_str(&allow_line(p, p.input.clone(), false)).unwrap();
        assert_eq!(allow["response"]["request_id"], "r1");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(
            allow["response"]["response"]["updatedInput"]["command"],
            "touch x"
        );
        assert!(allow["response"]["response"]
            .get("updatedPermissions")
            .is_none());
        let always: Value = serde_json::from_str(&allow_line(p, p.input.clone(), true)).unwrap();
        assert_eq!(
            always["response"]["response"]["updatedPermissions"][0]["destination"],
            "localSettings"
        );
        let deny: Value = serde_json::from_str(&deny_line(p, "no")).unwrap();
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
    }

    #[test]
    fn questions_are_read_and_answered() {
        let p = Prompt {
            request_id: "q".into(),
            tool: "AskUserQuestion".into(),
            input: json!({"questions":[{"question":"Which color?","header":"Color","multiSelect":false,
                           "options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]}),
            description: None,
            suggestions: json!([]),
        };
        assert!(p.is_question());
        let q = &p.questions()[0];
        assert_eq!(
            (q.question.as_str(), q.options.len(), q.multi),
            ("Which color?", 2, false)
        );
        let input = with_answers(&p, &[("Which color?".into(), "Blue".into())]);
        assert_eq!(input["answers"]["Which color?"], "Blue");
        assert_eq!(input["questions"][0]["header"], "Color");
    }

    #[test]
    fn tool_summaries_are_short_and_masked() {
        let s = summarize_input(
            "Bash",
            &json!({"command": "curl -H 'Authorization: Bearer abc.def' x"}),
        );
        assert!(!s.contains("abc.def"), "{s}");
        assert_eq!(
            summarize_input("Read", &json!({"file_path": "/etc/hosts"})),
            "/etc/hosts"
        );
    }
}
