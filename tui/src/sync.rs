//! Background work: REST snapshots, the live event stream and write
//! operations. Nothing here touches the terminal; results go to the UI loop
//! as `Msg` values, so the event loop never waits on the network.

use crate::api::{enc, Api, ApiError};
use crate::model::*;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc::Sender, Notify};

#[derive(Debug, Clone, PartialEq)]
pub enum Conn {
    Connecting,
    Live,
    /// Lost; retrying in `n` seconds. Events from the gap are not replayed by
    /// the backend, so the UI re-reads state over REST after reconnecting.
    Retrying(u64, String),
}

#[derive(Debug, Default)]
pub struct Snapshot {
    pub agents: Option<Vec<Agent>>,
    pub tasks: Option<Vec<Task>>,
    pub actions: Option<Vec<Action>>,
    pub dev: Option<DevOverview>,
    pub providers: Option<Vec<Provider>>,
    pub errors: Vec<String>,
}

#[derive(Debug)]
pub enum Msg {
    LoggedIn(TokenResponse),
    LoginFailed(String),
    SessionExpired(String),
    Snapshot(Box<Snapshot>),
    Metrics(Option<Resources>),
    Usage(Option<Usage>),
    /// Event from local Claude agent `slug`.
    Claude(String, crate::claude::Event),
    Health(Option<Health>),
    Event(AgentEvent),
    Conn(Conn),
    Board(String, Board),
    Change(Box<ChangeDetail>),
    Patch(String, Result<String, String>),
    History(HistoryPage),
    Audit(Result<Vec<AuditEntry>, String>),
    Traffic(Result<(Box<TrafficOverview>, TrafficEvents), String>),
    ChatHistory(String, String, Vec<Task>),
    ChatTask(Task),
    OpDone(Op, String),
    OpFailed(Op, ApiError),
    Reauthed(Box<Op>),
    Error(String),
}

/// Every write the TUI can make. Each maps to exactly one backend endpoint
/// that already enforces roles, ownership and the approval rules.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    ApproveAction {
        id: String,
        code: String,
    },
    RejectAction {
        id: String,
        code: String,
    },
    /// Proposal → start development (admin). Deploys nothing.
    ApproveDevelopment {
        id: String,
        title: String,
    },
    RejectProposal {
        id: String,
        title: String,
    },
    /// Review a finished patch; approve names the exact SHA-256 reviewed.
    ReviewPatch {
        id: String,
        title: String,
        decision: String,
        sha: Option<String>,
        comment: String,
    },
    /// Bookkeeping that a reviewed release shipped this change to production.
    RecordRelease {
        id: String,
        title: String,
        release_ref: String,
    },
    CancelTask {
        id: String,
    },
    ResumeTask {
        id: String,
    },
    Ask {
        agent: String,
        message: String,
        conversation_key: String,
    },
}

impl Op {
    pub fn describe(&self) -> String {
        match self {
            Op::ApproveAction { code, .. } => format!("Approve action {code}"),
            Op::RejectAction { code, .. } => format!("Reject action {code}"),
            Op::ApproveDevelopment { title, .. } => format!("Approve development of \"{title}\""),
            Op::RejectProposal { title, .. } => format!("Reject proposal \"{title}\""),
            Op::ReviewPatch {
                title,
                decision,
                sha,
                ..
            } => match decision.as_str() {
                "approve" => format!(
                    "Approve patch of \"{title}\" for production (sha256 {})",
                    sha.as_deref().map(|s| prefix(s, 12)).unwrap_or("?")
                ),
                "request_changes" => format!("Request changes to \"{title}\""),
                _ => format!("Reject change \"{title}\""),
            },
            Op::RecordRelease {
                title, release_ref, ..
            } => format!("Record production release of \"{title}\" ({release_ref})"),
            Op::CancelTask { id } => format!("Stop task {}", short(id)),
            Op::ResumeTask { id } => format!("Resume task {}", short(id)),
            Op::Ask { agent, .. } => format!("Send message to {agent}"),
        }
    }
}

