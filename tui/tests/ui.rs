//! App state, keyboard handling and rendering, without a terminal or server.

use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use opstui::app::{AgentGroup, AgentRow, App, Modal, View};
use opstui::config::Config;
use opstui::model::*;
use opstui::sync::{Msg, Op, Snapshot};
use ratatui::backend::TestBackend;
use ratatui::Terminal;

fn key(app: &mut App, c: KeyCode) {
    app.on_term(Event::Key(KeyEvent::new(c, KeyModifiers::NONE)));
}

fn chars(app: &mut App, s: &str) {
    for c in s.chars() {
        key(app, KeyCode::Char(c));
    }
}

fn agent(id: &str, slug: &str, status: &str, running: i64) -> Agent {
    Agent {
        id: id.into(),
        slug: slug.into(),
        name: slug.to_uppercase(),
        status: status.into(),
        enabled: true,
        runtime: "native".into(),
        running_tasks: running,
        model: Some("model-x".into()),
        ..Default::default()
    }
}

fn task(id: &str, agent: &str, status: &str) -> Task {
    Task {
        id: id.into(),
        agent_id: agent.into(),
        status: status.into(),
        input_message: format!("Do {id}"),
        source: "web".into(),
        created_at: parse_ts("2026-11-16T07:00:00Z"),
        started_at: parse_ts("2026-11-16T07:00:01Z"),
        ..Default::default()
    }
}

/// Signed-in app (no API: nothing is sent anywhere) with realistic data.
fn app() -> (App, tokio::sync::mpsc::Receiver<Msg>) {
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    let mut app = App::new(
        Config {
            server: "https://ops.example.org".into(),
            claude_default_agent: String::new(),
            ..Default::default()
        },
        tx,
    );
    app.on_msg(Msg::LoggedIn(TokenResponse {
        access_token: "t".into(),
        role: "admin".into(),
        username: "alice".into(),
    }));
    let mut tasks: Vec<Task> = (0..12)
        .map(|i| task(&format!("dev-{i:02}"), "a-dev", "running"))
        .collect();
    tasks.push(task("ops-1", "a-ops", "queued"));
    tasks.push(task("old-1", "a-ops", "failed"));
    let snap = Snapshot {
        agents: Some(vec![
            agent("a-dev", "developer", "working", 12),
            agent("a-ops", "ops", "waiting", 0),
            agent("a-err", "data", "error", 0),
            agent("a-idle", "docs", "idle", 0),
        ]),
        tasks: Some(tasks),
        actions: Some(vec![
            Action {
                id: "x1".into(),
                request_code: "R-1".into(),
                agent_id: "a-ops".into(),
                tool: "restart".into(),
                approval_level: 1,
                risk: "low".into(),
                status: "pending".into(),
                ..Default::default()
            },
            Action {
                id: "x3".into(),
                request_code: "R-3".into(),
                agent_id: "a-ops".into(),
                tool: "reboot".into(),
                approval_level: 3,
                risk: "high".into(),
                status: "pending".into(),
                ..Default::default()
            },
        ]),
        dev: Some(DevOverview {
            items: vec![Change {
                id: "p1".into(),
                title: "Add tool".into(),
                status: "ready_for_review".into(),
                stage: "ready_for_review".into(),
                has_patch: true,
                ..Default::default()
            }],
            can_decide: true,
        }),
        providers: Some(vec![]),
        errors: vec![],
    };
    app.on_msg(Msg::Snapshot(Box::new(snap)));
    (app, rx)
}

fn render(app: &mut App, w: u16, h: u16) -> String {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| opstui::ui::draw(f, app)).unwrap();
    let buf = t.backend().buffer().clone();
    let mut s = String::new();
    for y in 0..h {
        for x in 0..w {
            s.push_str(buf[(x, y)].symbol());
        }
        s.push('\n');
    }
    s
}

#[tokio::test]
async fn twelve_tasks_on_one_agent_count_as_one_agent() {
    let (app, _) = app();
    let c = app.counts();
    assert_eq!(c.registered, 4);
    assert_eq!(c.working, 1);
    assert_eq!(c.busy_agents, 1);
    assert_eq!(c.running_tasks, 12);
    assert_eq!(c.waiting, 1);
    assert_eq!(c.errors, 1);
}

#[tokio::test]
async fn every_view_renders_at_every_size() {
    let (mut app, _) = app();
    for (w, h) in [
        (240, 64),
        (160, 45),
        (120, 32),
        (100, 30),
        (80, 24),
        (60, 18),
        (20, 6),
    ] {
        for v in View::ALL {
            app.goto(v);
            let out = render(&mut app, w, h);
            if w >= 80 {
                assert!(out.contains("OPS-CENTER"), "{v:?} {w}x{h}");
            }
        }
    }
    app.goto(View::Dashboard);
    app.on_msg(Msg::Metrics(Some(Resources {
        hosts: 1,
        cpu: Some(32.0),
        ram: Some(58.0),
        cpu_history: vec![10, 20, 32],
    })));
    let big = render(&mut app, 200, 50);
    for want in [
        "Agents (4)",
        "Working",
        "12 tasks",
        "Active task",
        "Activity (live)",
        "Task queue (13)",
        "System events",
        "Approval 1/3",
        "[4] Approvals (3)",
    ] {
        assert!(big.contains(want), "missing {want:?}\n{big}");
    }
    // Real CPU/RAM; no invented GPU number.
    assert!(big.contains("32%") && big.contains("58%"));
    let gpu = big.lines().find(|l| l.contains("GPU")).unwrap();
    assert!(gpu.contains("unavailable") && !gpu.contains('%'), "{gpu}");
}

