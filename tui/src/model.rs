//! Backend data shapes (backend/app/schemas, api/routes). Unknown fields are
//! ignored and missing optional ones default, so a newer backend stays readable.

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

pub type Ts = Option<DateTime<Utc>>;

/// RFC 3339, or a naive timestamp read as UTC; anything else is None.
pub fn ts<'de, D: Deserializer<'de>>(d: D) -> Result<Ts, D::Error> {
    let v: Option<Value> = Option::deserialize(d)?;
    Ok(match v {
        Some(Value::String(s)) => parse_ts(&s),
        Some(Value::Number(n)) => n
            .as_f64()
            .and_then(|f| DateTime::from_timestamp(f as i64, ((f.fract()) * 1e9) as u32)),
        _ => None,
    })
}

pub fn parse_ts(s: &str) -> Ts {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|n| n.and_utc())
        })
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub role: String,
    pub username: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Agent {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub responsibility: Option<String>,
    pub status: String,
    pub current_task: Option<String>,
    pub error_message: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub allowed_tools: Vec<String>,
    pub allowed_environments: Vec<String>,
    pub autonomy_level: i64,
    pub enabled: bool,
    pub runtime: String,
    pub personal: bool,
    #[serde(deserialize_with = "ts")]
    pub last_activity_at: Ts,
    pub running_tasks: i64,
    pub queued_tasks: i64,
    /// Agents this one may hand work to; None on the Coordinator means all.
    pub allowed_dispatch_targets: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Provider {
    pub id: String,
    pub slug: String,
    pub display_name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Task {
    pub id: String,
    pub agent_id: String,
    pub requested_by: Option<String>,
    pub source: String,
    pub conversation_key: Option<String>,
    pub input_message: String,
    pub response_message: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub agents_used: Vec<String>,
    pub tools_used: Vec<Value>,
    #[serde(deserialize_with = "ts")]
    pub started_at: Ts,
    #[serde(deserialize_with = "ts")]
    pub completed_at: Ts,
    pub duration_ms: Option<i64>,
    #[serde(deserialize_with = "ts")]
    pub created_at: Ts,
    pub outcome: Option<String>,
    pub resumed_from: Option<String>,
}

impl Task {
    pub fn is_open(&self) -> bool {
        matches!(self.status.as_str(), "queued" | "running")
    }
    pub fn title(&self) -> String {
        // The web UI appends page context after this mark; it is not the question.
        let text = self
            .input_message
            .split("\n\n---\nPage context")
            .next()
            .unwrap_or("");
        text.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string()
    }
    pub fn tool_names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for t in &self.tools_used {
            if let Some(n) = t.get("tool").and_then(Value::as_str) {
                if !out.iter().any(|x| x == n) {
                    out.push(n.to_string());
                }
            }
        }
        out
    }
    /// Run time so far, or the recorded duration of a finished task.
    pub fn elapsed_secs(&self, now: DateTime<Utc>) -> Option<i64> {
        if let Some(ms) = self.duration_ms {
            return Some(ms / 1000);
        }
        let start = self.started_at?;
        Some(
            (self.completed_at.unwrap_or(now) - start)
                .num_seconds()
                .max(0),
        )
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Action {
    pub id: String,
    pub request_code: String,
    pub agent_id: String,
    pub task_id: Option<String>,
    pub action: String,
    pub tool: String,
    pub arguments: Value,
    pub approval_level: i64,
    pub risk: String,
    pub reason: Option<String>,
    pub status: String,
    pub source: String,
    pub requested_by: Option<String>,
    pub approved_by: Option<String>,
    #[serde(deserialize_with = "ts")]
    pub requested_at: Ts,
    #[serde(deserialize_with = "ts")]
    pub expires_at: Ts,
}

/// One developer change from GET /ai/developer/overview.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Change {
    pub id: String,
    pub title: String,
    pub status: String,
    pub stage: String,
    pub summary: String,
    pub proposed_by: Option<String>,
    pub files: i64,
    pub added: i64,
    pub removed: i64,
    pub has_patch: bool,
    pub patch_sha256: Option<String>,
    pub approved_by: Option<String>,
    #[serde(deserialize_with = "ts")]
    pub approved_at: Ts,
    pub release_ref: Option<String>,
    pub branch: Option<String>,
    #[serde(deserialize_with = "ts")]
    pub created_at: Ts,
    #[serde(deserialize_with = "ts")]
    pub updated_at: Ts,
    #[serde(deserialize_with = "ts")]
    pub finished_at: Ts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DevOverview {
    pub items: Vec<Change>,
    pub can_decide: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FileChange {
    pub path: String,
    pub added: i64,
    pub removed: i64,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Check {
    pub name: String,
    pub result: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimelineEntry {
    #[serde(deserialize_with = "ts")]
    pub at: Ts,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Review {
    pub decision: String,
    pub comment: Option<String>,
    pub patch_sha256: Option<String>,
    pub release_ref: Option<String>,
    pub decided_by: Option<String>,
    #[serde(deserialize_with = "ts")]
    pub decided_at: Ts,
}

/// GET /ai/developer/changes/{id}: what a reviewer needs before deciding.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChangeDetail {
    #[serde(flatten)]
    pub summary: Change,
    pub details: Value,
    pub notes: Option<String>,
    pub files_changed: Vec<FileChange>,
    pub checks: Vec<Check>,
    pub timeline: Vec<TimelineEntry>,
    pub reviews: Vec<Review>,
    pub traffic_events: i64,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WorkItem {
    pub id: String,
    pub agent: Option<String>,
    pub title: String,
    pub status: String,
    pub result: Option<Value>,
    pub tools: Option<Value>,
    #[serde(deserialize_with = "ts")]
    pub started_at: Ts,
    #[serde(deserialize_with = "ts")]
    pub finished_at: Ts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct BoardAction {
    pub id: String,
    pub code: String,
    pub tool: String,
    pub status: String,
    pub level: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Board {
    pub task_id: String,
    pub status: String,
    pub outcome: Option<String>,
    pub resumable: bool,
    pub items: Vec<WorkItem>,
    pub actions: Vec<BoardAction>,
}

impl Board {
    /// (done, total) when the task has a work plan; progress is otherwise unknown.
    pub fn progress(&self) -> Option<(usize, usize)> {
        if self.items.is_empty() {
            return None;
        }
        let done = self
            .items
            .iter()
            .filter(|i| matches!(i.status.as_str(), "completed" | "failed" | "inconclusive"))
            .count();
        Some((done, self.items.len()))
    }
}

/// One message on the Ops Floor stream (worker_ai/events.py).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct AgentEvent {
    pub agent: String,
    pub status: Option<String>,
    pub activity: Option<String>,
    pub target: Option<String>,
    pub task_id: Option<String>,
    pub event: Option<String>,
    pub peer: Option<String>,
    pub tool: Option<String>,
    pub event_type: Option<String>,
    #[serde(deserialize_with = "ts")]
    pub ts: Ts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Warn,
    Error,
}

impl AgentEvent {
    pub fn severity(&self) -> Severity {
        match (self.event.as_deref(), self.status.as_deref()) {
            (Some("error"), _) | (_, Some("error")) => Severity::Error,
            (Some("approval_requested" | "stopped"), _) | (_, Some("waiting")) => Severity::Warn,
            _ => Severity::Info,
        }
    }

    /// What happened, in words, built only from fields the backend sent.
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        let ev = self.event.as_deref().unwrap_or("");
        let label = match ev {
            "task_started" => "Started task",
            "tool_started" => "Tool call",
            "tool_finished" => "Tool finished",
            "delegated" => "Delegated",
            "returned" => "Returned",
            "approval_requested" => "Approval requested",
            "action_started" => "Running approved action",
            "action_finished" => "Action finished",
            "completed" => "Completed",
            "stopped" => "Stopped",
            "error" => "Error",
            "" => "",
            other => other,
        };
        if !label.is_empty() {
            parts.push(label.to_string());
        } else if let Some(s) = &self.status {
            parts.push(format!("[{s}]"));
        }
        if let Some(t) = &self.tool {
            parts.push(t.clone());
        }
        if let Some(p) = &self.peer {
            parts.push(format!("→ {p}"));
        }
        if let Some(t) = &self.target {
            parts.push(format!("@ {t}"));
        }
        if let Some(a) = &self.activity {
            if !a.is_empty() {
                parts.push(format!("– {a}"));
            }
        }
        crate::mask::mask(&parts.join(" "))
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Health {
    pub status: String,
    pub version: String,
    pub components: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Series {
    pub instance: String,
    pub points: Vec<(f64, f64)>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HostMetrics {
    pub available: bool,
    pub cpu: Vec<Series>,
    pub memory: Vec<Series>,
}

/// CPU/RAM for the dashboard: latest value and a CPU history, averaged over
/// the selected hosts. None when Prometheus had nothing.
#[derive(Debug, Clone, Default)]
pub struct Resources {
    pub hosts: usize,
    pub cpu: Option<f64>,
    pub ram: Option<f64>,
    pub cpu_history: Vec<u64>,
}

impl HostMetrics {
    pub fn summarize(&self, host: &str) -> Resources {
        let pick = |s: &&Series| host.is_empty() || s.instance == host;
        let cpu: Vec<&Series> = self.cpu.iter().filter(pick).collect();
        let ram: Vec<&Series> = self.memory.iter().filter(pick).collect();
        let last = |v: &[&Series]| {
            let vals: Vec<f64> = v
                .iter()
                .filter_map(|s| s.points.last().map(|p| p.1))
                .collect();
            (!vals.is_empty()).then(|| vals.iter().sum::<f64>() / vals.len() as f64)
        };
        // Average per timestamp across hosts.
        let mut buckets: std::collections::BTreeMap<i64, (f64, u32)> = Default::default();
        for s in &cpu {
            for (t, v) in &s.points {
                let e = buckets.entry(*t as i64).or_default();
                e.0 += v;
                e.1 += 1;
            }
        }
        let mut hosts: Vec<&str> = cpu
            .iter()
            .chain(ram.iter())
            .map(|s| s.instance.as_str())
            .collect();
        hosts.sort_unstable();
        hosts.dedup();
        Resources {
            hosts: hosts.len(),
            cpu: last(&cpu),
            ram: last(&ram),
            cpu_history: buckets
                .values()
                .map(|(sum, n)| (sum / *n as f64).round().max(0.0) as u64)
                .collect(),
        }
    }
}

/// One row of GET /ai/usage: tokens per provider/model per day.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct UsagePoint {
    pub date: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub calls: i64,
    /// None when the backend cannot price the calls (shown as unknown).
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct UsageResponse {
    pub points: Vec<UsagePoint>,
}

/// GET /ai/budget: the shared weekly AI allowance.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Budget {
    pub limit_usd: f64,
    pub billed_usd: f64,
    pub reserved_usd: f64,
    pub remaining_usd: f64,
    pub warning: bool,
    pub exhausted: bool,
    #[serde(deserialize_with = "ts")]
    pub reset_at: Ts,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tokens {
    pub input: i64,
    pub output: i64,
    pub calls: i64,
    /// None if any call in the period has no known price.
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Usage {
    pub today: Tokens,
    pub week: Tokens,
    pub budget: Option<Budget>,
}

impl UsageResponse {
    /// Totals for `today` (YYYY-MM-DD, the backend's UTC day) and all days returned.
    pub fn totals(&self, today: &str) -> (Tokens, Tokens) {
        let add = |t: &mut Tokens, p: &UsagePoint| {
            t.input += p.input_tokens;
            t.output += p.output_tokens;
            t.calls += p.calls;
            t.cost = match (t.cost, p.cost_usd) {
                (Some(a), Some(b)) => Some(a + b),
                _ => None,
            };
        };
        let mut day = Tokens {
            cost: Some(0.0),
            ..Default::default()
        };
        let mut all = day.clone();
        for p in &self.points {
            add(&mut all, p);
            if p.date == today {
                add(&mut day, p);
            }
        }
        (day, all)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HistoryItem {
    pub agent: String,
    pub task: Task,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HistoryPage {
    pub total: i64,
    pub items: Vec<HistoryItem>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AuditEntry {
    pub id: String,
    pub user: Option<String>,
    pub source_ip: Option<String>,
    pub action: String,
    pub target: String,
    pub parameters: Value,
    pub result: String,
    #[serde(deserialize_with = "ts")]
    pub created_at: Ts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TrafficEvent {
    pub id: i64,
    #[serde(deserialize_with = "ts")]
    pub ts: Ts,
    pub duration_ms: Option<f64>,
    pub kind: Option<String>,
    pub agent_slug: Option<String>,
    pub tool: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mcp_tool: Option<String>,
    pub dst_host: Option<String>,
    pub dst_ip: Option<String>,
    pub dst_port: Option<i64>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub status_code: Option<i64>,
    pub bytes_sent: Option<i64>,
    pub bytes_recv: Option<i64>,
    pub outcome: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TrafficEvents {
    pub events: Vec<TrafficEvent>,
    pub max_id: i64,
}

/// /ai-traffic/overview, kept as JSON: the TUI shows totals and top lists only.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TrafficOverview {
    pub window: String,
    pub totals: Value,
    pub requests_last_minute: i64,
    pub active_connections: i64,
    pub top_agents: Vec<Value>,
    pub top_destinations: Vec<Value>,
    pub top_models: Vec<Value>,
    pub coverage: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_parse_in_all_backend_forms() {
        assert!(parse_ts("2026-11-16T07:00:00.123456+00:00").is_some());
        assert!(parse_ts("2026-11-16T07:00:00Z").is_some());
        assert!(parse_ts("2026-11-16T07:00:00.5").is_some());
        assert!(parse_ts("yesterday").is_none());
        let e: AgentEvent = serde_json::from_str(r#"{"agent":"dev","ts":1763276400.25}"#).unwrap();
        assert!(e.ts.is_some());
    }

    #[test]
    fn event_description_uses_real_fields_and_masks() {
        let e: AgentEvent = serde_json::from_str(
            r#"{"agent":"developer","status":"working","event":"tool_started","tool":"file_read",
               "target":"worker_ai/x.py","activity":"token=abcdefghijklmnop","task_id":"t1"}"#,
        )
        .unwrap();
        let d = e.describe();
        assert!(d.starts_with("Tool call file_read @ worker_ai/x.py"));
        assert!(!d.contains("abcdefghijklmnop"));
        assert_eq!(e.severity(), Severity::Info);
        let err = AgentEvent {
            event: Some("error".into()),
            ..Default::default()
        };
        assert_eq!(err.severity(), Severity::Error);
    }

    #[test]
    fn task_title_hides_page_context() {
        let t = Task {
            input_message: "\nCheck disk\nmore\n\n---\nPage context: x".into(),
            ..Default::default()
        };
        assert_eq!(t.title(), "Check disk");
    }

    #[test]
    fn usage_totals_split_today_and_mark_unknown_cost() {
        let u: UsageResponse = serde_json::from_str(
            r#"{"days":7,"points":[
              {"date":"2026-11-15","model":"a","input_tokens":100,"output_tokens":10,"calls":2,"cost_usd":0.5},
              {"date":"2026-11-16","model":"a","input_tokens":40,"output_tokens":4,"calls":1,"cost_usd":0.25},
              {"date":"2026-11-16","model":"b","input_tokens":60,"output_tokens":6,"calls":3,"cost_usd":null}]}"#,
        )
        .unwrap();
        let (day, week) = u.totals("2026-11-16");
        assert_eq!(
            (day.input, day.output, day.calls, day.cost),
            (100, 10, 4, None)
        );
        assert_eq!((week.input, week.output, week.calls), (200, 20, 6));
        let (day, _) = u.totals("2026-11-15");
        assert_eq!(day.cost, Some(0.5));
    }

    #[test]
    fn metrics_average_hosts() {
        let m: HostMetrics = serde_json::from_str(
            r#"{"available":true,"cpu":[{"instance":"a","points":[[1,10],[2,20]]},{"instance":"b","points":[[1,30],[2,40]]}],
                "memory":[{"instance":"a","points":[[2,50]]}]}"#,
        )
        .unwrap();
        let r = m.summarize("");
        assert_eq!(r.hosts, 2);
        assert_eq!(r.cpu, Some(30.0));
        assert_eq!(r.ram, Some(50.0));
        assert_eq!(r.cpu_history, vec![20, 30]);
        assert_eq!(m.summarize("b").cpu, Some(40.0));
        assert_eq!(m.summarize("zzz").cpu, None);
    }
}