/// First `n` bytes of an ASCII id/hash; never panics on other input.
pub fn prefix(id: &str, n: usize) -> &str {
    id.get(..n).unwrap_or(id)
}

impl Op {
    /// The approval item this decides, and a past-tense label for it.
    pub fn decision(&self) -> Option<(&str, &'static str)> {
        match self {
            Op::ApproveAction { id, .. } => Some((id, "Approved")),
            Op::RejectAction { id, .. } | Op::RejectProposal { id, .. } => Some((id, "Rejected")),
            Op::ApproveDevelopment { id, .. } => Some((id, "Development approved")),
            Op::ReviewPatch { id, decision, .. } => Some((
                id,
                match decision.as_str() {
                    "approve" => "Approved for production",
                    "request_changes" => "Changes requested",
                    _ => "Rejected",
                },
            )),
            Op::RecordRelease { id, .. } => Some((id, "Release recorded")),
            _ => None,
        }
    }
}

pub fn short(id: &str) -> &str {
    prefix(id, 8)
}

async fn put(tx: &Sender<Msg>, m: Msg) {
    let _ = tx.send(m).await;
}

fn on_auth_error(e: &ApiError) -> Option<Msg> {
    matches!(e, ApiError::Unauthorized(_)).then(|| Msg::SessionExpired(e.to_string()))
}

pub async fn snapshot(api: &Api) -> Result<Snapshot, ApiError> {
    let (agents, tasks, actions, dev, providers) = tokio::join!(
        api.get::<Vec<Agent>>("/ai/agents"),
        api.get::<Vec<Task>>("/ai/tasks?limit=300"),
        api.get::<Vec<Action>>("/ai/actions?status=pending&limit=200"),
        api.get::<DevOverview>("/ai/developer/overview"),
        api.get::<Vec<Provider>>("/ai/providers"),
    );
    let mut s = Snapshot::default();
    macro_rules! take {
        ($r:expr, $field:ident, $what:literal) => {
            match $r {
                Ok(v) => s.$field = Some(v),
                Err(e @ ApiError::Unauthorized(_)) => return Err(e),
                // Viewers may lack access to some lists; that is shown, not hidden.
                Err(e) => s.errors.push(format!("{}: {e}", $what)),
            }
        };
    }
    take!(agents, agents, "agents");
    take!(tasks, tasks, "tasks");
    take!(actions, actions, "approvals");
    take!(dev, dev, "developer changes");
    take!(providers, providers, "providers");
    Ok(s)
}

/// REST loop: a snapshot every `every` seconds or when poked; metrics and
/// health every 30 s.
pub async fn poll(
    api: Arc<Api>,
    tx: Sender<Msg>,
    poke: Arc<Notify>,
    every: u64,
    metrics_host: String,
) {
    let mut n: u64 = 0;
    loop {
        match snapshot(&api).await {
            Ok(s) => put(&tx, Msg::Snapshot(Box::new(s))).await,
            Err(e) => {
                if let Some(m) = on_auth_error(&e) {
                    put(&tx, m).await;
                    return;
                }
                put(&tx, Msg::Error(format!("refresh failed: {e}"))).await;
            }
        }
        if n.is_multiple_of((30 / every.max(1)).max(1)) {
            let (m, h) = tokio::join!(
                api.get::<HostMetrics>("/metrics/hosts?minutes=15"),
                api.get::<Health>("/health"),
            );
            // `available` is false if any of the backend's queries failed;
            // use whatever CPU/RAM series did arrive.
            let res = m
                .ok()
                .map(|m| m.summarize(&metrics_host))
                .filter(|r| r.cpu.is_some() || r.ram.is_some());
            put(&tx, Msg::Metrics(res)).await;
            put(&tx, Msg::Usage(usage(&api).await)).await;
            put(&tx, Msg::Health(h.ok())).await;
        }
        n += 1;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(every)) => {}
            _ = poke.notified() => {}
        }
        if tx.is_closed() {
            return;
        }
    }
}