#[tokio::test]
async fn navigation_keys_switch_views_and_selection_writes_nothing() {
    let (mut app, mut rx) = app();
    for (k, v) in [
        ('2', View::Agents),
        ('3', View::Tasks),
        ('4', View::Approvals),
        ('5', View::Logs),
        ('7', View::History),
        ('8', View::Settings),
        ('1', View::Dashboard),
    ] {
        key(&mut app, KeyCode::Char(k));
        assert_eq!(app.view, v);
    }
    for _ in 0..5 {
        key(&mut app, KeyCode::Down);
        key(&mut app, KeyCode::Tab);
    }
    key(&mut app, KeyCode::Esc);
    assert!(app.modal.is_none());
    assert!(
        rx.try_recv().is_err(),
        "moving around must not send anything"
    );
    key(&mut app, KeyCode::Char('?'));
    assert_eq!(app.modal, Some(Modal::Help));
    key(&mut app, KeyCode::Esc);
    key(&mut app, KeyCode::Char('q'));
    assert!(app.quit);
}

#[tokio::test]
async fn action_approval_needs_confirmation_and_high_risk_needs_typed_word() {
    let (mut app, _) = app();
    key(&mut app, KeyCode::Char('4'));
    key(&mut app, KeyCode::Char('a'));
    assert!(
        matches!(&app.modal, Some(Modal::Confirm { op: Op::ApproveAction { code, .. }, word: None, .. }) if code == "R-1")
    );
    key(&mut app, KeyCode::Char('n'));
    assert!(app.modal.is_none());

    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Char('a'));
    assert!(matches!(
        &app.modal,
        Some(Modal::Confirm {
            word: Some("approve"),
            ..
        })
    ));
    chars(&mut app, "aprove");
    key(&mut app, KeyCode::Enter);
    assert!(
        app.modal.is_some(),
        "a mistyped confirmation must not approve"
    );
    key(&mut app, KeyCode::Esc);
    assert!(app.modal.is_none());
}

#[tokio::test]
async fn patch_approval_is_bound_to_the_reviewed_hash() {
    let (mut app, _) = app();
    key(&mut app, KeyCode::Char('4'));
    key(&mut app, KeyCode::End);
    key(&mut app, KeyCode::Char('a'));
    assert!(
        matches!(app.modal, Some(Modal::Notice { ok: false, .. })),
        "no approval before the diff is loaded"
    );
    key(&mut app, KeyCode::Enter);

    let patch = "diff --git a/x b/x\n+new secret=placeholder\n-old\n";
    let sha = opstui::app::sha256_hex(patch);
    let mk = |sha: &str| ChangeDetail {
        summary: Change {
            id: "p1".into(),
            title: "Add tool".into(),
            stage: "ready_for_review".into(),
            has_patch: true,
            patch_sha256: Some(sha.to_string()),
            ..Default::default()
        },
        ..Default::default()
    };
    // Backend reports a different revision than the patch we hold: refused.
    app.on_msg(Msg::Change(Box::new(mk(&"b".repeat(64)))));
    app.on_msg(Msg::Patch("p1".into(), Ok(patch.into())));
    key(&mut app, KeyCode::Char('a'));
    assert!(
        matches!(app.modal, Some(Modal::Notice { ok: false, .. })),
        "approval needs sha256(shown patch) == stored hash"
    );
    key(&mut app, KeyCode::Enter);
    assert!(!app.patches.contains_key("p1"), "stale diff is dropped");

    app.on_msg(Msg::Change(Box::new(mk(&sha))));
    app.on_msg(Msg::Patch("p1".into(), Ok(patch.into())));
    let out = render(&mut app, 160, 40);
    // The reviewed diff is shown unmasked, exactly as it will be approved.
    assert!(out.contains("+new secret=placeholder") && out.contains("-old"));
    key(&mut app, KeyCode::Char('a'));
    match &app.modal {
        Some(Modal::Confirm {
            op:
                Op::ReviewPatch {
                    decision,
                    sha: Some(s),
                    ..
                },
            word: Some("approve"),
            ..
        }) => {
            assert_eq!(decision, "approve");
            assert_eq!(s, &sha);
        }
        other => panic!("unexpected modal {other:?}"),
    }
    key(&mut app, KeyCode::Esc);
    // Production release is a separate step, only for an approved change.
    key(&mut app, KeyCode::Char('p'));
    assert!(!matches!(app.modal, Some(Modal::Input { .. })));
}

#[tokio::test]
async fn reauth_prompt_appears_when_backend_asks_for_it() {
    let (mut app, _) = app();
    let op = Op::RecordRelease {
        id: "p1".into(),
        title: "t".into(),
        release_ref: "v1".into(),
    };
    app.on_msg(Msg::OpFailed(
        op.clone(),
        opstui::api::ApiError::Forbidden {
            detail: "reauthentication required".into(),
            reauth: true,
        },
    ));
    assert!(matches!(&app.modal, Some(Modal::Password { op: o, .. }) if *o == op));
    chars(&mut app, "secret");
    // Typed characters stay in the field; nothing renders them in clear text.
    let out = render(&mut app, 120, 30);
    assert!(!out.contains("secret") && out.contains("••••••"));
}

#[tokio::test]
async fn typing_in_chat_never_triggers_shortcuts() {
    let (mut app, _) = app();
    key(&mut app, KeyCode::Char('6'));
    key(&mut app, KeyCode::Char('i'));
    assert!(app.chat.typing);
    chars(&mut app, "q1a?/");
    assert!(!app.quit);
    assert_eq!(app.view, View::Chat);
    assert!(app.modal.is_none());
    assert_eq!(app.chat.input, "q1a?/");
    key(&mut app, KeyCode::Esc);
    assert!(!app.chat.typing);
}

#[tokio::test]
async fn search_field_captures_keys_and_filters() {
    let (mut app, _) = app();
    key(&mut app, KeyCode::Char('3'));
    key(&mut app, KeyCode::Char('/'));
    chars(&mut app, "ops-1");
    assert_eq!(
        app.view,
        View::Tasks,
        "digits typed into search must not switch view"
    );
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.task_list().len(), 1);
    key(&mut app, KeyCode::Esc);
    assert_eq!(app.task_list().len(), 14);
}

#[tokio::test]
async fn stream_replay_is_not_logged_twice_and_buffer_is_bounded() {
    let (mut app, _) = app();
    // Same state the agent already has: the stream's replay on (re)connect.
    let replay = AgentEvent {
        agent: "developer".into(),
        status: Some("working".into()),
        ..Default::default()
    };
    app.on_msg(Msg::Event(replay.clone()));
    assert_eq!(app.events.len(), 0, "replayed state is not new activity");
    let changed = AgentEvent {
        activity: Some("Reading worker_ai/x.py".into()),
        ..replay.clone()
    };
    app.on_msg(Msg::Event(changed.clone()));
    app.on_msg(Msg::Event(changed));
    assert_eq!(
        app.events.len(),
        1,
        "a new activity is logged once, its replay is skipped"
    );
    for i in 0..(opstui::app::EVENT_CAP + 50) {
        app.on_msg(Msg::Event(AgentEvent {
            agent: "ops".into(),
            event: Some("tool_started".into()),
            tool: Some(format!("t{i}")),
            ..Default::default()
        }));
    }
    assert_eq!(app.events.len(), opstui::app::EVENT_CAP);
    assert_eq!(
        app.agents.iter().find(|a| a.slug == "ops").unwrap().status,
        "waiting"
    );
}

#[tokio::test]
async fn session_expiry_returns_to_login() {
    let (mut app, _) = app();
    app.on_msg(Msg::SessionExpired("not signed in: session expired".into()));
    assert!(!app.signed_in());
    let out = render(&mut app, 100, 30);
    assert!(out.contains("Sign in") && out.contains("Session ended"));
    // Esc on the login screen quits.
    key(&mut app, KeyCode::Esc);
    assert!(app.quit);
}

#[tokio::test]
async fn dashboard_chat_takes_text_and_defaults_to_coordinator() {
    let (mut app, _) = app();
    let mut agents = app.agents.clone();
    agents.push(agent("a-coord", "coordinator", "idle", 0));
    app.on_msg(Msg::Snapshot(Box::new(Snapshot {
        agents: Some(agents),
        ..Default::default()
    })));
    key(&mut app, KeyCode::Char('c'));
    assert_eq!(
        app.view,
        View::Dashboard,
        "typing happens in the dashboard panel"
    );
    assert!(app.chat.typing);
    assert_eq!(app.chat.agent.as_deref(), Some("coordinator"));
    chars(&mut app, "check disk on web01 q");
    assert!(!app.quit);
    let out = render(&mut app, 200, 50);
    assert!(out.contains("check disk on web01"), "{out}");
    key(&mut app, KeyCode::Enter);
    // Sent (no server in this test) even before history finished loading.
    assert!(app.chat.input.is_empty());
    assert!(app
        .chat
        .key
        .as_deref()
        .is_some_and(|k| k.starts_with("web:coordinator:")));
    key(&mut app, KeyCode::Esc);
    assert!(!app.chat.typing);
}

#[tokio::test]
async fn token_usage_and_budget_are_shown_at_the_bottom() {
    let (mut app, _) = app();
    let out = render(&mut app, 200, 50);
    assert!(out.contains("AI usage") && out.contains("loading"));
    app.on_msg(Msg::Usage(Some(Usage {
        today: Tokens {
            input: 12_300,
            output: 4_560,
            calls: 7,
            cost: Some(0.42),
        },
        week: Tokens {
            input: 2_100_000,
            output: 600_000,
            calls: 300,
            cost: None,
        },
        budget: Some(Budget {
            limit_usd: 50.0,
            billed_usd: 10.0,
            reserved_usd: 4.2,
            warning: false,
            ..Default::default()
        }),
    })));
    let out = render(&mut app, 200, 50);
    let line = out.lines().find(|l| l.contains("AI usage")).unwrap();
    for want in [
        "12.3k in",
        "4.6k out",
        "7 calls",
        "$0.42",
        "2.10M in",
        "cost unknown",
        "$14.20",
        "/ $50.00",
        "28%",
    ] {
        assert!(line.contains(want), "missing {want:?} in {line}");
    }
}