/// Token use today and over 7 days, plus the weekly budget. None if the
/// usage endpoint is unavailable; the budget alone may be missing.
pub async fn usage(api: &Api) -> Option<Usage> {
    let (u, b) = tokio::join!(
        api.get::<UsageResponse>("/ai/usage?days=7"),
        api.get::<Budget>("/ai/budget")
    );
    let today = chrono::Utc::now().date_naive().to_string();
    let (today, week) = u.ok()?.totals(&today);
    Some(Usage {
        today,
        week,
        budget: b.ok(),
    })
}

/// Splits an SSE byte stream into `data:` payloads.
#[derive(Default)]
pub struct SseParser {
    buf: String,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(d) = line.strip_prefix("data:") {
                self.data.push(d.strip_prefix(' ').unwrap_or(d).to_string());
            }
            // Comments (": keepalive"), id: and event: lines carry nothing we use.
        }
        // A single runaway line must not grow without bound.
        if self.buf.len() > 1 << 20 {
            self.buf.clear();
        }
        out
    }
}

/// Live stream with reconnection (1, 2, 4 … 30 s backoff).
pub async fn stream(api: Arc<Api>, tx: Sender<Msg>, poke: Arc<Notify>) {
    let mut backoff = 1u64;
    let mut auth_retries = 0;
    loop {
        put(&tx, Msg::Conn(Conn::Connecting)).await;
        let reason = match api.open_stream().await {
            Ok(resp) => {
                put(&tx, Msg::Conn(Conn::Live)).await;
                backoff = 1;
                auth_retries = 0;
                poke.notify_one(); // re-read state missed while disconnected
                let mut body = resp.bytes_stream();
                let mut parser = SseParser::default();
                let mut why = "stream ended".to_string();
                while let Some(chunk) = body.next().await {
                    match chunk {
                        Ok(bytes) => {
                            for data in parser.push(&bytes) {
                                match serde_json::from_str::<AgentEvent>(&data) {
                                    Ok(ev)
                                        if ev.event_type.as_deref() == Some("stream_timeout") =>
                                    {
                                        why = "server closed idle stream".into();
                                    }
                                    Ok(ev) => put(&tx, Msg::Event(ev)).await,
                                    Err(e) => tracing::warn!("unparsable stream event: {e}"),
                                }
                            }
                        }
                        Err(e) => {
                            why = crate::mask::mask(&e.without_url().to_string());
                            break;
                        }
                    }
                }
                why
            }
            Err(e @ ApiError::Unauthorized(_)) => {
                // Token expired: refresh once, else the session is over.
                auth_retries += 1;
                match api.refresh().await {
                    Ok(_) if auth_retries < 3 => continue,
                    _ => {
                        put(&tx, Msg::SessionExpired(e.to_string())).await;
                        return;
                    }
                }
            }
            Err(e) => e.to_string(),
        };
        if tx.is_closed() {
            return;
        }
        tracing::info!("event stream disconnected: {reason}");
        put(&tx, Msg::Conn(Conn::Retrying(backoff, reason))).await;
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

/// Access tokens last 15 minutes; renew ahead of time so the stream's
/// reconnect always has a valid one.
pub async fn keep_session(api: Arc<Api>, tx: Sender<Msg>) {
    loop {
        tokio::time::sleep(Duration::from_secs(10 * 60)).await;
        if tx.is_closed() {
            return;
        }
        if let Err(e) = api.refresh().await {
            if let Some(m) = on_auth_error(&e) {
                put(&tx, m).await;
                return;
            }
        }
    }
}

pub async fn run_op(api: &Api, op: &Op) -> Result<(String, Option<Task>), ApiError> {
    let done = |s: String| Ok((s, None));
    match op {
        Op::ApproveAction { id, code } => {
            api.post::<Value>(&format!("/ai/actions/{id}/approve"), &json!({}))
                .await?;
            done(format!("Approved {code}"))
        }
        Op::RejectAction { id, code } => {
            api.post::<Value>(&format!("/ai/actions/{id}/reject"), &json!({}))
                .await?;
            done(format!("Rejected {code}"))
        }
        Op::ApproveDevelopment { id, .. } => {
            api.post::<Value>(&format!("/ai/proposals/{id}/approve"), &json!({}))
                .await?;
            done("Development approved; the developer agent was started".into())
        }
        Op::RejectProposal { id, .. } => {
            api.post::<Value>(&format!("/ai/proposals/{id}/reject"), &json!({}))
                .await?;
            done("Proposal rejected".into())
        }
        Op::ReviewPatch {
            id,
            decision,
            sha,
            comment,
            ..
        } => {
            let r: Value = api
                .post(
                    &format!("/ai/proposals/{id}/review"),
                    &json!({"decision": decision, "comment": comment, "patch_sha256": sha}),
                )
                .await?;
            done(format!(
                "Change is now {}",
                r.get("stage").and_then(Value::as_str).unwrap_or("updated")
            ))
        }
        Op::RecordRelease {
            id, release_ref, ..
        } => {
            api.post::<Value>(
                &format!("/ai/proposals/{id}/deployed"),
                &json!({"release_ref": release_ref, "note": "Recorded from opstui"}),
            )
            .await?;
            done("Production release recorded".into())
        }
        Op::CancelTask { id } => {
            api.post::<Value>(&format!("/ai/tasks/{id}/cancel"), &json!({}))
                .await?;
            done(format!(
                "Stop requested for task {} (the current step finishes first)",
                short(id)
            ))
        }
        Op::ResumeTask { id } => {
            let r: Value = api
                .post(&format!("/ai/tasks/{id}/resume"), &json!({}))
                .await?;
            done(format!(
                "Resumed as task {}",
                r.get("task_id")
                    .and_then(Value::as_str)
                    .map(short)
                    .unwrap_or("?")
            ))
        }
        Op::Ask {
            agent,
            message,
            conversation_key,
        } => {
            let t: Task = api
                .post("/ai/ask", &json!({"agent": agent, "message": message, "conversation_key": conversation_key}))
                .await?;
            Ok((format!("Sent to {agent} as task {}", short(&t.id)), Some(t)))
        }
    }
}

/// Runs a write and reports back; a chat task is then followed until it ends.
pub async fn execute(api: Arc<Api>, tx: Sender<Msg>, poke: Arc<Notify>, op: Op) {
    tracing::info!(op = %op.describe(), "write operation");
    match run_op(&api, &op).await {
        Ok((msg, task)) => {
            put(&tx, Msg::OpDone(op.clone(), msg)).await;
            poke.notify_one();
            if let Some(t) = task {
                put(&tx, Msg::ChatTask(t.clone())).await;
                follow_task(api, tx, t.id).await;
            }
        }
        Err(e) => {
            tracing::warn!(op = %op.describe(), error = %e, "write operation failed");
            put(&tx, Msg::OpFailed(op, e)).await;
        }
    }
}

pub async fn reauth_then(api: Arc<Api>, tx: Sender<Msg>, password: String, op: Op) {
    match api.reauth(&password).await {
        Ok(_) => put(&tx, Msg::Reauthed(Box::new(op))).await,
        Err(e) => put(&tx, Msg::OpFailed(op, e)).await,
    }
}

async fn follow_task(api: Arc<Api>, tx: Sender<Msg>, id: String) {
    for _ in 0..900 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if tx.is_closed() {
            return;
        }
        match api.get::<Task>(&format!("/ai/tasks/{id}")).await {
            Ok(t) => {
                let open = t.is_open();
                put(&tx, Msg::ChatTask(t)).await;
                if !open {
                    return;
                }
            }
            Err(e) => {
                put(&tx, Msg::Error(format!("chat: {e}"))).await;
                return;
            }
        }
    }
}

pub async fn load_board(api: Arc<Api>, tx: Sender<Msg>, task_id: String) {
    match api
        .get::<Board>(&format!("/ai/tasks/{task_id}/board"))
        .await
    {
        Ok(b) => put(&tx, Msg::Board(task_id, b)).await,
        Err(e) => put(&tx, Msg::Error(format!("task board: {e}"))).await,
    }
}

pub async fn load_change(api: Arc<Api>, tx: Sender<Msg>, id: String, with_patch: bool) {
    match api
        .get::<ChangeDetail>(&format!("/ai/developer/changes/{id}"))
        .await
    {
        Ok(d) => {
            let has_patch = d.summary.has_patch;
            put(&tx, Msg::Change(Box::new(d))).await;
            if with_patch && has_patch {
                let p = api
                    .get_text(&format!("/ai/proposals/{id}/patch"))
                    .await
                    .map_err(|e| e.to_string());
                put(&tx, Msg::Patch(id, p)).await;
            }
        }
        Err(e) => put(&tx, Msg::Error(format!("change detail: {e}"))).await,
    }
}

pub async fn load_history(api: Arc<Api>, tx: Sender<Msg>, q: String) {
    match api
        .get::<HistoryPage>(&format!("/ai/history?limit=100&q={}", enc(&q)))
        .await
    {
        Ok(p) => put(&tx, Msg::History(p)).await,
        Err(e) => put(&tx, Msg::Error(format!("history: {e}"))).await,
    }
}

pub async fn load_audit(api: Arc<Api>, tx: Sender<Msg>) {
    let r = api
        .get::<Vec<AuditEntry>>("/audit?limit=500")
        .await
        .map_err(|e| e.to_string());
    put(&tx, Msg::Audit(r)).await;
}

pub async fn load_traffic(api: Arc<Api>, tx: Sender<Msg>) {
    let (o, e) = tokio::join!(
        api.get::<TrafficOverview>("/ai-traffic/overview?window=1h"),
        api.get::<TrafficEvents>("/ai-traffic/events?limit=200&window=1h"),
    );
    let r = match (o, e) {
        (Ok(o), Ok(e)) => Ok((Box::new(o), e)),
        (Err(x), _) | (_, Err(x)) => Err(x.to_string()),
    };
    put(&tx, Msg::Traffic(r)).await;
}

pub async fn load_chat(api: Arc<Api>, tx: Sender<Msg>, agent: String, key: Option<String>) {
    // Same restore rule as the web chat: the latest conversation with the agent.
    let key = match key {
        Some(k) => k,
        None => match api
            .get::<HistoryPage>(&format!("/ai/history?agent={}&limit=1", enc(&agent)))
            .await
        {
            Ok(p) => p
                .items
                .first()
                .and_then(|i| i.task.conversation_key.clone())
                .unwrap_or_else(|| new_conversation_key(&agent)),
            Err(e) => {
                put(&tx, Msg::Error(format!("chat history: {e}"))).await;
                return;
            }
        },
    };
    let path = format!(
        "/ai/history?agent={}&conversation_key={}&limit=100",
        enc(&agent),
        enc(&key)
    );
    match api.get::<HistoryPage>(&path).await {
        Ok(p) => {
            let mut tasks: Vec<Task> = p.items.into_iter().map(|i| i.task).collect();
            tasks.reverse();
            put(&tx, Msg::ChatHistory(agent, key, tasks)).await;
        }
        Err(e) => put(&tx, Msg::Error(format!("chat history: {e}"))).await,
    }
}

/// Same key format as the web chat, so conversations show up in both.
pub fn new_conversation_key(agent: &str) -> String {
    format!("web:{agent}:{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_split_chunks_and_keepalives() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: {\"agent\":\"a\"").is_empty());
        let out = p.push(b"}\n\n: keepalive\n\ndata: x\r\ndata: y\r\n\r\n");
        assert_eq!(
            out,
            vec!["{\"agent\":\"a\"}".to_string(), "x\ny".to_string()]
        );
    }

    #[test]
    fn op_descriptions_name_the_exact_change() {
        let op = Op::ReviewPatch {
            id: "p".into(),
            title: "Add tool".into(),
            decision: "approve".into(),
            sha: Some("abcdef0123456789".into()),
            comment: String::new(),
        };
        assert!(op.describe().contains("abcdef012345"));
        assert!(Op::CancelTask {
            id: "12345678-aaaa".into()
        }
        .describe()
        .ends_with("12345678"));
    }
}