#[tokio::test]
async fn chat_agent_can_be_chosen_by_key_and_click() {
    let (mut app, _) = app();
    render(&mut app, 200, 50);
    key(&mut app, KeyCode::Char('c'));
    assert_eq!(app.chat.agent.as_deref(), Some("developer"));
    key(&mut app, KeyCode::Tab);
    assert!(matches!(app.modal, Some(Modal::AgentPicker { sel: 0 })));
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.chat.agent.as_deref(), Some("ops"));
    assert!(app.chat.typing && app.modal.is_none() && app.view == View::Dashboard);

    // Mouse: click the "to <agent> ▾" header, then the third agent's row.
    key(&mut app, KeyCode::Esc);
    render(&mut app, 200, 50);
    let h = app.hit_chat_header.unwrap();
    let click = |app: &mut App, x: u16, y: u16| {
        app.on_term(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        }))
    };
    click(&mut app, h.x + 5, h.y);
    assert!(matches!(app.modal, Some(Modal::AgentPicker { .. })));
    let out = render(&mut app, 200, 50);
    assert!(out.contains("Talk to which agent?"));
    let r = opstui::ui::picker_rect(app.screen, app.chat_agents().len());
    click(&mut app, r.x + 4, r.y + 1 + 2);
    assert_eq!(app.chat.agent.as_deref(), Some("data"));
    assert!(app.chat.typing);
}

#[tokio::test]
async fn clicking_the_conversation_starts_typing() {
    let (mut app, _) = app();
    app.goto(View::Chat);
    assert!(app.chat.agent.is_some() && !app.chat.typing);
    render(&mut app, 200, 50);
    let (r, _) = *app.hit_panels.iter().find(|(_, f)| *f == 1).unwrap();
    let click = |app: &mut App| {
        app.on_term(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: r.x + 2,
            row: r.bottom() - 2,
            modifiers: KeyModifiers::NONE,
        }))
    };
    // Same agent, no detour through another one.
    click(&mut app);
    assert!(app.chat.typing);
    key(&mut app, KeyCode::Char('h'));
    assert_eq!(app.chat.input, "h");
    key(&mut app, KeyCode::Esc);
    assert!(!app.chat.typing);
    click(&mut app);
    assert!(app.chat.typing);
}

#[tokio::test]
async fn approving_from_the_dashboard_shows_a_clear_result() {
    let (mut app, _) = app();
    // Focus is on the agent list; `a` still acts on the approval panel.
    assert_eq!(app.focus, 0);
    key(&mut app, KeyCode::Char('a'));
    let op = match &app.modal {
        Some(Modal::Confirm { op, .. }) => op.clone(),
        other => panic!("expected confirm, got {other:?}"),
    };
    key(&mut app, KeyCode::Char('y'));
    // The backend answered OK.
    app.on_msg(Msg::OpDone(op, "Approved R-1".into()));
    match &app.modal {
        Some(Modal::Notice {
            ok: true, lines, ..
        }) => {
            assert!(
                lines.iter().any(|l| l.contains("2 more items are waiting")),
                "{lines:?}"
            )
        }
        other => panic!("expected notice, got {other:?}"),
    }
    assert_eq!(
        app.pending_count(),
        2,
        "decided item leaves the list at once"
    );
    let out = render(&mut app, 160, 40);
    assert!(out.contains("Approved") && out.contains("Press any key"));
    key(&mut app, KeyCode::Char('x'));
    assert!(app.modal.is_none());

    // A refusal is just as visible.
    let op = Op::RejectAction {
        id: "x3".into(),
        code: "R-3".into(),
    };
    app.on_msg(Msg::OpFailed(
        op,
        opstui::api::ApiError::Forbidden {
            detail: "requires admin role".into(),
            reauth: false,
        },
    ));
    assert!(
        matches!(&app.modal, Some(Modal::Notice { ok: false, lines, .. }) if lines.iter().any(|l| l.contains("requires admin role")))
    );
    key(&mut app, KeyCode::Enter);

    // Last one decided: says so plainly.
    for (id, op) in [
        (
            "x3",
            Op::RejectAction {
                id: "x3".into(),
                code: "R-3".into(),
            },
        ),
        (
            "p1",
            Op::RejectProposal {
                id: "p1".into(),
                title: "Add tool".into(),
            },
        ),
    ] {
        let _ = id;
        app.on_msg(Msg::OpDone(op, "done".into()));
        key(&mut app, KeyCode::Enter);
    }
    assert_eq!(app.pending_count(), 0);
    key(&mut app, KeyCode::Char('a'));
    assert!(
        matches!(&app.modal, Some(Modal::Notice { ok: false, lines, .. }) if lines[0].contains("Nothing is waiting"))
    );
}

fn fake_claude() -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("opstui-fake-claude-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("claude");
    // Speaks the stream-json host protocol: several messages per process,
    // permission prompts and AskUserQuestion answered on stdin.
    std::fs::write(
        &bin,
        r#"#!/bin/sh
echo '{"type":"system","subtype":"init","model":"fake-model"}'
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) echo '{"type":"control_response","response":{"subtype":"success","request_id":"i"}}' ;;
    *'"type":"user"'*)
      case "$line" in
        *permission*)
          echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch x"},"description":"Create x","permission_suggestions":[]}}'
          IFS= read -r resp
          case "$resp" in *'"behavior":"allow"'*) d=allowed ;; *) d=denied ;; esac
          echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"permission $d\"}]}}" ;;
        *question*)
          echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which color?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]}}}'
          IFS= read -r resp
          case "$resp" in *'"Which color?":"Blue"'*) d=Blue ;; *) d=other ;; esac
          echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"you chose $d\"}]}}" ;;
        *)
          echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}'
          printf '{"type":"assistant","message":{"content":[{"type":"text","text":"args %s"}]}}\n' "$*" ;;
      esac
      echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":7}}' ;;
  esac
done
"#,
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

async fn pump_until(
    app: &mut App,
    rx: &mut tokio::sync::mpsc::Receiver<Msg>,
    done: impl Fn(&App) -> bool,
) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done(app) {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(m)) => app.on_msg(m),
            _ => panic!("timed out"),
        }
    }
}

fn last_reply(app: &App) -> String {
    app.claude[0]
        .turns
        .last()
        .and_then(|t| t.response_message.clone())
        .unwrap_or_default()
}

fn say(app: &mut App, text: &str) {
    let n = app.claude[0].turns.len();
    if !app.chat.typing {
        key(app, KeyCode::Char('c'));
    }
    chars(app, text);
    key(app, KeyCode::Enter);
    assert_eq!(app.claude[0].turns.len(), n + 1);
}

#[tokio::test]
async fn claude_agent_asks_permission_and_questions_in_the_tui() {
    let (mut app, mut rx) = app();
    let bin = fake_claude();
    app.cfg.claude_bin = bin.display().to_string();
    app.cfg.claude_dir = bin.parent().unwrap().display().to_string();
    render(&mut app, 200, 50);
    let registered = app.counts().registered;

    // Right-click → New Claude agent.
    app.on_term(Event::Mouse(crossterm::event::MouseEvent {
        kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Right),
        column: 100,
        row: 20,
        modifiers: KeyModifiers::NONE,
    }));
    assert!(
        matches!(&app.modal, Some(Modal::Menu { items, .. }) if items[0].0.contains("New Claude agent"))
    );
    assert!(render(&mut app, 200, 50).contains("New Claude agent"));
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.counts().registered, registered + 1);
    assert_eq!(app.chat.agent.as_deref(), Some("claude-1"));
    assert!(app.chat.typing && app.view == View::Dashboard);

    // 1. A plain task; the process gets the host-prompt flags.
    say(&mut app, "list files");
    assert_eq!(app.counts().working, 2, "developer + Claude 1");
    pump_until(&mut app, &mut rx, |a| !a.claude[0].busy).await;
    let reply = last_reply(&app);
    for want in [
        "--session-id",
        "--permission-mode auto",
        "--permission-prompts host",
        "--permission-prompt-tool stdio",
    ] {
        assert!(reply.contains(want), "{want}: {reply}");
    }
    assert_eq!(app.claude[0].turns[0].status, "completed");
    assert!(
        app.tasks.iter().any(|x| x.id == app.claude[0].turns[0].id),
        "turn shows in the task list"
    );
    assert!(app
        .events
        .iter()
        .any(|l| l.ev.agent == "claude-1" && l.ev.tool.as_deref() == Some("Bash")));
    let out = render(&mut app, 200, 50);
    assert!(
        out.contains("Claude 1") && out.contains("Claude (local)") && out.contains("$0.01"),
        "{out}"
    );

    // 2. Permission prompt → approvals list → `a` allows it, same process.
    say(&mut app, "needs permission");
    pump_until(&mut app, &mut rx, |a| !a.claude_prompts.is_empty()).await;
    assert_eq!(
        app.pending_count(),
        4,
        "the prompt joins the three backend approvals"
    );
    key(&mut app, KeyCode::Esc);
    let out = render(&mut app, 200, 50);
    assert!(
        out.contains("touch x") && out.contains("permission"),
        "{out}"
    );
    // The new request does not steal the selection; pick it explicitly.
    key(&mut app, KeyCode::Char('4'));
    key(&mut app, KeyCode::Home);
    render(&mut app, 200, 50);
    key(&mut app, KeyCode::Char('a'));
    key(&mut app, KeyCode::Char('1'));
    assert!(
        app.claude_prompts.is_empty() && app.modal.is_none(),
        "one key, like the CLI prompt"
    );
    pump_until(&mut app, &mut rx, |a| !a.claude[0].busy).await;
    assert_eq!(last_reply(&app), "permission allowed");

    // 3. AskUserQuestion → dialog → answer goes back as `answers`.
    say(&mut app, "question please");
    key(&mut app, KeyCode::Esc);
    pump_until(&mut app, &mut rx, |a| !a.claude_prompts.is_empty()).await;
    assert!(
        matches!(app.modal, Some(Modal::Question { .. })),
        "question opens by itself when not typing"
    );
    assert!(render(&mut app, 200, 50).contains("Which color?"));
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Enter);
    pump_until(&mut app, &mut rx, |a| !a.claude[0].busy).await;
    assert_eq!(last_reply(&app), "you chose Blue");

    // 4. Denying a request.
    say(&mut app, "permission again");
    key(&mut app, KeyCode::Esc);
    pump_until(&mut app, &mut rx, |a| !a.claude_prompts.is_empty()).await;
    key(&mut app, KeyCode::Char('4'));
    key(&mut app, KeyCode::Home);
    key(&mut app, KeyCode::Char('r'));
    key(&mut app, KeyCode::Char('1'));
    pump_until(&mut app, &mut rx, |a| !a.claude[0].busy).await;
    assert_eq!(last_reply(&app), "permission denied");

    // 5. After the process ends, the next message resumes the session.
    app.claude[0].cancel.notify_one();
    pump_until(&mut app, &mut rx, |a| a.claude[0].input.is_none()).await;
    say(&mut app, "hello again");
    pump_until(&mut app, &mut rx, |a| !a.claude[0].busy).await;
    let sid = app.claude[0].session_id.clone();
    assert!(
        last_reply(&app).contains(&format!("--resume {sid}")),
        "{}",
        last_reply(&app)
    );

    // C starts another agent; the menu closes the first.
    key(&mut app, KeyCode::Esc);
    app.on_term(Event::Key(KeyEvent::new(
        KeyCode::Char('C'),
        KeyModifiers::SHIFT,
    )));
    assert_eq!(app.claude.len(), 2, "C starts another one");
    key(&mut app, KeyCode::Esc);
    app.sel_agent = app
        .agent_rows()
        .iter()
        .position(|r| matches!(r, AgentRow::Agent(i) if app.agents[*i].slug == "claude-1"))
        .unwrap();
    app.on_term(Event::Mouse(crossterm::event::MouseEvent {
        kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Right),
        column: 1,
        row: 1,
        modifiers: KeyModifiers::NONE,
    }));
    let Some(Modal::Menu { items, .. }) = &app.modal else {
        panic!("menu")
    };
    let close = items
        .iter()
        .position(|(l, _)| l.contains("Close Claude 1"))
        .expect("close item");
    for _ in 0..close {
        key(&mut app, KeyCode::Down);
    }
    key(&mut app, KeyCode::Enter);
    assert!(app.claude.iter().all(|s| s.slug != "claude-1"));
    assert!(app.agents.iter().all(|a| a.slug != "claude-1"));
    assert!(app.shutdown() || app.claude.iter().all(|s| s.input.is_none()));
    let _ = std::fs::remove_dir_all(bin.parent().unwrap());
}

#[tokio::test]
async fn a_new_claude_prompt_never_shifts_what_a_approves() {
    let (mut app, _) = app();
    render(&mut app, 200, 50);
    // On screen: the first backend action (R-1).
    let shown = app.selected_approval().unwrap();
    assert_eq!(app.approval_id(shown), "action:x1");
    // A Claude prompt arrives at the top of the list between frame and key.
    app.claude.push(opstui::claude::Session::new(9));
    app.on_msg(Msg::Claude(
        "claude-9".into(),
        opstui::claude::Event::Permission(opstui::claude::Prompt {
            request_id: "late".into(),
            tool: "Bash".into(),
            input: serde_json::json!({"command": "rm -rf /tmp/x"}),
            description: None,
            suggestions: serde_json::json!([]),
        }),
    ));
    assert_eq!(app.claude_prompts.len(), 1);
    key(&mut app, KeyCode::Esc);
    key(&mut app, KeyCode::Char('a'));
    // Still the action on screen, never the new Claude request.
    assert!(
        matches!(&app.modal, Some(Modal::Confirm { op: Op::ApproveAction { code, .. }, .. }) if code == "R-1"),
        "{:?}",
        app.modal
    );
    assert_eq!(
        app.claude_prompts.len(),
        1,
        "the Claude request is still waiting"
    );
}

#[tokio::test]
async fn ops_floor_shows_rooms_status_and_live_handover() {
    let (mut app, mut rx) = app();
    // A Coordinator and a Linux agent on their fixed desks, next to the
    // unplanned ones (ops, data, docs) in the "Other" room.
    let mut snap_agents = app.agents.clone();
    snap_agents.push(agent("a-coord", "coordinator", "working", 1));
    snap_agents.push(agent("a-linux", "linux", "working", 1));
    app.on_msg(Msg::Snapshot(Box::new(Snapshot {
        agents: Some(snap_agents),
        tasks: None,
        actions: None,
        dev: None,
        providers: None,
        errors: vec![],
    })));
    app.on_msg(Msg::Event(AgentEvent {
        agent: "coordinator".into(),
        status: Some("working".into()),
        activity: Some("Checking disk usage".into()),
        event: Some("delegated".into()),
        peer: Some("linux".into()),
        ..Default::default()
    }));
    key(&mut app, KeyCode::Char('9'));
    assert_eq!(app.view, View::Floor);
    let out = render(&mut app, 200, 50);
    for want in [
        "Ops Floor",
        "Core",
        "Infrastructure",
        "Other",
        "COORDINATOR",
        "Delegating",
        "! Needs appro",
        "✕ Error",
        "3 need you",
    ] {
        assert!(out.contains(want), "missing {want:?}\n{out}");
    }
    assert!(out.contains('●'), "handover packet\n{out}");
    // The web page's figures: on the cards and as a portrait in the details.
    assert!(out.contains('▀') && out.contains('▄'), "figures\n{out}");
    // And the role icon beside each name, as on the web cards.
    assert!(out.contains("⎇ COORDINATOR"), "role icon\n{out}");
    // Every card has its figure, also when the cards are low or narrow.
    for (w, h) in [(200, 50), (160, 40), (140, 34), (120, 30)] {
        let out = render(&mut app, w, h);
        let rows: Vec<Vec<char>> = out.lines().map(|l| l.chars().collect()).collect();
        for (r, slug) in &app.hit_floor {
            let has = (r.y..r.bottom()).any(|y| {
                let row = &rows[y as usize];
                row[r.x as usize..(r.right() as usize).min(row.len())]
                    .iter()
                    .any(|c| matches!(c, '▀' | '▄'))
            });
            assert!(has, "{slug} at {w}x{h} has no figure\n{out}");
        }
    }
    // Small terminals get the same floor as a list, room by room.
    let small = render(&mut app, 90, 24);
    assert!(
        small.contains("Infrastructure") && small.contains("Delegating") && small.contains('⎇'),
        "{small}"
    );

    // Arrows walk the plan; selecting writes nothing.
    app.floor_sel = Some("linux".into());
    key(&mut app, KeyCode::Down);
    assert_eq!(app.floor_sel.as_deref(), Some("coordinator"));
    key(&mut app, KeyCode::Right);
    assert_eq!(app.floor_sel.as_deref(), Some("developer"));
    assert!(rx.try_recv().is_err());

    // The agent waiting for approval opens its own request in Approvals.
    app.floor_sel = Some("ops".into());
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.view, View::Approvals);
    let id = app.selected_approval().map(|r| app.approval_id(r));
    assert_eq!(id.as_deref(), Some("action:x1"));

    // A click on a card selects it.
    key(&mut app, KeyCode::Char('9'));
    render(&mut app, 200, 50);
    let (r, slug) = app
        .hit_floor
        .iter()
        .find(|(_, s)| s == "linux")
        .cloned()
        .unwrap();
    app.on_term(Event::Mouse(crossterm::event::MouseEvent {
        kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
        column: r.x + 1,
        row: r.y + 1,
        modifiers: KeyModifiers::NONE,
    }));
    assert_eq!(app.floor_sel.as_deref(), Some(slug.as_str()));
}

#[test]
fn default_claude_agent_is_there_from_start() {
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    let app = App::new(Config::default(), tx);
    let s = app
        .claude_session("claude-external")
        .expect("default agent");
    assert_eq!(s.name, "Claude-external");
    assert!(s.input.is_none(), "no process before the first message");
}

#[tokio::test]
async fn agents_are_grouped_by_metadata_and_categories_open_and_close() {
    let (mut app, _rx) = app();
    let mut agents = app.agents.clone();
    // Name says nothing; metadata decides.
    let mut ext = agent("a-ext", "ops-helper", "working", 1);
    ext.runtime = "external".into();
    let mut mine = agent("a-me", "nova", "idle", 0);
    mine.personal = true;
    let mut odd = agent("a-odd", "future", "idle", 0);
    odd.runtime = String::new();
    agents.extend([ext, mine, odd]);
    app.on_msg(Msg::Snapshot(Box::new(Snapshot {
        agents: Some(agents),
        ..Default::default()
    })));
    let group =
        |app: &App, slug: &str| AgentGroup::of(app.agents.iter().find(|a| a.slug == slug).unwrap());
    assert_eq!(group(&app, "developer"), AgentGroup::Ops);
    assert_eq!(group(&app, "future"), AgentGroup::Ops, "no runtime: OPS");
    assert_eq!(group(&app, "ops-helper"), AgentGroup::External);
    let local = Agent {
        runtime: "claude-local".into(),
        ..Default::default()
    };
    assert_eq!(AgentGroup::of(&local), AgentGroup::External);
    assert_eq!(group(&app, "nova"), AgentGroup::Personal);

    let headers: Vec<(AgentGroup, usize, usize)> = app
        .agent_rows()
        .iter()
        .filter_map(|r| match *r {
            AgentRow::Group {
                group,
                total,
                active,
                ..
            } => Some((group, total, active)),
            _ => None,
        })
        .collect();
    let ops = app
        .agents
        .iter()
        .filter(|a| AgentGroup::of(a) == AgentGroup::Ops)
        .count();
    let ext = app.agents.len() - ops - 1;
    assert_eq!(
        headers,
        vec![
            (AgentGroup::Ops, ops, 1),
            (AgentGroup::External, ext, 1),
            (AgentGroup::Personal, 1, 0)
        ]
    );

    key(&mut app, KeyCode::Char('2'));
    let out = render(&mut app, 140, 30);
    assert!(
        out.contains("▼ OPS Agents (5)") && out.contains("▼ Personal Agents (1)"),
        "{out}"
    );
    assert!(out.contains("1 active"), "{out}");
    assert_eq!(
        app.selected_agent().unwrap().slug,
        "developer",
        "starts on an agent"
    );

    // ← on an agent closes its category and selects the header.
    key(&mut app, KeyCode::Left);
    assert_eq!(app.sel_agent, 0);
    assert!(app.selected_agent().is_none());
    assert!(!app
        .agent_rows()
        .iter()
        .any(|r| matches!(r, AgentRow::Agent(i) if app.agents[*i].slug == "developer")));
    assert!(render(&mut app, 140, 30).contains("▶ OPS Agents"));
    // Enter on the header is not the details dialog; it opens it again.
    key(&mut app, KeyCode::Enter);
    assert!(app.modal.is_none());
    assert!(app.agent_closed.is_empty());
    key(&mut app, KeyCode::Left);
    key(&mut app, KeyCode::Right);
    assert!(app.agent_closed.is_empty());

    // Moving into the personal group selects Nova; closing it is kept across views.
    key(&mut app, KeyCode::End);
    assert_eq!(app.selected_agent().unwrap().slug, "nova");
    key(&mut app, KeyCode::Enter);
    assert!(
        matches!(app.modal, Some(Modal::Text { .. })),
        "Enter on an agent shows details"
    );
    key(&mut app, KeyCode::Esc);
    key(&mut app, KeyCode::Left);
    key(&mut app, KeyCode::Char('3'));
    key(&mut app, KeyCode::Char('2'));
    assert!(app.agent_closed.contains(&AgentGroup::Personal));
    assert!(render(&mut app, 140, 30).contains("▶ Personal Agents"));

    // A search still finds agents in a closed category.
    key(&mut app, KeyCode::Char('/'));
    chars(&mut app, "nova");
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.selected_agent().map(|a| a.slug.as_str()), Some("nova"));

    // Narrow terminals still render the headers without panicking.
    key(&mut app, KeyCode::Esc);
    for (w, h) in [(40, 12), (60, 16), (80, 24)] {
        assert!(render(&mut app, w, h).contains("Agents"));
    }
    // The dashboard panel shows the same groups, with Personal still closed.
    key(&mut app, KeyCode::Char('1'));
    let dash = render(&mut app, 100, 30);
    assert!(
        dash.contains("▼ OPS Agents (5)") && dash.contains("▶ Personal Agents (1)"),
        "{dash}"
    );
}

#[tokio::test]
async fn chat_agent_list_is_grouped_like_the_agents_view() {
    let (mut app, _rx) = app();
    let mut agents = app.agents.clone();
    let mut mine = agent("a-me", "nova", "idle", 0);
    mine.personal = true;
    let mut ext = agent("a-ext", "ops-helper", "idle", 0);
    ext.runtime = "external".into();
    agents.extend([mine, ext]);
    app.on_msg(Msg::Snapshot(Box::new(Snapshot {
        agents: Some(agents),
        ..Default::default()
    })));
    key(&mut app, KeyCode::Char('6'));
    assert_eq!(app.view, View::Chat);
    let out = render(&mut app, 140, 30);
    assert!(
        out.contains("▼ OPS Agents") && out.contains("▼ Personal Agents (1)"),
        "{out}"
    );
    // Only agents that take messages are listed: no external runtime.
    assert!(!out.contains("OPS-HELPER") && !out.contains("External Agents"));
    // The default chat partner is selected, not a header.
    let current = app.chat.agent.clone().unwrap();
    assert!(matches!(
        app.chat_rows()[app.chat.sel],
        AgentRow::Agent(i) if app.agents[i].slug == current
    ));

    // ← closes its category and selects the header; Enter opens it again.
    key(&mut app, KeyCode::Left);
    assert!(app.chat_closed.contains(&AgentGroup::Ops));
    assert!(matches!(
        app.chat_rows()[app.chat.sel],
        AgentRow::Group {
            group: AgentGroup::Ops,
            open: false,
            ..
        }
    ));
    assert!(render(&mut app, 140, 30).contains("▶ OPS Agents"));
    key(&mut app, KeyCode::Enter);
    assert!(app.chat_closed.is_empty());
    assert_eq!(app.chat.agent.as_deref(), Some(current.as_str()));
    assert!(!app.chat.typing, "a header does not start a chat");

    // The last row is the personal agent; Enter talks to it.
    key(&mut app, KeyCode::End);
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.chat.agent.as_deref(), Some("nova"));
    assert!(app.chat.typing && app.focus == 1);

    // Clicking a header toggles it; clicking an agent talks to it.
    key(&mut app, KeyCode::Esc);
    render(&mut app, 140, 30);
    let (r, _) = *app.hit_panels.iter().find(|(_, f)| *f == 0).unwrap();
    let click = |app: &mut App, row: u16| {
        app.on_term(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: r.x + 3,
            row: r.y + 1 + row,
            modifiers: KeyModifiers::NONE,
        }))
    };
    click(&mut app, 0);
    assert!(app.chat_closed.contains(&AgentGroup::Ops));
    // Rows now: OPS header, Personal header, nova.
    click(&mut app, 0);
    assert!(app.chat_closed.is_empty());
    click(&mut app, 1);
    let first = match app.chat_rows()[1] {
        AgentRow::Agent(i) => app.agents[i].slug.clone(),
        _ => panic!("row 1 is an agent"),
    };
    assert_eq!(app.chat.agent.as_deref(), Some(first.as_str()));
}
