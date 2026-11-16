//! Application state and input handling. Rendering lives in ui.rs; network
//! work in sync.rs. Selecting a row never changes anything on the server:
//! every write goes through an explicit key and, for risky ones, a confirm.

use crate::api::Api;
use crate::config::Config;
use crate::model::*;
use crate::sync::{self, Conn, Msg, Op};
use chrono::{DateTime, Utc};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc::Sender, Notify};
use tokio::task::JoinHandle;

pub const EVENT_CAP: usize = 5000;
pub const VIEWS: [&str; 9] = [
    "Dashboard",
    "Agents",
    "Tasks",
    "Approvals",
    "Logs",
    "Chat",
    "History",
    "Settings",
    "Floor",
];
pub const AGENT_FILTERS: [&str; 6] = ["all", "working", "waiting", "error", "idle", "disabled"];
pub const HIST_TABS: [&str; 4] = ["Conversations", "Tasks", "Changes", "Audit"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Dashboard,
    Agents,
    Tasks,
    Approvals,
    Logs,
    Chat,
    History,
    Settings,
    /// Ops Floor, 2D plan (the web's /ai-agents/ops-floor).
    Floor,
}

impl View {
    pub const ALL: [View; 9] = [
        View::Dashboard,
        View::Agents,
        View::Tasks,
        View::Approvals,
        View::Logs,
        View::Chat,
        View::History,
        View::Settings,
        View::Floor,
    ];
    pub fn index(self) -> usize {
        View::ALL.iter().position(|v| *v == self).unwrap_or(0)
    }
    /// Panels Tab cycles through.
    pub fn panels(self) -> usize {
        match self {
            View::Dashboard => 5,
            View::Agents | View::Tasks | View::Approvals | View::Chat => 2,
            _ => 1,
        }
    }
}

/// Category an agent is listed under in the Agents panel, from its metadata
/// (`personal`, `runtime`) rather than its name.
#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord, Hash)]
pub enum AgentGroup {
    Ops,
    External,
    Personal,
}

impl AgentGroup {
    pub const ALL: [AgentGroup; 3] = [AgentGroup::Ops, AgentGroup::External, AgentGroup::Personal];
    pub fn label(self) -> &'static str {
        match self {
            AgentGroup::Ops => "OPS Agents",
            AgentGroup::External => "External Agents",
            AgentGroup::Personal => "Personal Agents",
        }
    }
    /// Personal agents first; then agents run by Ops-Center's own worker
    /// (`native`, or no runtime reported) are OPS; every other runtime
    /// (`external`, local Claude, anything new) runs outside it.
    pub fn of(a: &Agent) -> Self {
        if a.personal {
            AgentGroup::Personal
        } else if a.runtime.is_empty() || a.runtime == "native" {
            AgentGroup::Ops
        } else {
            AgentGroup::External
        }
    }
}

/// A line in the grouped agent list: a category header or an agent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentRow {
    Group {
        group: AgentGroup,
        open: bool,
        total: usize,
        active: usize,
    },
    /// Index into `App::agents`.
    Agent(usize),
}

pub fn is_working(status: &str) -> bool {
    matches!(
        status,
        "working" | "investigating" | "thinking" | "delegating" | "running"
    )
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord, Hash)]
pub enum TaskGroup {
    Running,
    Queued,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

impl TaskGroup {
    pub const ALL: [TaskGroup; 6] = [
        TaskGroup::Running,
        TaskGroup::Queued,
        TaskGroup::WaitingApproval,
        TaskGroup::Completed,
        TaskGroup::Failed,
        TaskGroup::Cancelled,
    ];
    pub fn label(self) -> &'static str {
        match self {
            TaskGroup::Running => "Running",
            TaskGroup::Queued => "Queued",
            TaskGroup::WaitingApproval => "Waiting for approval",
            TaskGroup::Completed => "Completed",
            TaskGroup::Failed => "Failed",
            TaskGroup::Cancelled => "Cancelled",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DetailTab {
    Diff,
    Tests,
    Security,
    Details,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ApprovalRef {
    Action(usize),
    Change(usize),
    /// A local Claude agent waiting for permission or an answer.
    Prompt(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Purpose {
    RequestChanges {
        id: String,
        title: String,
        sha: Option<String>,
    },
    ReleaseRef {
        id: String,
        title: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Modal {
    Help,
    /// `word`: must be typed to confirm (production and destructive steps).
    Confirm {
        op: Op,
        word: Option<&'static str>,
        typed: String,
    },
    Password {
        op: Op,
        buf: String,
        error: Option<String>,
        busy: bool,
    },
    Input {
        title: String,
        buf: String,
        purpose: Purpose,
    },
    NewTask {
        agent: usize,
        buf: String,
    },
    Text {
        title: String,
        lines: Vec<String>,
        diff: bool,
        scroll: u16,
    },
    /// Outcome of a decision or a refusal; any key closes it.
    Notice {
        title: String,
        lines: Vec<String>,
        ok: bool,
    },
    /// AskUserQuestion from a local Claude agent: question `q` of prompt `idx`.
    Question {
        idx: usize,
        q: usize,
        sel: usize,
        /// Toggled options of a multi-select question.
        picked: Vec<usize>,
        answers: Vec<(String, String)>,
        /// Typed answer instead of an option.
        custom: String,
    },
    /// Right-click menu at a screen position.
    Menu {
        x: u16,
        y: u16,
        items: Vec<(String, MenuAction)>,
        sel: usize,
    },
    /// Which agent the chat talks to.
    AgentPicker {
        sel: usize,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum MenuAction {
    NewClaude,
    Chat(String),
    StopClaude(String),
    CloseClaude(String),
}

#[derive(Debug, Clone)]
pub struct Logged {
    pub seq: u64,
    pub at: DateTime<Utc>,
    pub ev: AgentEvent,
}

#[derive(Debug, Default)]
pub struct LoginForm {
    pub server: String,
    pub username: String,
    pub password: String,
    pub field: usize,
    pub error: Option<String>,
    pub busy: bool,
}

#[derive(Debug)]
pub struct LogState {
    pub agent: Option<String>,
    pub task: Option<String>,
    pub min_sev: Severity,
    pub query: String,
    /// Frozen view: only events up to this sequence number are shown.
    pub paused_at: Option<u64>,
    pub follow: bool,
    pub sel: usize,
    pub traffic: bool,
}

#[derive(Debug, Default)]
pub struct ChatState {
    pub agent: Option<String>,
    pub key: Option<String>,
    pub msgs: Vec<Task>,
    pub input: String,
    pub typing: bool,
    pub sel: usize,
    pub loading: bool,
    pub scroll: u16,
}

#[derive(Debug, Default)]
pub struct HistState {
    pub tab: usize,
    pub query: String,
    pub page: Option<HistoryPage>,
    pub audit: Option<Result<Vec<AuditEntry>, String>>,
    pub sel: usize,
}

pub struct App {
    pub cfg: Config,
    pub tx: Sender<Msg>,
    pub api: Option<Arc<Api>>,
    poke: Arc<Notify>,
    jobs: Vec<JoinHandle<()>>,
    pub quit: bool,

    pub login: LoginForm,
    pub user: Option<TokenResponse>,

    pub view: View,
    prev_view: View,
    pub focus: usize,
    pub modal: Option<Modal>,
    pub search: Option<String>,
    pub flash: Option<(String, bool, Instant)>,

    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
    pub actions: Vec<Action>,
    pub changes: Vec<Change>,
    pub providers: Vec<Provider>,
    pub can_decide: bool,
    pub snapshot_errors: Vec<String>,
    pub last_snapshot: Option<DateTime<Utc>>,
    pub health: Option<Health>,
    pub resources: Option<Resources>,
    pub metrics_seen: bool,
    pub usage: Option<Usage>,
    pub usage_seen: bool,
    pub conn: Conn,

    pub events: VecDeque<Logged>,
    seq: u64,

    pub boards: HashMap<String, (Board, Instant)>,
    pub change: Option<ChangeDetail>,
    change_at: Option<Instant>,
    pub patches: HashMap<String, Result<String, String>>,
    inflight: HashSet<String>,
    pub detail_tab: DetailTab,

    /// Index into `agent_rows()`.
    pub sel_agent: usize,
    /// Closed categories in the agent list; kept across views.
    pub agent_closed: HashSet<AgentGroup>,
    /// Closed categories in the Chat view's agent list.
    pub chat_closed: HashSet<AgentGroup>,
    pub sel_task: usize,
    pub sel_queue: usize,
    pub sel_approval: usize,
    /// Stable identity of the selected approval, so items arriving or leaving
    /// never move a/r onto a different request than the one on screen.
    pub sel_approval_key: Option<String>,
    pub agent_filter: usize,
    pub agent_query: String,
    pub task_group: Option<TaskGroup>,
    pub task_query: String,
    pub log: LogState,
    pub chat: ChatState,
    pub hist: HistState,
    pub traffic: Option<Result<(Box<TrafficOverview>, TrafficEvents), String>>,
    traffic_at: Option<Instant>,

    /// Filled by the renderer for mouse hit-testing.
    pub hit_tabs: Vec<Rect>,
    pub hit_panels: Vec<(Rect, usize)>,
    /// The dashboard chat's "to <agent> ▾" line.
    pub hit_chat_header: Option<Rect>,
    /// Items decided here, hidden until the next snapshot no longer lists them.
    pub decided: HashSet<String>,
    /// Local Claude Code agents (claude.rs).
    pub claude: Vec<crate::claude::Session>,
    /// Questions and permission requests from local Claude agents (agent slug, request).
    pub claude_prompts: Vec<(String, crate::claude::Prompt)>,
    claude_count: usize,
    /// Whole terminal, for locating modal rows on click.
    pub screen: Rect,
    /// Last live event per agent slug, for the Ops Floor's motion and links.
    pub live: HashMap<String, crate::floor::Live>,
    /// Agent selected on the Ops Floor (slug, so it survives refreshes).
    pub floor_sel: Option<String>,
    /// Agent cards on the Ops Floor, filled by the renderer for clicks.
    pub hit_floor: Vec<(Rect, String)>,
}

impl App {
    pub fn new(cfg: Config, tx: Sender<Msg>) -> Self {
        let claude = default_claude(&cfg.claude_default_agent);
        let login = LoginForm {
            server: cfg.server.clone(),
            username: cfg.username.clone(),
            field: if cfg.server.is_empty() {
                0
            } else if cfg.username.is_empty() {
                1
            } else {
                2
            },
            ..Default::default()
        };
        Self {
            cfg,
            tx,
            api: None,
            poke: Arc::new(Notify::new()),
            jobs: Vec::new(),
            quit: false,
            login,
            user: None,
            view: View::Dashboard,
            prev_view: View::Dashboard,
            focus: 0,
            modal: None,
            search: None,
            flash: None,
            agents: Vec::new(),
            tasks: Vec::new(),
            actions: Vec::new(),
            changes: Vec::new(),
            providers: Vec::new(),
            can_decide: false,
            snapshot_errors: Vec::new(),
            last_snapshot: None,
            health: None,
            resources: None,
            metrics_seen: false,
            usage: None,
            usage_seen: false,
            conn: Conn::Connecting,
            events: VecDeque::new(),
            seq: 0,
            boards: HashMap::new(),
            change: None,
            change_at: None,
            patches: HashMap::new(),
            inflight: HashSet::new(),
            detail_tab: DetailTab::Diff,
            // Row 0 is the first category header; start on its first agent.
            sel_agent: 1,
            agent_closed: HashSet::new(),
            chat_closed: HashSet::new(),
            sel_task: 0,
            sel_queue: 0,
            sel_approval: 0,
            sel_approval_key: None,
            agent_filter: 0,
            agent_query: String::new(),
            task_group: None,
            task_query: String::new(),
            log: LogState {
                agent: None,
                task: None,
                min_sev: Severity::Info,
                query: String::new(),
                paused_at: None,
                follow: true,
                sel: 0,
                traffic: false,
            },
            chat: ChatState::default(),
            hist: HistState::default(),
            traffic: None,
            traffic_at: None,
            hit_tabs: Vec::new(),
            hit_panels: Vec::new(),
            hit_chat_header: None,
            decided: HashSet::new(),
            claude,
            claude_prompts: Vec::new(),
            claude_count: 0,
            screen: Rect::default(),
            live: HashMap::new(),
            floor_sel: None,
            hit_floor: Vec::new(),
        }
    }

    pub fn signed_in(&self) -> bool {
        self.user.is_some()
    }

    pub fn role(&self) -> &str {
        self.user.as_ref().map(|u| u.role.as_str()).unwrap_or("")
    }

    fn info(&mut self, s: impl Into<String>) {
        self.flash = Some((s.into(), false, Instant::now()));
    }

    fn error(&mut self, s: impl Into<String>) {
        let s = s.into();
        tracing::warn!("{s}");
        self.flash = Some((s, true, Instant::now()));
    }

    fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(&mut self, f: F) {
        self.jobs.retain(|j| !j.is_finished());
        self.jobs.push(tokio::spawn(f));
    }

    // ------------------------------------------------------------ derived data

    pub fn agent_by_id(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.id == id)
    }

    pub fn agent_name(&self, id: &str) -> String {
        self.agent_by_id(id)
            .map(|a| a.name.clone())
            .unwrap_or_else(|| sync::short(id).to_string())
    }

    pub fn provider_name(&self, id: Option<&str>) -> Option<String> {
        let id = id?;
        self.providers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.display_name.clone())
    }

    /// The agent's most recent running task, else its oldest queued one.
    pub fn active_task_of(&self, agent_id: &str) -> Option<&Task> {
        let mine = || self.tasks.iter().filter(move |t| t.agent_id == agent_id);
        mine()
            .find(|t| t.status == "running")
            .or_else(|| mine().rfind(|t| t.status == "queued"))
    }

    pub fn pending_task_ids(&self) -> HashSet<&str> {
        self.actions
            .iter()
            .filter_map(|a| a.task_id.as_deref())
            .collect()
    }

    pub fn task_group(&self, t: &Task, pending: &HashSet<&str>) -> TaskGroup {
        match t.status.as_str() {
            "running" if pending.contains(t.id.as_str()) => TaskGroup::WaitingApproval,
            "running" => TaskGroup::Running,
            "queued" => TaskGroup::Queued,
            "failed" => TaskGroup::Failed,
            "cancelled" => TaskGroup::Cancelled,
            _ if t.outcome.as_deref() == Some("waiting_for_approval")
                || pending.contains(t.id.as_str()) =>
            {
                TaskGroup::WaitingApproval
            }
            _ => TaskGroup::Completed,
        }
    }

    pub fn counts(&self) -> Counts {
        let mut c = Counts {
            registered: self.agents.len(),
            ..Default::default()
        };
        for a in &self.agents {
            c.enabled += a.enabled as usize;
            if is_working(&a.status) {
                c.working += 1;
            }
            match a.status.as_str() {
                "waiting" => c.waiting += 1,
                "error" => c.errors += 1,
                _ => {}
            }
            c.running_tasks += a.running_tasks.max(0) as usize;
            c.queued_tasks += a.queued_tasks.max(0) as usize;
            c.busy_agents += (a.running_tasks > 0) as usize;
        }
        c
    }

    pub fn agent_list(&self) -> Vec<usize> {
        let f = AGENT_FILTERS[self.agent_filter];
        let q = self.agent_query.to_lowercase();
        self.agents
            .iter()
            .enumerate()
            .filter(|(_, a)| match f {
                "all" => true,
                "working" => is_working(&a.status),
                "disabled" => !a.enabled,
                s => a.status == s,
            })
            .filter(|(_, a)| {
                q.is_empty()
                    || [
                        a.name.as_str(),
                        &a.slug,
                        a.responsibility.as_deref().unwrap_or(""),
                        a.current_task.as_deref().unwrap_or(""),
                    ]
                    .iter()
                    .any(|s| s.to_lowercase().contains(&q))
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// `agent_list()` grouped by category: a header per non-empty category,
    /// followed by its agents unless it is closed. A search shows matches
    /// in closed categories too.
    pub fn agent_rows(&self) -> Vec<AgentRow> {
        self.group_rows(
            &self.agent_list(),
            &self.agent_closed,
            !self.agent_query.is_empty(),
        )
    }

    /// `list` (indices into `agents`) grouped by category; `searching`
    /// keeps closed categories open.
    fn group_rows(
        &self,
        list: &[usize],
        closed: &HashSet<AgentGroup>,
        searching: bool,
    ) -> Vec<AgentRow> {
        let mut rows = Vec::with_capacity(list.len() + AgentGroup::ALL.len());
        for group in AgentGroup::ALL {
            let members: Vec<usize> = list
                .iter()
                .copied()
                .filter(|i| AgentGroup::of(&self.agents[*i]) == group)
                .collect();
            if members.is_empty() {
                continue;
            }
            let open = searching || !closed.contains(&group);
            rows.push(AgentRow::Group {
                group,
                open,
                total: members.len(),
                active: members
                    .iter()
                    .filter(|i| is_working(&self.agents[**i].status))
                    .count(),
            });
            if open {
                rows.extend(members.into_iter().map(AgentRow::Agent));
            }
        }
        rows
    }

    /// First agent row (the line under the first open header), for resets.
    fn first_agent_row(&self) -> usize {
        self.agent_rows()
            .iter()
            .position(|r| matches!(r, AgentRow::Agent(_)))
            .unwrap_or(0)
    }

    /// The agent on the selected row; None on a category header.
    fn row_agent(&self) -> Option<&Agent> {
        match self.agent_rows().get(self.sel_agent)? {
            AgentRow::Agent(i) => Some(&self.agents[*i]),
            AgentRow::Group { .. } => None,
        }
    }

    /// Open (Some(true)), close (Some(false)) or toggle (None) the selected
    /// row's category. Closing from an agent selects its header.
    fn set_group_open(&mut self, open: Option<bool>) {
        let rows = self.agent_rows();
        let Some(row) = rows.get(self.sel_agent) else {
            return;
        };
        let (group, header, is_open) = match *row {
            AgentRow::Group { group, open, .. } => (group, self.sel_agent, open),
            AgentRow::Agent(i) => {
                let g = AgentGroup::of(&self.agents[i]);
                let h = rows[..self.sel_agent]
                    .iter()
                    .rposition(|r| matches!(r, AgentRow::Group { group, .. } if *group == g))
                    .unwrap_or(0);
                (g, h, true)
            }
        };
        let want = open.unwrap_or(!is_open);
        if want {
            self.agent_closed.remove(&group);
        } else {
            self.agent_closed.insert(group);
            self.sel_agent = header;
        }
    }

    pub fn selected_agent(&self) -> Option<&Agent> {
        if self.view == View::Floor {
            let f = self.floor();
            return self
                .floor_selected(&f)
                .map(|i| &self.agents[f.agents[i].index]);
        }
        self.row_agent()
    }

    /// Open approvals per agent id: agent actions and local Claude prompts.
    pub fn pending_by_agent(&self) -> HashMap<String, usize> {
        let mut m: HashMap<String, usize> = HashMap::new();
        for a in self
            .actions
            .iter()
            .filter(|a| !self.decided.contains(&a.id))
        {
            *m.entry(a.agent_id.clone()).or_default() += 1;
        }
        for (slug, _) in &self.claude_prompts {
            if let Some(a) = self.agents.iter().find(|a| &a.slug == slug) {
                *m.entry(a.id.clone()).or_default() += 1;
            }
        }
        m
    }

    /// The Ops Floor as it is right now.
    pub fn floor(&self) -> crate::floor::Floor {
        crate::floor::build(
            &self.agents,
            &self.live,
            &self.pending_by_agent(),
            Instant::now(),
        )
    }

    /// Index into `floor.agents` of the selected agent; the first one in
    /// reading order when nothing (or someone who left) was selected.
    pub fn floor_selected(&self, f: &crate::floor::Floor) -> Option<usize> {
        self.floor_sel
            .as_deref()
            .and_then(|s| f.find(s))
            .or_else(|| f.order().first().copied())
    }

    /// Arrow keys on the floor: the nearest desk in that direction.
    fn floor_step(&mut self, dx: i32, dy: i32) {
        let f = self.floor();
        let Some(from) = self.floor_selected(&f) else {
            return;
        };
        if self.floor_sel.is_none() {
            self.floor_sel = Some(f.agents[from].slug.clone());
            return;
        }
        if let Some(to) = f.nearest(from, dx, dy) {
            self.floor_sel = Some(f.agents[to].slug.clone());
        }
    }

    /// The selected agent's first open approval, in the Approvals view.
    fn floor_approvals(&mut self) {
        let Some(a) = self
            .selected_agent()
            .map(|a| (a.id.clone(), a.slug.clone()))
        else {
            return;
        };
        let pos = self.approvals().iter().position(|r| match r {
            ApprovalRef::Action(i) => self.actions[*i].agent_id == a.0,
            ApprovalRef::Prompt(i) => self.claude_prompts[*i].0 == a.1,
            ApprovalRef::Change(_) => false,
        });
        match pos {
            Some(p) => {
                self.goto(View::Approvals);
                self.sel_approval = p;
                self.sel_approval_key = None;
                self.pin_approval();
                self.detail_tab = DetailTab::Diff;
            }
            None => self.notice_err("This agent has nothing waiting for approval"),
        }
    }

    /// Tasks view rows: grouped, newest first inside a group.
    pub fn task_list(&self) -> Vec<(TaskGroup, usize)> {
        let pending = self.pending_task_ids();
        let q = self.task_query.to_lowercase();
        let mut rows: Vec<(TaskGroup, usize)> = self
            .tasks
            .iter()
            .enumerate()
            .map(|(i, t)| (self.task_group(t, &pending), i))
            .filter(|(g, _)| self.task_group.is_none_or(|f| f == *g))
            .filter(|(_, i)| {
                let t = &self.tasks[*i];
                q.is_empty()
                    || t.input_message.to_lowercase().contains(&q)
                    || t.id.starts_with(&q)
                    || self.agent_name(&t.agent_id).to_lowercase().contains(&q)
                    || t.requested_by
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&q)
            })
            .collect();
        rows.sort_by_key(|(g, i)| (*g, std::cmp::Reverse(self.tasks[*i].created_at)));
        rows
    }

    pub fn selected_task(&self) -> Option<&Task> {
        let l = self.task_list();
        l.get(self.sel_task.min(l.len().saturating_sub(1)))
            .map(|(_, i)| &self.tasks[*i])
    }

    /// Dashboard queue: open tasks, oldest first.
    pub fn queue(&self) -> Vec<&Task> {
        let mut v: Vec<&Task> = self.tasks.iter().filter(|t| t.is_open()).collect();
        v.sort_by_key(|t| t.created_at);
        v
    }

    /// Pending decisions: agent actions, then developer changes needing a person.
    pub fn approvals(&self) -> Vec<ApprovalRef> {
        // Claude prompts first: an agent is blocked until they are answered.
        let mut v: Vec<ApprovalRef> = (0..self.claude_prompts.len())
            .map(ApprovalRef::Prompt)
            .collect();
        v.extend(
            (0..self.actions.len())
                .filter(|i| !self.decided.contains(&self.actions[*i].id))
                .map(ApprovalRef::Action),
        );
        v.extend(
            self.changes
                .iter()
                .enumerate()
                .filter(|(_, c)| !self.decided.contains(&c.id))
                .filter(|(_, c)| {
                    matches!(
                        c.stage.as_str(),
                        "ready_for_review" | "proposed" | "changes_requested" | "approved"
                    )
                })
                .map(|(i, _)| ApprovalRef::Change(i)),
        );
        v
    }

    /// Items that still need a person's decision. An approved change only
    /// waits for its release record, which is not an approval.
    pub fn pending_count(&self) -> usize {
        self.approvals()
            .iter()
            .filter(|r| match r {
                ApprovalRef::Action(_) | ApprovalRef::Prompt(_) => true,
                ApprovalRef::Change(i) => self.changes[*i].stage != "approved",
            })
            .count()
    }

    fn notice(&mut self, title: &str, lines: Vec<String>, ok: bool) {
        self.modal = Some(Modal::Notice {
            title: title.into(),
            lines,
            ok,
        });
    }

    fn notice_err(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        tracing::info!("{msg}");
        self.notice("Not possible", vec![msg], false);
    }

    pub fn approval_id(&self, r: ApprovalRef) -> String {
        match r {
            ApprovalRef::Prompt(i) => format!("prompt:{}", self.claude_prompts[i].1.request_id),
            ApprovalRef::Action(i) => format!("action:{}", self.actions[i].id),
            ApprovalRef::Change(i) => format!("change:{}", self.changes[i].id),
        }
    }

    /// The selected approval: the pinned item while it exists, else by position.
    pub fn selected_approval(&self) -> Option<ApprovalRef> {
        let v = self.approvals();
        if let Some(k) = &self.sel_approval_key {
            if let Some(r) = v.iter().find(|r| &self.approval_id(**r) == k) {
                return Some(*r);
            }
        }
        v.get(self.sel_approval.min(v.len().saturating_sub(1)))
            .copied()
    }

    /// Pins the selection to what is on screen; called before each frame.
    pub fn pin_approval(&mut self) {
        let v = self.approvals();
        match self.selected_approval() {
            Some(r) => {
                self.sel_approval = v.iter().position(|x| *x == r).unwrap_or(0);
                self.sel_approval_key = Some(self.approval_id(r));
            }
            None => self.sel_approval_key = None,
        }
    }

    pub fn visible_events(&self) -> Vec<&Logged> {
        let q = self.log.query.to_lowercase();
        self.events
            .iter()
            .filter(|l| self.log.paused_at.is_none_or(|s| l.seq <= s))
            .filter(|l| {
                self.log
                    .agent
                    .as_ref()
                    .is_none_or(|a| &l.ev.agent == a || l.ev.peer.as_ref() == Some(a))
            })
            .filter(|l| {
                self.log
                    .task
                    .as_ref()
                    .is_none_or(|t| l.ev.task_id.as_ref() == Some(t))
            })
            .filter(|l| l.ev.severity() >= self.log.min_sev)
            .filter(|l| {
                q.is_empty()
                    || l.ev.agent.to_lowercase().contains(&q)
                    || l.ev.describe().to_lowercase().contains(&q)
            })
            .collect()
    }

    /// Agents that can take messages, in category order (indices into
    /// `agents`).
    fn chat_list(&self) -> Vec<usize> {
        let mut list: Vec<usize> = self
            .agents
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                a.enabled && (a.runtime == "native" || a.runtime == crate::claude::RUNTIME)
            })
            .map(|(i, _)| i)
            .collect();
        list.sort_by_key(|i| AgentGroup::of(&self.agents[*i]));
        list
    }

    pub fn chat_agents(&self) -> Vec<&Agent> {
        self.chat_list()
            .into_iter()
            .map(|i| &self.agents[i])
            .collect()
    }

    /// The Chat view's agent list grouped by category, like `agent_rows()`.
    pub fn chat_rows(&self) -> Vec<AgentRow> {
        self.group_rows(&self.chat_list(), &self.chat_closed, false)
    }

    /// The agent on the Chat view's selected row; None on a header.
    fn chat_row_agent(&self) -> Option<&Agent> {
        match self.chat_rows().get(self.chat.sel)? {
            AgentRow::Agent(i) => Some(&self.agents[*i]),
            AgentRow::Group { .. } => None,
        }
    }

    /// Select `slug` in the Chat view's list, opening its category.
    fn select_chat_row(&mut self, slug: &str) {
        let Some(i) = self.agents.iter().position(|a| a.slug == slug) else {
            return;
        };
        self.chat_closed.remove(&AgentGroup::of(&self.agents[i]));
        if let Some(p) = self
            .chat_rows()
            .iter()
            .position(|r| matches!(r, AgentRow::Agent(j) if *j == i))
        {
            self.chat.sel = p;
        }
    }

    /// Open, close or toggle (None) the category of the Chat view's selected
    /// row. Closing from an agent selects its header.
    fn set_chat_group_open(&mut self, open: Option<bool>) {
        let rows = self.chat_rows();
        let Some(row) = rows.get(self.chat.sel) else {
            return;
        };
        let (group, header, is_open) = match *row {
            AgentRow::Group { group, open, .. } => (group, self.chat.sel, open),
            AgentRow::Agent(i) => {
                let g = AgentGroup::of(&self.agents[i]);
                let h = rows[..self.chat.sel]
                    .iter()
                    .rposition(|r| matches!(r, AgentRow::Group { group, .. } if *group == g))
                    .unwrap_or(0);
                (g, h, true)
            }
        };
        if open.unwrap_or(!is_open) {
            self.chat_closed.remove(&group);
        } else {
            self.chat_closed.insert(group);
            self.chat.sel = header;
        }
    }

    pub fn claude_session(&self, slug: &str) -> Option<&crate::claude::Session> {
        self.claude.iter().find(|s| s.slug == slug)
    }

    /// Shows local Claude agents and their turns next to the backend's
    /// agents and tasks; called after every snapshot and Claude event.
    fn merge_local(&mut self) {
        let rt = crate::claude::RUNTIME;
        self.agents.retain(|a| a.runtime != rt);
        self.tasks.retain(|t| !t.id.starts_with("claude:"));
        let dir = self.cfg.claude_dir.clone();
        for s in &self.claude {
            self.agents.push(Agent {
                id: s.agent_id(),
                slug: s.slug.clone(),
                name: s.name.clone(),
                description: Some(format!(
                    "Claude Code on this host, session {}",
                    s.session_id
                )),
                responsibility: Some(format!("Claude Code · {dir}")),
                status: s.status().into(),
                current_task: s.activity.clone(),
                model: s.model.clone(),
                enabled: true,
                runtime: rt.into(),
                last_activity_at: s.turns.last().and_then(|t| t.completed_at.or(t.started_at)),
                running_tasks: s.busy as i64,
                ..Default::default()
            });
            self.tasks.extend(s.turns.iter().cloned());
        }
        self.tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if let Some(s) = self
            .chat
            .agent
            .as_ref()
            .and_then(|a| self.claude.iter().find(|s| &s.slug == a))
        {
            self.chat.msgs = s.turns.clone();
        }
    }

    /// New local Claude agent, selected and ready to take a task.
    pub fn new_claude(&mut self) {
        self.claude_count += 1;
        let s = crate::claude::Session::new(self.claude_count);
        let (slug, name) = (s.slug.clone(), s.name.clone());
        self.claude.push(s);
        self.merge_local();
        if let Some(i) = self.agents.iter().position(|a| a.slug == slug) {
            self.agent_closed.remove(&AgentGroup::of(&self.agents[i]));
        }
        if let Some(p) = self
            .agent_rows()
            .iter()
            .position(|r| matches!(r, AgentRow::Agent(i) if self.agents[*i].slug == slug))
        {
            self.sel_agent = p;
        }
        self.open_chat(&slug, None);
        self.select_chat_row(&slug);
        match self.view {
            View::Dashboard => self.focus = 4,
            View::Chat => self.focus = 1,
            _ => {
                self.goto(View::Dashboard);
                self.focus = 4;
            }
        }
        self.chat.typing = true;
        self.info(format!(
            "{name} is ready in {}; type its task",
            self.cfg.claude_dir
        ));
    }

    fn claude_settings(&self) -> crate::claude::Settings {
        crate::claude::Settings {
            bin: self.cfg.claude_bin.clone(),
            dir: self.cfg.claude_dir.clone(),
            permission_mode: self.cfg.claude_permission_mode.clone(),
        }
    }

    /// Sends a message; starts (or resumes) the agent's process if needed.
    /// While it works, further messages queue up as in the CLI.
    fn claude_send(&mut self, slug: &str, text: String) {
        let user = self.user.as_ref().map(|u| u.username.clone());
        let settings = self.claude_settings();
        let tx = self.tx.clone();
        let Some(s) = self.claude.iter_mut().find(|s| s.slug == slug) else {
            return;
        };
        let mut job = None;
        if s.input.is_none() {
            let (input, fut) = crate::claude::spawn(
                settings,
                s.session_id.clone(),
                s.started,
                s.slug.clone(),
                tx,
                s.cancel.clone(),
            );
            let _ = input.send(crate::claude::init_line());
            s.input = Some(input);
            s.started = true;
            job = Some(fut);
        }
        let now = Utc::now();
        let queued = s.busy;
        let turn = Task {
            id: format!("claude:{}:{}", s.slug, s.turns.len() + 1),
            agent_id: s.agent_id(),
            requested_by: user,
            source: "claude".into(),
            conversation_key: Some(s.conversation_key()),
            input_message: text.clone(),
            status: if queued { "queued" } else { "running" }.into(),
            created_at: Some(now),
            started_at: (!queued).then_some(now),
            ..Default::default()
        };
        let turn_id = turn.id.clone();
        s.turns.push(turn);
        s.write(crate::claude::user_line(&text));
        s.busy = true;
        s.failed = false;
        if !queued {
            s.activity = Some("thinking".into());
        }
        let slug = s.slug.clone();
        if let Some(fut) = job {
            self.spawn(fut);
        }
        if !queued {
            self.on_event(AgentEvent {
                agent: slug,
                status: Some("working".into()),
                event: Some("task_started".into()),
                activity: Some(crate::app::clip(&text, 120)),
                task_id: Some(turn_id),
                ..Default::default()
            });
        } else {
            self.info("Queued: Claude takes it as soon as the current task is done");
        }
        self.merge_local();
    }

    /// Interrupts the running turn; the session stays open.
    pub fn claude_stop(&mut self, slug: &str) {
        if let Some(s) = self.claude.iter_mut().find(|s| s.slug == slug && s.busy) {
            s.interrupting = true;
            if !s.write(crate::claude::interrupt_line()) {
                s.cancel.notify_one();
            }
            let name = s.name.clone();
            self.info(format!("Stopping {name} …"));
        }
    }

    fn on_claude(&mut self, slug: String, ev: crate::claude::Event) {
        use crate::claude::Event as E;
        let now = Utc::now();
        let mode = self.cfg.claude_permission_mode.clone();
        let Some(s) = self.claude.iter_mut().find(|s| s.slug == slug) else {
            return;
        };
        let name = s.name.clone();
        let mut log: Option<AgentEvent> = None;
        let turn_id = s
            .turns
            .iter()
            .find(|t| t.status == "running")
            .map(|t| t.id.clone());
        let base = AgentEvent {
            agent: slug.clone(),
            task_id: turn_id.clone(),
            ..Default::default()
        };
        fn running(s: &mut crate::claude::Session) -> Option<&mut Task> {
            s.turns.iter_mut().find(|t| t.status == "running")
        }
        let mut prompt = None;
        match ev {
            E::Init { model } => s.model = model.or(s.model.take()),
            E::Text(x) => {
                if let Some(t) = running(s) {
                    let r = t.response_message.get_or_insert_with(String::new);
                    if !r.is_empty() {
                        r.push_str("\n\n");
                    }
                    r.push_str(&x);
                }
            }
            E::ToolUse {
                name: tool,
                summary,
            } => {
                if let Some(t) = running(s) {
                    t.tools_used
                        .push(crate::claude::tool_entry(&tool, &summary));
                }
                s.activity = Some(format!("{tool} {summary}"));
                log = Some(AgentEvent {
                    status: Some("working".into()),
                    event: Some("tool_started".into()),
                    tool: Some(tool),
                    target: Some(summary),
                    ..base
                });
            }
            E::ToolResult { error: true, text } => {
                log = Some(AgentEvent {
                    status: Some("working".into()),
                    event: Some("tool_finished".into()),
                    activity: Some(format!("failed: {text}")),
                    ..base
                })
            }
            E::ToolResult { .. } => {}
            E::Permission(p) => {
                s.activity = Some(format!("waiting for you: {}", p.tool));
                log = Some(AgentEvent {
                    status: Some("waiting".into()),
                    event: Some("approval_requested".into()),
                    tool: Some(p.tool.clone()),
                    target: Some(crate::claude::summarize_input(&p.tool, &p.input)),
                    ..base
                });
                prompt = Some(p);
            }
            E::Done {
                text,
                error,
                cost,
                input,
                output,
                denials,
            } => {
                let interrupted = std::mem::take(&mut s.interrupting);
                s.cost_usd += cost;
                s.input_tokens += input;
                s.output_tokens += output;
                if let Some(t) = running(s) {
                    if t.response_message.as_deref().unwrap_or("").is_empty() {
                        t.response_message = text;
                    }
                    if denials > 0 {
                        t.error_message = Some(format!(
                            "{denials} action(s) were refused (permission mode {mode})"
                        ));
                    }
                    t.status = if interrupted {
                        "cancelled"
                    } else if error {
                        "failed"
                    } else {
                        "completed"
                    }
                    .into();
                    t.completed_at = Some(now);
                    t.duration_ms = t.started_at.map(|st| (now - st).num_milliseconds());
                    let (event, status) = match t.status.as_str() {
                        "completed" => ("completed", "idle"),
                        "cancelled" => ("stopped", "idle"),
                        _ => ("error", "error"),
                    };
                    log = Some(AgentEvent {
                        status: Some(status.into()),
                        event: Some(event.into()),
                        activity: t
                            .error_message
                            .clone()
                            .or_else(|| Some(crate::app::clip(&t.title(), 80))),
                        ..base
                    });
                    s.failed = t.status == "failed";
                }
                // Next queued message starts now.
                match s.turns.iter_mut().find(|t| t.status == "queued") {
                    Some(next) => {
                        next.status = "running".into();
                        next.started_at = Some(now);
                        s.activity = Some("thinking".into());
                    }
                    None => {
                        s.busy = false;
                        s.activity = None;
                    }
                }
            }
            E::Exit { ok, detail } => {
                s.input = None;
                s.busy = false;
                s.activity = None;
                let interrupted = std::mem::take(&mut s.interrupting) || detail == "stopped";
                for t in s.turns.iter_mut().filter(|t| t.is_open()) {
                    t.status = if interrupted { "cancelled" } else { "failed" }.into();
                    t.completed_at = Some(now);
                    if !detail.is_empty() && !interrupted {
                        t.error_message = Some(detail.clone());
                    }
                }
                s.failed = !ok && !interrupted && !detail.is_empty();
                if s.failed {
                    log = Some(AgentEvent {
                        status: Some("error".into()),
                        event: Some("error".into()),
                        activity: Some(detail),
                        ..base
                    });
                }
                self.claude_prompts.retain(|(sl, _)| sl != &slug);
            }
        }
        if let Some(p) = prompt {
            let question = p.is_question();
            self.claude_prompts.push((slug.clone(), p));
            if question && self.modal.is_none() && !self.chat.typing {
                self.open_question(self.claude_prompts.len() - 1);
            } else {
                let what = if question {
                    "has a question"
                } else {
                    "asks for permission"
                };
                self.error(format!("{name} {what}: press 4 and select it"));
            }
        }
        self.merge_local();
        if let Some(e) = log {
            self.on_event(e);
        }
    }

    pub fn open_question(&mut self, idx: usize) {
        self.modal = Some(Modal::Question {
            idx,
            q: 0,
            sel: 0,
            picked: Vec::new(),
            answers: Vec::new(),
            custom: String::new(),
        });
    }

    /// Answers prompt `idx`: allow (with an edited input) or deny.
    pub fn answer_prompt(&mut self, idx: usize, allow: Option<(serde_json::Value, bool)>) {
        if idx >= self.claude_prompts.len() {
            return;
        }
        let (slug, p) = self.claude_prompts.remove(idx);
        let line = match &allow {
            Some((input, always)) => crate::claude::allow_line(&p, input.clone(), *always),
            None => crate::claude::deny_line(&p, "The user denied this in opstui"),
        };
        let Some(s) = self.claude.iter_mut().find(|s| s.slug == slug) else {
            return;
        };
        let ok = s.write(line);
        if ok {
            s.activity = Some(if allow.is_some() {
                format!("{} allowed", p.tool)
            } else {
                format!("{} denied", p.tool)
            });
        }
        let name = s.name.clone();
        let left = self.pending_count();
        let rest = match left {
            0 => "nothing else is waiting".to_string(),
            n => format!("{n} more waiting"),
        };
        match (ok, allow.is_some()) {
            (false, _) => {
                self.notice_err(format!("{name} is no longer running; the request lapsed"))
            }
            (true, true) => self.info(format!("✔ Allowed {} for {name} · {rest}", p.tool)),
            (true, false) => self.info(format!("Denied {} for {name} · {rest}", p.tool)),
        }
        self.merge_local();
    }

    /// Stops running Claude processes; true if any was running.
    pub fn shutdown(&mut self) -> bool {
        let mut any = false;
        for s in &self.claude {
            if s.input.is_some() {
                s.cancel.notify_one();
                any = true;
            }
        }
        any
    }

    fn menu_action(&mut self, a: MenuAction) {
        self.modal = None;
        match a {
            MenuAction::NewClaude => self.new_claude(),
            MenuAction::Chat(slug) => {
                if let Some(i) = self.chat_agents().iter().position(|a| a.slug == slug) {
                    self.pick_agent(i);
                }
            }
            MenuAction::StopClaude(slug) => self.claude_stop(&slug),
            MenuAction::CloseClaude(slug) => {
                if let Some(s) = self.claude.iter().find(|s| s.slug == slug) {
                    if s.input.is_some() {
                        s.cancel.notify_one();
                    }
                    self.info(format!(
                        "{} closed; resume later with: claude --resume {}",
                        s.name, s.session_id
                    ));
                }
                self.claude.retain(|s| s.slug != slug);
                self.claude_prompts.retain(|(sl, _)| sl != &slug);
                if self.chat.agent.as_deref() == Some(&slug) {
                    self.chat.agent = None;
                    self.chat.msgs.clear();
                    self.chat.typing = false;
                }
                self.merge_local();
            }
        }
    }

    fn open_menu(&mut self, x: u16, y: u16) {
        let mut items = vec![("＋ New Claude agent".to_string(), MenuAction::NewClaude)];
        if let Some(a) = self
            .selected_agent()
            .filter(|_| matches!(self.view, View::Dashboard | View::Agents | View::Floor))
        {
            if a.enabled && (a.runtime == "native" || a.runtime == crate::claude::RUNTIME) {
                items.push((
                    format!("✉ Chat with {}", a.name),
                    MenuAction::Chat(a.slug.clone()),
                ));
            }
            if let Some(s) = self.claude_session(&a.slug) {
                if s.busy {
                    items.push((
                        format!("■ Stop {}", s.name),
                        MenuAction::StopClaude(s.slug.clone()),
                    ));
                }
                items.push((
                    format!("✕ Close {}", s.name),
                    MenuAction::CloseClaude(s.slug.clone()),
                ));
            }
        }
        self.modal = Some(Modal::Menu {
            x,
            y,
            items,
            sel: 0,
        });
    }

    pub fn board(&self, task_id: &str) -> Option<&Board> {
        self.boards.get(task_id).map(|(b, _)| b)
    }

    /// Task shown in the dashboard's "Active task" panel.
    pub fn dashboard_task(&self) -> Option<&Task> {
        let a = self.row_agent()?;
        self.active_task_of(&a.id)
    }

    // ------------------------------------------------------------ background

    fn start_session(&mut self, api: Arc<Api>) {
        let tx = self.tx.clone();
        let every = self.cfg.refresh_seconds;
        let host = self.cfg.metrics_host.clone();
        self.spawn(sync::poll(
            api.clone(),
            tx.clone(),
            self.poke.clone(),
            every,
            host,
        ));
        self.spawn(sync::stream(api.clone(), tx.clone(), self.poke.clone()));
        self.spawn(sync::keep_session(api, tx));
    }

    fn stop_session(&mut self) {
        for j in self.jobs.drain(..) {
            j.abort();
        }
        self.user = None;
        self.api = None;
        self.inflight.clear();
    }

    fn submit_login(&mut self) {
        let server = crate::config::normalize_server(&self.login.server);
        if server.is_empty()
            || self.login.username.trim().is_empty()
            || self.login.password.is_empty()
        {
            self.login.error = Some("Server, username and password are required".into());
            return;
        }
        let api = match Api::new(&server) {
            Ok(a) => Arc::new(a),
            Err(e) => {
                self.login.error = Some(e.to_string());
                return;
            }
        };
        self.login.server = server.clone();
        self.cfg.server = server;
        self.login.busy = true;
        self.login.error = None;
        self.api = Some(api.clone());
        let (u, p, tx) = (
            self.login.username.trim().to_string(),
            std::mem::take(&mut self.login.password),
            self.tx.clone(),
        );
        self.spawn(async move {
            let m = match api.login(&u, &p).await {
                Ok(t) => Msg::LoggedIn(t),
                Err(e) => Msg::LoginFailed(e.to_string()),
            };
            let _ = tx.send(m).await;
        });
    }

    pub fn run(&mut self, op: Op) {
        // Local Claude agents never go to the backend.
        match &op {
            Op::Ask { agent, message, .. } if self.claude_session(agent).is_some() => {
                return self.claude_send(&agent.clone(), message.clone());
            }
            Op::CancelTask { id } if id.starts_with("claude:") => {
                let slug = id.split(':').nth(1).unwrap_or("").to_string();
                return self.claude_stop(&slug);
            }
            Op::ResumeTask { id } if id.starts_with("claude:") => return,
            _ => {}
        }
        let Some(api) = self.api.clone() else { return };
        let (tx, poke) = (self.tx.clone(), self.poke.clone());
        self.info(format!("{} …", op.describe()));
        self.spawn(sync::execute(api, tx, poke, op));
    }

    fn fetch_board(&mut self, task_id: &str, max_age: Duration) {
        if task_id.starts_with("claude:") {
            return; // local turn: no backend board
        }
        let fresh = self
            .boards
            .get(task_id)
            .is_some_and(|(_, at)| at.elapsed() < max_age);
        let key = format!("board:{task_id}");
        if fresh || self.inflight.contains(&key) {
            return;
        }
        let Some(api) = self.api.clone() else { return };
        self.inflight.insert(key);
        let (tx, id) = (self.tx.clone(), task_id.to_string());
        self.spawn(sync::load_board(api, tx, id));
    }

    fn fetch_change(&mut self, id: &str, force: bool) {
        let same = self.change.as_ref().is_some_and(|c| c.summary.id == id);
        let fresh = same
            && self
                .change_at
                .is_some_and(|t| t.elapsed() < Duration::from_secs(30));
        let key = format!("change:{id}");
        if (!force && fresh) || self.inflight.contains(&key) {
            return;
        }
        let Some(api) = self.api.clone() else { return };
        self.inflight.insert(key);
        let admin = self.role() == "admin";
        let (tx, id) = (self.tx.clone(), id.to_string());
        self.spawn(sync::load_change(api, tx, id, admin));
    }

    fn fetch_history(&mut self) {
        let Some(api) = self.api.clone() else { return };
        let (tx, q) = (self.tx.clone(), self.hist.query.clone());
        self.spawn(sync::load_history(api.clone(), tx.clone(), q));
        if self.role() == "admin" {
            self.spawn(sync::load_audit(api, tx));
        } else {
            self.hist.audit = Some(Err("The audit log is visible to administrators only".into()));
        }
    }

    fn open_chat(&mut self, agent: &str, key: Option<String>) {
        self.chat.agent = Some(agent.to_string());
        self.chat.key = None;
        self.chat.msgs.clear();
        self.chat.scroll = 0;
        let Some(api) = self.api.clone() else { return };
        self.chat.loading = true;
        let tx = self.tx.clone();
        self.spawn(sync::load_chat(api, tx, agent.to_string(), key));
    }

    /// Keeps detail panes current; called after input and data changes.
    pub fn refresh_details(&mut self) {
        if !self.signed_in() {
            return;
        }
        let task = match self.view {
            View::Dashboard => self.dashboard_task().map(|t| (t.id.clone(), t.is_open())),
            View::Tasks => self.selected_task().map(|t| (t.id.clone(), t.is_open())),
            _ => None,
        };
        if let Some((id, open)) = task {
            self.fetch_board(&id, Duration::from_secs(if open { 5 } else { 3600 }));
        }
        if matches!(self.view, View::Dashboard | View::Approvals) {
            if let Some(ApprovalRef::Change(i)) = self.selected_approval() {
                let id = self.changes[i].id.clone();
                self.fetch_change(&id, false);
            }
        }
        if self.view == View::Logs
            && self.log.traffic
            && self
                .traffic_at
                .is_none_or(|t| t.elapsed() > Duration::from_secs(10))
        {
            if let Some(api) = self.api.clone() {
                self.traffic_at = Some(Instant::now());
                let tx = self.tx.clone();
                self.spawn(sync::load_traffic(api, tx));
            }
        }
    }

    // ------------------------------------------------------------ messages

    pub fn on_msg(&mut self, msg: Msg) {
        match msg {
            Msg::LoggedIn(t) => {
                tracing::info!(user = %t.username, role = %t.role, "signed in");
                self.login.busy = false;
                self.login.error = None;
                self.user = Some(t);
                if let Some(api) = self.api.clone() {
                    self.start_session(api);
                }
            }
            Msg::LoginFailed(e) => {
                self.login.busy = false;
                self.login.error = Some(e);
                self.login.field = 2;
                self.api = None;
            }
            Msg::SessionExpired(e) => {
                if self.signed_in() {
                    self.stop_session();
                    self.login.error = Some(format!("Session ended ({e}). Sign in again."));
                    self.login.field = 2;
                }
            }
            Msg::Snapshot(s) => {
                if let Some(a) = s.agents {
                    self.agents = a;
                }
                if let Some(t) = s.tasks {
                    self.tasks = t;
                }
                if let Some(a) = s.actions {
                    self.actions = a;
                }
                if let Some(d) = s.dev {
                    self.changes = d.items;
                    self.can_decide = d.can_decide;
                }
                if let Some(p) = s.providers {
                    self.providers = p;
                }
                self.snapshot_errors = s.errors;
                self.merge_local();
                // Keep hiding a decided item only while the server still lists it as pending.
                let (actions, changes) = (&self.actions, &self.changes);
                self.decided.retain(|id| {
                    actions.iter().any(|a| &a.id == id)
                        || changes
                            .iter()
                            .any(|c| &c.id == id && c.stage != "approved" && c.stage != "rejected")
                });
                self.last_snapshot = Some(Utc::now());
            }
            Msg::Metrics(r) => {
                self.metrics_seen = true;
                self.resources = r;
            }
            Msg::Health(h) => self.health = h,
            Msg::Usage(u) => {
                self.usage_seen = true;
                self.usage = u;
            }
            Msg::Event(ev) => self.on_event(ev),
            Msg::Conn(c) => self.conn = c,
            Msg::Board(id, b) => {
                self.inflight.remove(&format!("board:{id}"));
                self.boards.insert(id, (b, Instant::now()));
                if self.boards.len() > 200 {
                    let oldest = self
                        .boards
                        .iter()
                        .min_by_key(|(_, (_, at))| *at)
                        .map(|(k, _)| k.clone());
                    if let Some(k) = oldest {
                        self.boards.remove(&k);
                    }
                }
            }
            Msg::Change(d) => {
                self.inflight.remove(&format!("change:{}", d.summary.id));
                // A new patch revision invalidates the diff already on screen.
                let stale = self
                    .patches
                    .get(&d.summary.id)
                    .and_then(|p| p.as_ref().ok())
                    .map(|p| sha256_hex(p));
                if stale.is_some() && stale != d.summary.patch_sha256 {
                    self.patches.remove(&d.summary.id);
                }
                self.change = Some(*d);
                self.change_at = Some(Instant::now());
            }
            Msg::Patch(id, p) => {
                self.patches.insert(id, p);
            }
            Msg::History(p) => {
                self.hist.page = Some(p);
            }
            Msg::Audit(a) => self.hist.audit = Some(a),
            Msg::Traffic(t) => self.traffic = Some(t),
            Msg::ChatHistory(agent, key, msgs) => {
                if self.chat.agent.as_deref() == Some(&agent) {
                    self.chat.key = Some(key);
                    self.chat.msgs = msgs;
                    self.chat.loading = false;
                }
            }
            Msg::ChatTask(t) => {
                if t.conversation_key.is_some() && t.conversation_key == self.chat.key {
                    match self.chat.msgs.iter_mut().find(|m| m.id == t.id) {
                        Some(m) => *m = t,
                        None => self.chat.msgs.push(t),
                    }
                }
            }
            Msg::OpDone(op, m) => {
                tracing::info!("{m}");
                match op.decision() {
                    Some((id, label)) => {
                        // Gone from the list at once; the next snapshot confirms it.
                        self.decided.insert(id.to_string());
                        let n = self.pending_count();
                        let rest = match n {
                            0 => "✔ Nothing else is waiting for approval.".to_string(),
                            1 => "1 more item is waiting for approval (press 4 to review)."
                                .to_string(),
                            n => format!(
                                "{n} more items are waiting for approval (press 4 to review)."
                            ),
                        };
                        self.notice(
                            label,
                            vec![op.describe(), String::new(), m.clone(), String::new(), rest],
                            true,
                        );
                        self.info(m);
                    }
                    None => self.info(m),
                }
                if let Some(c) = self.change.as_ref().map(|c| c.summary.id.clone()) {
                    self.fetch_change(&c, true);
                }
            }
            Msg::OpFailed(op, e) => {
                if e.needs_reauth() {
                    self.modal = Some(Modal::Password {
                        op,
                        buf: String::new(),
                        error: None,
                        busy: false,
                    });
                } else if let Some(Modal::Password {
                    op: pop,
                    error,
                    busy,
                    ..
                }) = &mut self.modal
                {
                    if *pop == op {
                        *busy = false;
                        *error = Some(e.to_string());
                    }
                } else if op.decision().is_some() {
                    self.notice(
                        "Not done",
                        vec![
                            op.describe(),
                            String::new(),
                            format!("The backend refused: {e}"),
                        ],
                        false,
                    );
                } else {
                    self.error(format!("{} failed: {e}", op.describe()));
                }
            }
            Msg::Reauthed(op) => {
                self.modal = None;
                self.run(*op);
            }
            Msg::Claude(slug, ev) => self.on_claude(slug, ev),
            Msg::Error(e) => {
                if e.starts_with("task board: ") {
                    self.inflight.retain(|k| !k.starts_with("board:"));
                }
                if e.starts_with("change detail: ") {
                    self.inflight.retain(|k| !k.starts_with("change:"));
                }
                self.error(e);
            }
        }
        self.refresh_details();
    }

    fn on_event(&mut self, ev: AgentEvent) {
        let mut changed = true;
        if let Some(a) = self.agents.iter_mut().find(|a| a.slug == ev.agent) {
            if let Some(s) = &ev.status {
                // The stream replays every agent's state on (re)connect; an
                // unchanged state is not new activity.
                changed = ev.event.is_some() || a.status != *s || a.current_task != ev.activity;
                a.status = s.clone();
                a.current_task = ev.activity.clone();
                if s == "error" {
                    a.error_message = ev.activity.clone();
                }
                a.last_activity_at = Some(Utc::now());
            }
        }
        if !changed {
            return;
        }
        if self.agents.iter().any(|a| a.slug == ev.agent) {
            self.live.insert(
                ev.agent.clone(),
                crate::floor::Live::from_event(&ev, Instant::now()),
            );
        }
        self.seq += 1;
        let at = ev.ts.unwrap_or_else(Utc::now);
        self.events.push_back(Logged {
            seq: self.seq,
            at,
            ev,
        });
        while self.events.len() > EVENT_CAP {
            self.events.pop_front();
        }
    }

    pub fn on_tick(&mut self) {
        if self
            .flash
            .as_ref()
            .is_some_and(|(_, err, t)| t.elapsed() > Duration::from_secs(if *err { 12 } else { 6 }))
        {
            self.flash = None;
        }
        self.refresh_details();
    }

    // ------------------------------------------------------------ input

    pub fn on_term(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            Event::Mouse(m) => self.on_mouse(m.kind, m.column, m.row),
            Event::Paste(s) => self.on_paste(&s),
            _ => {}
        }
        self.refresh_details();
    }

    fn text_target(&mut self) -> Option<&mut String> {
        if !self.signed_in() {
            return match self.login.field {
                0 => Some(&mut self.login.server),
                1 => Some(&mut self.login.username),
                _ => Some(&mut self.login.password),
            };
        }
        match &mut self.modal {
            Some(Modal::Confirm {
                typed,
                word: Some(_),
                ..
            }) => return Some(typed),
            Some(Modal::Question { custom, .. }) => return Some(custom),
            Some(Modal::Password { buf, .. })
            | Some(Modal::Input { buf, .. })
            | Some(Modal::NewTask { buf, .. }) => return Some(buf),
            Some(_) => return None,
            None => {}
        }
        if let Some(s) = &mut self.search {
            return Some(s);
        }
        if self.chat.typing {
            return Some(&mut self.chat.input);
        }
        None
    }

    fn on_paste(&mut self, s: &str) {
        let multiline = (self.chat.typing && self.modal.is_none())
            || matches!(self.modal, Some(Modal::NewTask { .. }));
        if let Some(t) = self.text_target() {
            let clean: String = s
                .chars()
                .filter(|c| !c.is_control() || (*c == '\n' && multiline))
                .collect();
            t.push_str(&clean);
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        if !self.signed_in() {
            return self.login_key(k);
        }
        if self.modal.is_some() {
            return self.modal_key(k);
        }
        if self.search.is_some() {
            return self.search_key(k);
        }
        if self.chat.typing {
            return self.chat_key(k);
        }
        match k.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('?') => self.modal = Some(Modal::Help),
            KeyCode::Char(c @ '1'..='9') => self.goto(View::ALL[(c as u8 - b'1') as usize]),
            KeyCode::Tab => self.focus = (self.focus + 1) % self.view.panels(),
            KeyCode::BackTab => {
                self.focus = (self.focus + self.view.panels() - 1) % self.view.panels()
            }
            KeyCode::Char('/') if self.view != View::Settings => {
                self.search = Some(self.current_query())
            }
            KeyCode::Esc => self.back(),
            KeyCode::Up if self.view == View::Floor => self.floor_step(0, -1),
            KeyCode::Down if self.view == View::Floor => self.floor_step(0, 1),
            KeyCode::Left if self.view == View::Floor => self.floor_step(-1, 0),
            KeyCode::Right if self.view == View::Floor => self.floor_step(1, 0),
            KeyCode::Up | KeyCode::Char('k') => self.move_sel(-1),
            KeyCode::Down | KeyCode::Char('j') => self.move_sel(1),
            KeyCode::PageUp => self.move_sel(-10),
            KeyCode::PageDown => self.move_sel(10),
            KeyCode::Home => self.move_sel(i32::MIN / 2),
            KeyCode::End => self.move_sel(i32::MAX / 2),
            _ => self.view_key(k),
        }
    }

    pub fn goto(&mut self, v: View) {
        if v != self.view {
            self.prev_view = self.view;
            self.view = v;
            self.focus = 0;
        }
        match v {
            View::History if self.hist.page.is_none() => self.fetch_history(),
            View::Chat if self.chat.agent.is_none() => {
                if let Some(slug) = self.default_chat_agent() {
                    self.select_chat_row(&slug);
                    self.open_chat(&slug, None);
                }
            }
            _ => {}
        }
    }

    /// The coordinator routes work to the other agents, so it is the default
    /// chat partner; otherwise the first agent that can take questions.
    pub fn default_chat_agent(&self) -> Option<String> {
        let agents = self.chat_agents();
        agents
            .iter()
            .find(|a| a.slug == "coordinator")
            .or(agents.first())
            .map(|a| a.slug.clone())
    }

    pub fn open_picker(&mut self) {
        let sel = self
            .chat
            .agent
            .as_ref()
            .and_then(|s| self.chat_agents().iter().position(|a| &a.slug == s))
            .unwrap_or(0);
        if self.chat_agents().is_empty() {
            self.error("No enabled Ops Center agent can take messages");
        } else {
            self.modal = Some(Modal::AgentPicker { sel });
        }
    }

    /// Switch the conversation to agent `i` of `chat_agents()` and keep typing.
    pub fn pick_agent(&mut self, i: usize) {
        self.modal = None;
        let Some(slug) = self.chat_agents().get(i).map(|a| a.slug.clone()) else {
            return;
        };
        self.pick_chat_agent(&slug);
    }

    /// Switch the conversation to `slug` and keep typing.
    fn pick_chat_agent(&mut self, slug: &str) {
        self.modal = None;
        if self.chat.agent.as_deref() != Some(slug) {
            self.open_chat(slug, None);
        }
        self.select_chat_row(slug);
        self.focus = if self.view == View::Dashboard { 4 } else { 1 };
        if !matches!(self.view, View::Dashboard | View::Chat) {
            self.goto(View::Chat);
            self.focus = 1;
        }
        self.chat.typing = true;
    }

    /// Type straight into the dashboard's chat panel.
    pub fn start_dashboard_chat(&mut self) {
        self.focus = 4;
        if self.chat.agent.is_none() {
            match self.default_chat_agent() {
                Some(slug) => self.open_chat(&slug, None),
                None => {
                    self.error("No enabled Ops Center agent can take messages");
                    return;
                }
            }
        }
        self.chat.typing = true;
    }

    fn back(&mut self) {
        if !self.current_query().is_empty() {
            self.set_query(String::new());
        } else if self.view == View::Floor && self.agent_filter != 0 {
            self.agent_filter = 0;
        } else if self.view == View::Logs && (self.log.agent.is_some() || self.log.task.is_some()) {
            self.log.agent = None;
            self.log.task = None;
        } else if self.view != View::Dashboard {
            let to = if self.prev_view == self.view {
                View::Dashboard
            } else {
                self.prev_view
            };
            self.view = to;
            self.prev_view = View::Dashboard;
            self.focus = 0;
        }
    }

    fn current_query(&self) -> String {
        match self.view {
            View::Agents | View::Dashboard | View::Floor => self.agent_query.clone(),
            View::Tasks => self.task_query.clone(),
            View::Logs => self.log.query.clone(),
            View::History => self.hist.query.clone(),
            _ => String::new(),
        }
    }

    fn set_query(&mut self, q: String) {
        match self.view {
            View::Agents | View::Dashboard | View::Floor => {
                self.agent_query = q;
                self.sel_agent = self.first_agent_row();
            }
            View::Tasks => {
                self.task_query = q;
                self.sel_task = 0;
            }
            View::Logs => self.log.query = q,
            View::History => {
                self.hist.query = q;
                self.hist.sel = 0;
                if self.hist.tab == 0 {
                    self.fetch_history();
                }
            }
            _ => {}
        }
    }

    fn search_key(&mut self, k: KeyEvent) {
        let Some(buf) = self.search.as_mut() else {
            return;
        };
        match k.code {
            KeyCode::Esc => self.search = None,
            KeyCode::Enter => {
                let q = self.search.take().unwrap_or_default();
                self.set_query(q.trim().to_string());
            }
            KeyCode::Backspace => {
                buf.pop();
            }
            KeyCode::Char(c) => buf.push(c),
            _ => {}
        }
    }

    fn login_key(&mut self, k: KeyEvent) {
        if self.login.busy {
            return;
        }
        let f = &mut self.login;
        match k.code {
            KeyCode::Esc => self.quit = true,
            KeyCode::Tab | KeyCode::Down => f.field = (f.field + 1) % 3,
            KeyCode::BackTab | KeyCode::Up => f.field = (f.field + 2) % 3,
            KeyCode::Enter if f.field < 2 => f.field += 1,
            KeyCode::Enter => self.submit_login(),
            KeyCode::Backspace => {
                if let Some(t) = self.text_target() {
                    t.pop();
                }
            }
            KeyCode::Char(c) => {
                if let Some(t) = self.text_target() {
                    t.push(c);
                }
            }
            _ => {}
        }
    }

    fn modal_key(&mut self, k: KeyEvent) {
        let Some(modal) = self.modal.as_mut() else {
            return;
        };
        match modal {
            Modal::Question {
                idx,
                q,
                sel,
                picked,
                answers,
                custom,
            } => {
                let Some(prompt) = self.claude_prompts.get(*idx).map(|(_, p)| p.clone()) else {
                    self.modal = None;
                    return;
                };
                let qs = prompt.questions();
                let Some(cur) = qs.get(*q) else {
                    self.modal = None;
                    return;
                };
                let n = cur.options.len();
                match k.code {
                    // Leaves it open in Approvals; Claude keeps waiting.
                    KeyCode::Esc => self.modal = None,
                    KeyCode::Up => *sel = sel.saturating_sub(1),
                    KeyCode::Down => *sel = (*sel + 1).min(n.saturating_sub(1)),
                    KeyCode::Char(' ') if cur.multi && custom.is_empty() => {
                        if let Some(p) = picked.iter().position(|x| x == sel) {
                            picked.remove(p);
                        } else {
                            picked.push(*sel);
                        }
                    }
                    KeyCode::Backspace => {
                        custom.pop();
                    }
                    KeyCode::Char(c) => custom.push(c),
                    KeyCode::Enter => {
                        let answer = if !custom.trim().is_empty() {
                            custom.trim().to_string()
                        } else if cur.multi && !picked.is_empty() {
                            picked
                                .iter()
                                .filter_map(|i| cur.options.get(*i))
                                .map(|o| o.0.clone())
                                .collect::<Vec<_>>()
                                .join(", ")
                        } else {
                            cur.options
                                .get(*sel)
                                .map(|o| o.0.clone())
                                .unwrap_or_default()
                        };
                        if answer.is_empty() {
                            return;
                        }
                        answers.push((cur.question.clone(), answer));
                        if *q + 1 < qs.len() {
                            *q += 1;
                            *sel = 0;
                            picked.clear();
                            custom.clear();
                        } else {
                            let (i, input) = (*idx, crate::claude::with_answers(&prompt, answers));
                            self.modal = None;
                            self.answer_prompt(i, Some((input, false)));
                        }
                    }
                    _ => {}
                }
            }
            Modal::Notice { .. } => self.modal = None,
            Modal::Menu { items, sel, .. } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Up | KeyCode::Char('k') => *sel = sel.saturating_sub(1),
                KeyCode::Down | KeyCode::Char('j') => {
                    *sel = (*sel + 1).min(items.len().saturating_sub(1))
                }
                KeyCode::Enter => {
                    if let Some((_, a)) = items.get(*sel).cloned() {
                        self.menu_action(a);
                    }
                }
                _ => {}
            },
            Modal::AgentPicker { sel } => {
                let n = self
                    .agents
                    .iter()
                    .filter(|a| a.enabled && a.runtime == "native")
                    .count();
                match k.code {
                    KeyCode::Esc => self.modal = None,
                    KeyCode::Up | KeyCode::Char('k') | KeyCode::BackTab => {
                        *sel = sel.saturating_sub(1)
                    }
                    KeyCode::Down | KeyCode::Char('j') | KeyCode::Tab => {
                        *sel = (*sel + 1).min(n.saturating_sub(1))
                    }
                    KeyCode::Enter => {
                        let i = *sel;
                        self.pick_agent(i);
                    }
                    _ => {}
                }
            }
            Modal::Help => {
                if matches!(
                    k.code,
                    KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') | KeyCode::Enter
                ) {
                    self.modal = None;
                }
            }
            Modal::Text { scroll, lines, .. } => match k.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => self.modal = None,
                KeyCode::Down | KeyCode::Char('j') => {
                    *scroll = scroll.saturating_add(1).min(lines.len() as u16)
                }
                KeyCode::Up | KeyCode::Char('k') => *scroll = scroll.saturating_sub(1),
                KeyCode::PageDown | KeyCode::Char(' ') => {
                    *scroll = scroll.saturating_add(20).min(lines.len() as u16)
                }
                KeyCode::PageUp => *scroll = scroll.saturating_sub(20),
                KeyCode::Home => *scroll = 0,
                KeyCode::End => *scroll = lines.len().saturating_sub(10) as u16,
                _ => {}
            },
            Modal::Confirm { op, word, typed } => match (k.code, *word) {
                (KeyCode::Esc, _) | (KeyCode::Char('n'), None) => self.modal = None,
                (KeyCode::Char('y') | KeyCode::Enter, None) => {
                    let op = op.clone();
                    self.modal = None;
                    self.run(op);
                }
                (KeyCode::Enter, Some(w)) => {
                    if typed.trim() == w {
                        let op = op.clone();
                        self.modal = None;
                        self.run(op);
                    }
                }
                (KeyCode::Backspace, Some(_)) => {
                    typed.pop();
                }
                (KeyCode::Char(c), Some(_)) => typed.push(c),
                _ => {}
            },
            Modal::Password {
                op,
                buf,
                busy,
                error,
            } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter if !*busy && !buf.is_empty() => {
                    *busy = true;
                    *error = None;
                    let (op, pw) = (op.clone(), std::mem::take(buf));
                    if let Some(api) = self.api.clone() {
                        let tx = self.tx.clone();
                        self.spawn(sync::reauth_then(api, tx, pw, op));
                    }
                }
                KeyCode::Backspace => {
                    buf.pop();
                }
                KeyCode::Char(c) if !*busy => buf.push(c),
                _ => {}
            },
            Modal::Input { buf, purpose, .. } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter if !buf.trim().is_empty() => {
                    let text = buf.trim().to_string();
                    self.modal = Some(match purpose.clone() {
                        Purpose::RequestChanges { id, title, sha } => Modal::Confirm {
                            op: Op::ReviewPatch {
                                id,
                                title,
                                decision: "request_changes".into(),
                                sha,
                                comment: text,
                            },
                            word: None,
                            typed: String::new(),
                        },
                        Purpose::ReleaseRef { id, title } => Modal::Confirm {
                            op: Op::RecordRelease {
                                id,
                                title,
                                release_ref: text,
                            },
                            word: Some("release"),
                            typed: String::new(),
                        },
                    });
                }
                KeyCode::Backspace => {
                    buf.pop();
                }
                KeyCode::Char(c) => buf.push(c),
                _ => {}
            },
            Modal::NewTask { agent, buf } => {
                let n = self
                    .agents
                    .iter()
                    .filter(|a| a.enabled && a.runtime == "native")
                    .count()
                    .max(1);
                match k.code {
                    KeyCode::Esc => self.modal = None,
                    KeyCode::Tab | KeyCode::Right => *agent = (*agent + 1) % n,
                    KeyCode::BackTab | KeyCode::Left => *agent = (*agent + n - 1) % n,
                    KeyCode::Enter if k.modifiers.contains(KeyModifiers::ALT) => buf.push('\n'),
                    KeyCode::Enter if !buf.trim().is_empty() => {
                        let (i, text) = (*agent, buf.trim().to_string());
                        self.modal = None;
                        if let Some(slug) = self.chat_agents().get(i).map(|a| a.slug.clone()) {
                            // A task is a fresh conversation, so it does not mix into a chat.
                            let key = sync::new_conversation_key(&slug);
                            self.run(Op::Ask {
                                agent: slug,
                                message: text,
                                conversation_key: key,
                            });
                        }
                    }
                    KeyCode::Backspace => {
                        buf.pop();
                    }
                    KeyCode::Char(c) => buf.push(c),
                    _ => {}
                }
            }
        }
    }

    fn chat_key(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc => self.chat.typing = false,
            KeyCode::Tab | KeyCode::BackTab => self.open_picker(),
            KeyCode::Enter if k.modifiers.contains(KeyModifiers::ALT) => self.chat.input.push('\n'),
            KeyCode::Enter => self.send_chat(),
            KeyCode::Backspace => {
                self.chat.input.pop();
            }
            KeyCode::Char(c) => self.chat.input.push(c),
            KeyCode::PageUp => self.chat.scroll = self.chat.scroll.saturating_add(5),
            KeyCode::PageDown => self.chat.scroll = self.chat.scroll.saturating_sub(5),
            _ => {}
        }
    }

    fn send_chat(&mut self) {
        let text = self.chat.input.trim().to_string();
        let Some(agent) = self.chat.agent.clone() else {
            self.error("No agent selected");
            return;
        };
        if text.is_empty() {
            return;
        }
        // History may still be loading: start a conversation rather than drop the message.
        let key = self
            .chat
            .key
            .get_or_insert_with(|| sync::new_conversation_key(&agent))
            .clone();
        self.chat.loading = false;
        if text.chars().count() > 4000 {
            self.error("Messages are limited to 4000 characters");
            return;
        }
        self.chat.input.clear();
        self.chat.scroll = 0;
        self.run(Op::Ask {
            agent,
            message: text,
            conversation_key: key,
        });
    }

    fn move_sel(&mut self, d: i32) {
        fn mv(sel: &mut usize, len: usize, d: i32) {
            let max = len.saturating_sub(1) as i64;
            *sel = (*sel as i64 + d as i64).clamp(0, max.max(0)) as usize;
        }
        match (self.view, self.focus) {
            (View::Dashboard, 0) | (View::Agents, _) => {
                let n = self.agent_rows().len();
                mv(&mut self.sel_agent, n, d)
            }
            (View::Dashboard, 1) | (View::Logs, _) => {
                if self.view == View::Logs && self.log.traffic {
                    return;
                }
                let n = self.visible_events().len();
                self.log.follow = false;
                mv(&mut self.log.sel, n, d);
                if self.log.sel + 1 >= n {
                    self.log.follow = true;
                }
            }
            (View::Dashboard, 2) | (View::Approvals, _) => {
                self.pin_approval();
                let before = self.sel_approval;
                let v = self.approvals();
                mv(&mut self.sel_approval, v.len(), d);
                self.sel_approval_key = v.get(self.sel_approval).map(|r| self.approval_id(*r));
                if before != self.sel_approval {
                    self.detail_tab = DetailTab::Diff;
                }
            }
            (View::Dashboard, 3) => {
                let n = self.queue().len();
                mv(&mut self.sel_queue, n, d)
            }
            (View::Tasks, _) => {
                let n = self.task_list().len();
                mv(&mut self.sel_task, n, d)
            }
            (View::Chat, 0) => {
                let n = self.chat_rows().len();
                mv(&mut self.chat.sel, n, d)
            }
            (View::Chat, _) => {
                self.chat.scroll = (self.chat.scroll as i32 - d).clamp(0, 10_000) as u16
            }
            (View::History, _) => {
                let n = self.hist_len();
                mv(&mut self.hist.sel, n, d)
            }
            (View::Floor, _) => {
                let f = self.floor();
                let order = f.order();
                let at = self
                    .floor_selected(&f)
                    .and_then(|i| order.iter().position(|x| *x == i))
                    .unwrap_or(0);
                let mut sel = at;
                mv(&mut sel, order.len(), d);
                self.floor_sel = order.get(sel).map(|i| f.agents[*i].slug.clone());
            }
            _ => {}
        }
    }

    pub fn hist_len(&self) -> usize {
        self.hist_rows().len()
    }

    /// Indices of the rows shown in the current History tab (search applied;
    /// conversations are searched server-side).
    pub fn hist_rows(&self) -> Vec<usize> {
        let q = self.hist.query.to_lowercase();
        let m = |s: &str| q.is_empty() || s.to_lowercase().contains(&q);
        match self.hist.tab {
            0 => (0..self.hist.page.as_ref().map(|p| p.items.len()).unwrap_or(0)).collect(),
            1 => (0..self.tasks.len())
                .filter(|i| {
                    let t = &self.tasks[*i];
                    m(&t.input_message)
                        || m(&self.agent_name(&t.agent_id))
                        || m(&t.status)
                        || m(t.error_message.as_deref().unwrap_or(""))
                        || m(t.requested_by.as_deref().unwrap_or(""))
                        || t.tools_used.iter().any(|x| m(&x.to_string()))
                })
                .collect(),
            2 => (0..self.changes.len())
                .filter(|i| {
                    let c = &self.changes[*i];
                    m(&c.title)
                        || m(&c.stage)
                        || m(c.approved_by.as_deref().unwrap_or(""))
                        || m(c.release_ref.as_deref().unwrap_or(""))
                })
                .collect(),
            _ => match &self.hist.audit {
                Some(Ok(a)) => (0..a.len())
                    .filter(|i| {
                        let e = &a[*i];
                        m(e.user.as_deref().unwrap_or(""))
                            || m(&e.action)
                            || m(&e.target)
                            || m(&e.parameters.to_string())
                    })
                    .collect(),
                _ => Vec::new(),
            },
        }
    }

    fn view_key(&mut self, k: KeyEvent) {
        let KeyCode::Char(c) = k.code else {
            let agent_panel =
                self.view == View::Agents || (self.view == View::Dashboard && self.focus == 0);
            if k.code == KeyCode::Enter {
                self.enter();
            } else if agent_panel && matches!(k.code, KeyCode::Left | KeyCode::Right) {
                self.set_group_open(Some(k.code == KeyCode::Right));
            } else if self.view == View::Chat
                && self.focus == 0
                && matches!(k.code, KeyCode::Left | KeyCode::Right)
            {
                self.set_chat_group_open(Some(k.code == KeyCode::Right));
            } else if self.view == View::History && matches!(k.code, KeyCode::Left | KeyCode::Right)
            {
                let n = HIST_TABS.len();
                self.hist.tab = if k.code == KeyCode::Right {
                    (self.hist.tab + 1) % n
                } else {
                    (self.hist.tab + n - 1) % n
                };
                self.hist.sel = 0;
            }
            return;
        };
        // On the dashboard a/r/d/o act on the approval panel whatever has focus.
        let approvals_ctx = self.view == View::Approvals
            || (self.view == View::Dashboard && (self.focus == 2 || "ardoA".contains(c)));
        if approvals_ctx && c == 'A' {
            return match self.selected_approval() {
                Some(ApprovalRef::Prompt(i)) if !self.claude_prompts[i].1.is_question() => {
                    let input = self.claude_prompts[i].1.input.clone();
                    self.answer_prompt(i, Some((input, true)))
                }
                _ => self.notice_err("A (always allow) applies to Claude permission requests"),
            };
        }
        if approvals_ctx && "artdsocp".contains(c) {
            return self.approval_key(c);
        }
        match (self.view, c) {
            (View::Agents | View::Dashboard | View::Floor, 'f') => {
                self.agent_filter = (self.agent_filter + 1) % AGENT_FILTERS.len();
                self.sel_agent = self.first_agent_row();
            }
            (View::Agents | View::Dashboard | View::Floor, 'm') => {
                if let Some(slug) = self.selected_agent().map(|a| a.slug.clone()) {
                    self.goto(View::Chat);
                    self.select_chat_row(&slug);
                    self.open_chat(&slug, None);
                    self.chat.typing = true;
                }
            }
            (View::Agents | View::Dashboard | View::Floor | View::Tasks, 'n') => {
                let slug = if self.view == View::Tasks {
                    None
                } else {
                    self.selected_agent().map(|a| a.slug.clone())
                };
                let agent = slug
                    .and_then(|s| self.chat_agents().iter().position(|a| a.slug == s))
                    .unwrap_or(0);
                if self.chat_agents().is_empty() {
                    self.error("No enabled Ops Center agent can take tasks");
                } else {
                    self.modal = Some(Modal::NewTask {
                        agent,
                        buf: String::new(),
                    });
                }
            }
            (View::Agents | View::Dashboard | View::Floor, 'l') => {
                if let Some(slug) = self.selected_agent().map(|a| a.slug.clone()) {
                    self.log.agent = Some(slug);
                    self.log.task = None;
                    self.goto(View::Logs);
                }
            }
            (View::Agents | View::Dashboard | View::Floor, 'x') => {
                let id = self
                    .selected_agent()
                    .and_then(|a| self.active_task_of(&a.id))
                    .map(|t| t.id.clone());
                match id {
                    Some(id) => self.confirm(Op::CancelTask { id }, None),
                    None => self.error("This agent has no open task to stop"),
                }
            }
            (View::Dashboard, 'c') => self.start_dashboard_chat(),
            (View::Agents, 'h') => {
                if let Some(a) = self.selected_agent() {
                    self.task_query = a.name.to_lowercase();
                    self.sel_task = 0;
                    self.goto(View::Tasks);
                }
            }
            (View::Tasks, 'f') => {
                self.task_group = match self.task_group {
                    None => Some(TaskGroup::ALL[0]),
                    Some(g) => TaskGroup::ALL
                        .iter()
                        .position(|x| *x == g)
                        .and_then(|i| TaskGroup::ALL.get(i + 1))
                        .copied(),
                };
                self.sel_task = 0;
            }
            (View::Tasks, 'x') => {
                if let Some(t) = self.selected_task().filter(|t| t.is_open()) {
                    let id = t.id.clone();
                    self.confirm(Op::CancelTask { id }, None);
                }
            }
            (View::Tasks, 'R')
                if self
                    .selected_task()
                    .is_some_and(|t| t.id.starts_with("claude:")) =>
            {
                self.error(
                    "Local Claude turns continue in the same session: just send another message",
                )
            }
            (View::Dashboard | View::Agents | View::Chat | View::Floor, 'C') => self.new_claude(),
            (View::Floor, 'a') => self.floor_approvals(),
            (View::Tasks, 'R') => {
                let resumable = self
                    .selected_task()
                    .and_then(|t| self.board(&t.id).map(|b| (t.id.clone(), b.resumable)));
                match resumable {
                    Some((id, true)) => self.confirm(Op::ResumeTask { id }, None),
                    Some((_, false)) => {
                        self.error("The backend reports this task as not resumable")
                    }
                    None => self.error("Task board still loading"),
                }
            }
            (View::Tasks, 'l') => {
                if let Some(id) = self.selected_task().map(|t| t.id.clone()) {
                    self.log.task = Some(id);
                    self.log.agent = None;
                    self.goto(View::Logs);
                }
            }
            (View::Logs, ' ') => {
                self.log.paused_at = match self.log.paused_at {
                    Some(_) => None,
                    None => Some(self.seq),
                };
            }
            (View::Logs, 'F') => {
                self.log.follow = true;
                self.log.paused_at = None;
            }
            (View::Logs, 'e') => {
                self.log.min_sev = match self.log.min_sev {
                    Severity::Info => Severity::Warn,
                    Severity::Warn => Severity::Error,
                    Severity::Error => Severity::Info,
                };
            }
            (View::Logs, 'g') => {
                let mut slugs: Vec<String> = self.agents.iter().map(|a| a.slug.clone()).collect();
                slugs.sort();
                self.log.agent = match &self.log.agent {
                    None => slugs.first().cloned(),
                    Some(cur) => slugs
                        .iter()
                        .position(|s| s == cur)
                        .and_then(|i| slugs.get(i + 1))
                        .cloned(),
                };
            }
            (View::Logs, 'c') => {
                self.log.agent = None;
                self.log.task = None;
                self.log.query.clear();
                self.log.min_sev = Severity::Info;
            }
            (View::Logs, 't') => {
                self.log.traffic = !self.log.traffic;
                self.traffic_at = None;
            }
            (View::Chat, 'i') => self.chat.typing = true,
            (View::Chat, 'N') => {
                if let Some(slug) = self.chat.agent.clone() {
                    self.chat.key = Some(sync::new_conversation_key(&slug));
                    self.chat.msgs.clear();
                    self.info("New conversation");
                }
            }
            (View::History, 'r') => self.fetch_history(),
            (View::Settings, 'L') => {
                if let Some(api) = self.api.clone() {
                    tokio::spawn(async move { api.logout().await });
                }
                self.stop_session();
                self.login.error = Some("Signed out".into());
            }
            _ => {}
        }
    }

    fn confirm(&mut self, op: Op, word: Option<&'static str>) {
        self.modal = Some(Modal::Confirm {
            op,
            word,
            typed: String::new(),
        });
    }

    fn enter(&mut self) {
        let on_header = matches!(
            self.agent_rows().get(self.sel_agent),
            Some(AgentRow::Group { .. })
        );
        match (self.view, self.focus) {
            (View::Dashboard, 0) | (View::Agents, _) if on_header => self.set_group_open(None),
            (View::Dashboard, 0) => self.goto(View::Agents),
            (View::Dashboard, 1) | (View::Logs, _) => {
                let lines = self
                    .visible_events()
                    .get(self.log.sel)
                    .map(|l| event_lines(l));
                if let Some(lines) = lines {
                    self.modal = Some(Modal::Text {
                        title: "Event".into(),
                        lines,
                        diff: false,
                        scroll: 0,
                    });
                }
            }
            (View::Dashboard, 2) => self.goto(View::Approvals),
            (View::Dashboard, 3) => {
                let id = self.queue().get(self.sel_queue).map(|t| t.id.clone());
                self.goto(View::Tasks);
                if let Some(id) = id {
                    self.task_group = None;
                    self.task_query.clear();
                    if let Some(p) = self
                        .task_list()
                        .iter()
                        .position(|(_, i)| self.tasks[*i].id == id)
                    {
                        self.sel_task = p;
                    }
                }
            }
            (View::Dashboard, _) => self.start_dashboard_chat(),
            (View::Agents, _) => {
                let lines = self.selected_agent().map(|a| self.agent_lines(a));
                if let Some(lines) = lines {
                    self.modal = Some(Modal::Text {
                        title: "Agent".into(),
                        lines,
                        diff: false,
                        scroll: 0,
                    });
                }
            }
            (View::Tasks, _) => {
                let lines = self.selected_task().map(|t| self.task_lines(t));
                if let Some(lines) = lines {
                    self.modal = Some(Modal::Text {
                        title: "Task run log".into(),
                        lines,
                        diff: false,
                        scroll: 0,
                    });
                }
            }
            (View::Approvals, _) => self.approval_key('o'),
            (View::Floor, _) => {
                let waits = self.selected_agent().is_some_and(|a| {
                    self.floor()
                        .agents
                        .iter()
                        .any(|f| f.slug == a.slug && f.status == crate::floor::Status::Approval)
                });
                if waits {
                    return self.floor_approvals();
                }
                let lines = self.selected_agent().map(|a| self.agent_lines(a));
                if let Some(lines) = lines {
                    self.modal = Some(Modal::Text {
                        title: "Agent".into(),
                        lines,
                        diff: false,
                        scroll: 0,
                    });
                }
            }
            (View::Chat, 0) => {
                let on_header = matches!(
                    self.chat_rows().get(self.chat.sel),
                    Some(AgentRow::Group { .. })
                );
                if on_header {
                    return self.set_chat_group_open(None);
                }
                let slug = self.chat_row_agent().map(|a| a.slug.clone());
                if let Some(slug) = slug {
                    if self.chat.agent.as_deref() != Some(&slug) {
                        self.open_chat(&slug, None);
                    }
                    self.focus = 1;
                    self.chat.typing = true;
                }
            }
            (View::Chat, _) => self.chat.typing = true,
            (View::History, _) => {
                let lines = self.hist_lines();
                if let Some(lines) = lines {
                    self.modal = Some(Modal::Text {
                        title: HIST_TABS[self.hist.tab].into(),
                        lines,
                        diff: false,
                        scroll: 0,
                    });
                }
            }
            _ => {}
        }
    }

    fn approval_key(&mut self, c: char) {
        let Some(sel) = self.selected_approval() else {
            self.notice_err("Nothing is waiting for approval");
            return;
        };
        match sel {
            ApprovalRef::Prompt(i) => {
                let p = self.claude_prompts[i].1.clone();
                match c {
                    'a' if p.is_question() => self.open_question(i),
                    // Like answering the CLI's prompt: one key, no extra dialog.
                    'a' => self.answer_prompt(i, Some((p.input.clone(), false))),
                    'r' => self.answer_prompt(i, None),
                    'd' | 'o' | 's' | 't' => {
                        let mut lines = vec![format!("Tool:    {}", p.tool)];
                        if let Some(d) = &p.description {
                            lines.push(format!("Purpose: {d}"));
                        }
                        lines.push("Input (exactly what will run):".into());
                        lines.extend(
                            serde_json::to_string_pretty(&p.input)
                                .unwrap_or_default()
                                .lines()
                                .map(|l| format!("  {l}")),
                        );
                        lines.push(String::new());
                        lines.push("Suggested rule for \"always allow\" (A):".into());
                        lines.extend(
                            serde_json::to_string_pretty(&p.suggestions)
                                .unwrap_or_default()
                                .lines()
                                .map(|l| format!("  {l}")),
                        );
                        let title = format!("{} wants to use {}", self.claude_prompts[i].0, p.tool);
                        self.modal = Some(Modal::Text {
                            title,
                            lines,
                            diff: false,
                            scroll: 0,
                        });
                    }
                    _ => {}
                }
            }
            ApprovalRef::Action(i) => {
                let a = &self.actions[i];
                let (id, code) = (a.id.clone(), a.request_code.clone());
                match c {
                    'a' => {
                        // Level 3 actions change systems; type the word to confirm.
                        let word = (a.approval_level >= 3 || a.risk == "high").then_some("approve");
                        self.confirm(Op::ApproveAction { id, code }, word)
                    }
                    'r' => self.confirm(Op::RejectAction { id, code }, None),
                    'd' | 'o' | 's' | 't' => {
                        let lines = action_lines(a);
                        self.modal = Some(Modal::Text {
                            title: format!("Action {}", a.request_code),
                            lines,
                            diff: false,
                            scroll: 0,
                        });
                    }
                    _ => {}
                }
            }
            ApprovalRef::Change(i) => {
                let ch = self.changes[i].clone();
                let detail = self.change.as_ref().filter(|d| d.summary.id == ch.id);
                match c {
                    'd' => {
                        self.detail_tab = DetailTab::Diff;
                        match self.patches.get(&ch.id) {
                            Some(Ok(p)) => {
                                // Shown exactly as stored: what is approved must be what is seen.
                                let lines = p.lines().map(String::from).collect();
                                self.modal = Some(Modal::Text {
                                    title: format!("Diff – {}", ch.title),
                                    lines,
                                    diff: true,
                                    scroll: 0,
                                })
                            }
                            Some(Err(e)) => self.notice_err(format!("Patch unavailable: {e}")),
                            None if !ch.has_patch => {
                                self.notice_err("This change has no finished patch yet")
                            }
                            None if self.role() != "admin" => {
                                self.notice_err("Reading patches requires the admin role")
                            }
                            None => self.notice_err("Patch still loading"),
                        }
                    }
                    't' => self.detail_tab = DetailTab::Tests,
                    's' => self.detail_tab = DetailTab::Security,
                    'o' => {
                        self.detail_tab = DetailTab::Details;
                        if let Some(d) = detail {
                            let lines = change_lines(d);
                            self.modal = Some(Modal::Text {
                                title: d.summary.title.clone(),
                                lines,
                                diff: false,
                                scroll: 0,
                            });
                        }
                    }
                    'a' => match ch.stage.as_str() {
                        "proposed" | "changes_requested" => self.confirm(
                            Op::ApproveDevelopment {
                                id: ch.id,
                                title: ch.title,
                            },
                            None,
                        ),
                        "ready_for_review" => {
                            // The approval names the SHA-256 of the exact patch on screen,
                            // and only if it is the one the backend currently stores.
                            let stored = detail.and_then(|d| d.summary.patch_sha256.clone());
                            let shown = self
                                .patches
                                .get(&ch.id)
                                .and_then(|p| p.as_ref().ok())
                                .map(|p| sha256_hex(p));
                            match (stored, shown) {
                                (Some(stored), Some(shown)) if stored == shown => self.confirm(
                                    Op::ReviewPatch {
                                        id: ch.id,
                                        title: ch.title,
                                        decision: "approve".into(),
                                        sha: Some(shown),
                                        comment: "Approved in opstui after reviewing the diff"
                                            .into(),
                                    },
                                    Some("approve"),
                                ),
                                (Some(_), Some(_)) => {
                                    self.patches.remove(&ch.id);
                                    self.fetch_change(&ch.id, true);
                                    self.notice_err("The patch changed since it was loaded; review the new diff")
                                }
                                _ => self.notice_err(
                                    "Load the change and its diff first (admin role required)",
                                ),
                            }
                        }
                        "approved" => self.notice_err(
                            "Already approved. Press p to record the production release",
                        ),
                        s => self.notice_err(format!("A change that is {s} cannot be approved")),
                    },
                    'r' => match ch.stage.as_str() {
                        "proposed" | "changes_requested" => self.confirm(
                            Op::RejectProposal {
                                id: ch.id,
                                title: ch.title,
                            },
                            None,
                        ),
                        _ => self.confirm(
                            Op::ReviewPatch {
                                id: ch.id,
                                title: ch.title,
                                decision: "reject".into(),
                                sha: detail.and_then(|d| d.summary.patch_sha256.clone()),
                                comment: "Rejected in opstui".into(),
                            },
                            Some("reject"),
                        ),
                    },
                    'c' if matches!(ch.stage.as_str(), "ready_for_review" | "approved") => {
                        let sha = detail.and_then(|d| d.summary.patch_sha256.clone());
                        self.modal = Some(Modal::Input {
                            title: "Request changes: what should change?".into(),
                            buf: String::new(),
                            purpose: Purpose::RequestChanges {
                                id: ch.id,
                                title: ch.title,
                                sha,
                            },
                        });
                    }
                    'p' if ch.stage == "approved" => {
                        self.modal = Some(Modal::Input {
                            title: "Record production release: commit, tag or release ref".into(),
                            buf: String::new(),
                            purpose: Purpose::ReleaseRef {
                                id: ch.id,
                                title: ch.title,
                            },
                        });
                    }
                    'c' | 'p' => {
                        self.notice_err(format!("Not available for a change that is {}", ch.stage))
                    }
                    _ => {}
                }
            }
        }
    }

    fn on_mouse(&mut self, kind: MouseEventKind, x: u16, y: u16) {
        if let Some(Modal::Menu {
            x: mx,
            y: my,
            items,
            sel,
        }) = &mut self.modal
        {
            let r = crate::ui::menu_rect(self.screen, *mx, *my, items);
            let inside = r.contains(Position { x, y });
            let row = y.wrapping_sub(r.y + 1) as usize;
            match kind {
                MouseEventKind::Down(_) if inside && row < items.len() => {
                    let a = items[row].1.clone();
                    self.menu_action(a);
                }
                MouseEventKind::Down(_) if !inside => self.modal = None,
                MouseEventKind::Moved if inside && row < items.len() => *sel = row,
                _ => {}
            }
            return;
        }
        if kind == MouseEventKind::Down(MouseButton::Right)
            && self.signed_in()
            && self.modal.is_none()
        {
            // Right-click a row in an agent list selects it first.
            let p = Position { x, y };
            if matches!(self.view, View::Dashboard | View::Agents) {
                if let Some((r, 0)) = self.hit_panels.iter().find(|(r, _)| r.contains(p)).copied() {
                    let row = y.saturating_sub(r.y + 2) as usize;
                    if y >= r.y + 2 && row < self.agent_rows().len() {
                        self.sel_agent = row;
                        self.focus = 0;
                    }
                }
            }
            if self.view == View::Floor {
                if let Some((_, slug)) = self.hit_floor.iter().find(|(r, _)| r.contains(p)) {
                    self.floor_sel = Some(slug.clone());
                }
            }
            self.chat.typing = false;
            return self.open_menu(x, y);
        }
        if let Some(Modal::AgentPicker { sel }) = &mut self.modal {
            let n = self
                .agents
                .iter()
                .filter(|a| a.enabled && a.runtime == "native")
                .count();
            let r = crate::ui::picker_rect(self.screen, n);
            match kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    let row = y.wrapping_sub(r.y + 1) as usize;
                    if r.contains(Position { x, y }) && row < n {
                        self.pick_agent(row);
                    } else if !r.contains(Position { x, y }) {
                        self.modal = None;
                    }
                }
                MouseEventKind::ScrollDown => *sel = (*sel + 1).min(n.saturating_sub(1)),
                MouseEventKind::ScrollUp => *sel = sel.saturating_sub(1),
                _ => {}
            }
            return;
        }
        if !self.signed_in() || self.modal.is_some() {
            if let (Some(Modal::Text { scroll, .. }), MouseEventKind::ScrollDown) =
                (&mut self.modal, kind)
            {
                *scroll = scroll.saturating_add(3);
            } else if let (Some(Modal::Text { scroll, .. }), MouseEventKind::ScrollUp) =
                (&mut self.modal, kind)
            {
                *scroll = scroll.saturating_sub(3);
            }
            return;
        }
        let p = Position { x, y };
        match kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(i) = self.hit_tabs.iter().position(|r| r.contains(p)) {
                    self.chat.typing = false;
                    self.goto(View::ALL[i]);
                } else if self.view == View::Floor {
                    // Click a card to select it; click it again to open it.
                    let hit = self.hit_floor.iter().find(|(r, _)| r.contains(p));
                    if let Some((_, slug)) = hit {
                        if self.floor_sel.as_ref() == Some(slug) {
                            self.enter();
                        } else {
                            self.floor_sel = Some(slug.clone());
                        }
                    }
                } else if self.view == View::Dashboard
                    && self.hit_chat_header.is_some_and(|r| r.contains(p))
                {
                    self.open_picker();
                } else if let Some((r, 0)) = self
                    .hit_panels
                    .iter()
                    .find(|(r, _)| r.contains(p))
                    .copied()
                    .filter(|_| self.view == View::Chat)
                {
                    // Chat view agent list: click a name to talk to that agent.
                    let row = y.saturating_sub(r.y + 1) as usize;
                    match self.chat_rows().get(row).copied() {
                        Some(AgentRow::Agent(i)) => {
                            let slug = self.agents[i].slug.clone();
                            self.pick_chat_agent(&slug);
                        }
                        Some(AgentRow::Group { .. }) => {
                            self.focus = 0;
                            self.chat.sel = row;
                            self.set_chat_group_open(None);
                        }
                        None => {}
                    }
                } else if let Some((_, f)) = self.hit_panels.iter().find(|(r, _)| r.contains(p)) {
                    let f = *f;
                    self.focus = f;
                    // Clicking a chat starts typing; clicking elsewhere stops.
                    if self.view == View::Dashboard && f == 4 {
                        self.start_dashboard_chat();
                    } else if self.view == View::Chat && f == 1 {
                        self.chat.typing = self.chat.agent.is_some();
                    } else {
                        self.chat.typing = false;
                    }
                }
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                if let Some((_, f)) = self.hit_panels.iter().find(|(r, _)| r.contains(p)) {
                    self.focus = *f;
                }
                self.move_sel(if kind == MouseEventKind::ScrollDown {
                    1
                } else {
                    -1
                });
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------ detail text

    pub fn agent_lines(&self, a: &Agent) -> Vec<String> {
        if let Some(s) = self.claude_session(&a.slug) {
            let mut v = vec![
                format!("Name:         {} (local Claude Code agent)", s.name),
                format!("Status:       {}", s.status()),
                format!("Model:        {}", s.model.as_deref().unwrap_or("default")),
                format!("Directory:    {}", self.cfg.claude_dir),
                format!(
                    "Permissions:  {} (your Claude Code settings apply)",
                    self.cfg.claude_permission_mode
                ),
                format!("Session:      {}", s.session_id),
                format!("Resume:       claude --resume {}", s.session_id),
                format!(
                    "Usage:        {} in / {} out tokens, ${:.2}",
                    s.input_tokens, s.output_tokens, s.cost_usd
                ),
                format!("Activity:     {}", s.activity.as_deref().unwrap_or("-")),
                String::new(),
                "Turns:".into(),
            ];
            for t in &s.turns {
                v.push(format!(
                    "  {:<10} {}  {}",
                    t.status,
                    fmt_ts(t.created_at),
                    clip(&t.title(), 70)
                ));
            }
            v.push(String::new());
            v.push("Recent tool calls:".into());
            for l in self
                .events
                .iter()
                .rev()
                .filter(|l| l.ev.agent == a.slug)
                .take(20)
            {
                v.push(format!(
                    "  {} {}",
                    l.at.with_timezone(&chrono::Local).format("%H:%M:%S"),
                    l.ev.describe()
                ));
            }
            return v;
        }
        let mut v = vec![
            format!("Name:         {} ({})", a.name, a.slug),
            format!("ID:           {}", a.id),
            format!(
                "Status:       {}{}",
                a.status,
                if a.enabled { "" } else { " (disabled)" }
            ),
            format!(
                "Role:         {}",
                a.responsibility.as_deref().unwrap_or("-")
            ),
            format!("Description:  {}", a.description.as_deref().unwrap_or("-")),
            format!(
                "Model:        {} / {}",
                self.provider_name(a.provider_id.as_deref())
                    .unwrap_or_else(|| "-".into()),
                a.model.as_deref().unwrap_or("-")
            ),
            format!(
                "Runtime:      {}   autonomy level {}",
                a.runtime, a.autonomy_level
            ),
            format!(
                "Open tasks:   {} running, {} queued",
                a.running_tasks, a.queued_tasks
            ),
            format!(
                "Activity:     {}",
                crate::mask::mask(a.current_task.as_deref().unwrap_or("-"))
            ),
            format!("Last active:  {}", fmt_ts(a.last_activity_at)),
        ];
        if let Some(e) = &a.error_message {
            v.push(format!("Error:        {}", crate::mask::mask(e)));
        }
        v.push(format!("Tools:        {}", a.allowed_tools.join(", ")));
        v.push(String::new());
        v.push("Recent tasks:".into());
        for t in self.tasks.iter().filter(|t| t.agent_id == a.id).take(15) {
            v.push(format!(
                "  {} {:<10} {}  {}",
                sync::short(&t.id),
                t.status,
                fmt_ts(t.created_at),
                clip(&t.title(), 70)
            ));
        }
        v.push(String::new());
        v.push("Recent tool calls and events:".into());
        for l in self
            .events
            .iter()
            .rev()
            .filter(|l| l.ev.agent == a.slug)
            .take(20)
        {
            v.push(format!(
                "  {} {}",
                l.at.with_timezone(&chrono::Local).format("%H:%M:%S"),
                l.ev.describe()
            ));
        }
        v.push(String::new());
        v.push("Changes produced:".into());
        let produced: Vec<&Change> = self
            .changes
            .iter()
            .filter(|c| c.proposed_by.as_deref() == Some(&a.name) || a.slug == "developer")
            .take(10)
            .collect();
        if produced.is_empty() {
            v.push("  none recorded".into());
        }
        for c in produced {
            v.push(format!(
                "  {:<18} {} (+{} -{} in {} files)",
                c.stage,
                clip(&c.title, 50),
                c.added,
                c.removed,
                c.files
            ));
        }
        v
    }

    pub fn task_lines(&self, t: &Task) -> Vec<String> {
        let mut v = vec![
            format!("Task:        {}", t.id),
            format!("Agent:       {}", self.agent_name(&t.agent_id)),
            format!(
                "Status:      {}{}",
                t.status,
                t.outcome
                    .as_ref()
                    .map(|o| format!(" ({o})"))
                    .unwrap_or_default()
            ),
            format!(
                "Requested:   {} by {} via {}",
                fmt_ts(t.created_at),
                t.requested_by.as_deref().unwrap_or("-"),
                t.source
            ),
            format!(
                "Started:     {}   finished: {}",
                fmt_ts(t.started_at),
                fmt_ts(t.completed_at)
            ),
            format!(
                "Duration:    {}",
                t.elapsed_secs(Utc::now())
                    .map(fmt_dur)
                    .unwrap_or_else(|| "-".into())
            ),
            format!("Agents used: {}", t.agents_used.join(", ")),
            String::new(),
            "Request:".into(),
        ];
        v.extend(
            crate::mask::mask_lines(&t.input_message)
                .into_iter()
                .map(|l| format!("  {l}")),
        );
        if let Some(b) = self.board(&t.id) {
            v.push(String::new());
            v.push(match b.progress() {
                Some((d, n)) => format!("Work plan ({d}/{n} finished):"),
                None => "Work plan: none".into(),
            });
            for i in &b.items {
                v.push(format!(
                    "  [{:<20}] {} {}",
                    i.status,
                    i.agent.as_deref().unwrap_or(""),
                    i.title
                ));
            }
            for a in &b.actions {
                v.push(format!(
                    "  approval {} {} level {} – {}",
                    a.code, a.tool, a.level, a.status
                ));
            }
        }
        v.push(String::new());
        v.push(format!("Tool calls ({}):", t.tools_used.len()));
        for (n, call) in t.tools_used.iter().enumerate() {
            let tool = call.get("tool").and_then(|x| x.as_str()).unwrap_or("?");
            let args = call
                .get("arguments")
                .map(crate::mask::mask_json)
                .map(|a| a.to_string())
                .unwrap_or_default();
            v.push(format!("  {:>3}. {tool} {}", n + 1, clip(&args, 160)));
        }
        if let Some(e) = &t.error_message {
            v.push(String::new());
            v.push(format!("Error: {}", crate::mask::mask(e)));
        }
        if let Some(r) = &t.response_message {
            v.push(String::new());
            v.push("Response:".into());
            v.extend(
                crate::mask::mask_lines(r)
                    .into_iter()
                    .map(|l| format!("  {l}")),
            );
        }
        v.push(String::new());
        v.push("Live events for this task:".into());
        for l in self
            .events
            .iter()
            .filter(|l| l.ev.task_id.as_deref() == Some(&t.id))
        {
            v.push(format!(
                "  {} {:<12} {}",
                l.at.with_timezone(&chrono::Local).format("%H:%M:%S"),
                l.ev.agent,
                l.ev.describe()
            ));
        }
        v
    }

    fn hist_lines(&self) -> Option<Vec<String>> {
        let idx = *self.hist_rows().get(self.hist.sel)?;
        match self.hist.tab {
            0 => self
                .hist
                .page
                .as_ref()?
                .items
                .get(idx)
                .map(|i| self.task_lines(&i.task)),
            1 => self.tasks.get(idx).map(|t| self.task_lines(t)),
            2 => {
                let c = self.changes.get(idx)?;
                Some(vec![
                    format!("Change:     {}", c.title),
                    format!("Stage:      {}", c.stage),
                    format!(
                        "Proposed:   {} by {}",
                        fmt_ts(c.created_at),
                        c.proposed_by.as_deref().unwrap_or("-")
                    ),
                    format!(
                        "Approved:   {} by {}",
                        fmt_ts(c.approved_at),
                        c.approved_by.as_deref().unwrap_or("-")
                    ),
                    format!(
                        "Released:   {} ({})",
                        fmt_ts(c.finished_at),
                        c.release_ref.as_deref().unwrap_or("-")
                    ),
                    format!("Files:      {} (+{} -{})", c.files, c.added, c.removed),
                    format!("Branch:     {}", c.branch.as_deref().unwrap_or("-")),
                    format!("Patch hash: {}", c.patch_sha256.as_deref().unwrap_or("-")),
                    String::new(),
                    crate::mask::mask(&c.summary),
                ])
            }
            _ => {
                let a = self.hist.audit.as_ref()?.as_ref().ok()?.get(idx)?;
                let mut v = vec![
                    format!("When:   {}", fmt_ts(a.created_at)),
                    format!(
                        "User:   {}  from {}",
                        a.user.as_deref().unwrap_or("-"),
                        a.source_ip.as_deref().unwrap_or("-")
                    ),
                    format!("Action: {} {}", a.action, a.target),
                    format!("Result: {}", a.result),
                    "Parameters:".into(),
                ];
                v.extend(
                    serde_json::to_string_pretty(&crate::mask::mask_json(&a.parameters))
                        .unwrap_or_default()
                        .lines()
                        .map(|l| format!("  {l}")),
                );
                Some(v)
            }
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Counts {
    pub registered: usize,
    pub enabled: usize,
    pub working: usize,
    pub waiting: usize,
    pub errors: usize,
    /// Agents with at least one running task ("running agent instances").
    pub busy_agents: usize,
    pub running_tasks: usize,
    pub queued_tasks: usize,
}

pub fn event_lines(l: &Logged) -> Vec<String> {
    let e = &l.ev;
    let opt = |o: &Option<String>| {
        o.clone()
            .map(|s| crate::mask::mask(&s))
            .unwrap_or_else(|| "-".into())
    };
    vec![
        format!(
            "Time:     {}",
            l.at.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
        ),
        format!("Agent:    {}", e.agent),
        format!("Event:    {}", opt(&e.event)),
        format!("Status:   {}", opt(&e.status)),
        format!("Tool:     {}", opt(&e.tool)),
        format!("Target:   {}", opt(&e.target)),
        format!("Peer:     {}", opt(&e.peer)),
        format!("Task:     {}", opt(&e.task_id)),
        format!("Activity: {}", opt(&e.activity)),
    ]
}

pub fn action_lines(a: &Action) -> Vec<String> {
    let mut v = vec![
        format!("Request:   {}  ({})", a.request_code, a.id),
        format!("Action:    {}", a.action),
        format!("Tool:      {}", a.tool),
        format!(
            "Risk:      {}   approval level {}",
            a.risk, a.approval_level
        ),
        format!(
            "Reason:    {}",
            crate::mask::mask(a.reason.as_deref().unwrap_or("-"))
        ),
        format!(
            "Requested: {} by {} via {}",
            fmt_ts(a.requested_at),
            a.requested_by.as_deref().unwrap_or("-"),
            a.source
        ),
        format!("Expires:   {}", fmt_ts(a.expires_at)),
        format!("Task:      {}", a.task_id.as_deref().unwrap_or("-")),
        "Arguments:".into(),
    ];
    v.extend(
        serde_json::to_string_pretty(&crate::mask::mask_json(&a.arguments))
            .unwrap_or_default()
            .lines()
            .map(|l| format!("  {l}")),
    );
    v
}

pub fn change_lines(d: &ChangeDetail) -> Vec<String> {
    let s = &d.summary;
    let mut v = vec![
        format!("Change:      {}", s.title),
        format!("Stage:       {}   status {}", s.stage, s.status),
        format!("Proposed by: {}", s.proposed_by.as_deref().unwrap_or("-")),
        format!("Patch hash:  {}", s.patch_sha256.as_deref().unwrap_or("-")),
        format!("Branch:      {}", s.branch.as_deref().unwrap_or("-")),
        format!(
            "AI traffic:  {} recorded events for its runs",
            d.traffic_events
        ),
        String::new(),
        "Summary:".into(),
        format!("  {}", crate::mask::mask(&s.summary)),
    ];
    if let Some(n) = &d.notes {
        v.push("Notes:".into());
        v.extend(
            crate::mask::mask_lines(n)
                .into_iter()
                .map(|l| format!("  {l}")),
        );
    }
    v.push(String::new());
    v.push("Files:".into());
    for f in &d.files_changed {
        v.push(format!(
            "  {:<9} {:<6} +{:<4} -{:<4} {}",
            f.status, f.kind, f.added, f.removed, f.path
        ));
    }
    v.push(String::new());
    v.push("Checks:".into());
    for c in &d.checks {
        v.push(format!("  {:<8} {}: {}", c.result, c.name, c.detail));
    }
    v.push(String::new());
    v.push("Timeline:".into());
    for t in &d.timeline {
        v.push(format!("  {}  {}", fmt_ts(t.at), t.text));
    }
    v.push(String::new());
    v.push("Decisions:".into());
    for r in &d.reviews {
        v.push(format!(
            "  {} {:<16} by {} sha {}{}",
            fmt_ts(r.decided_at),
            r.decision,
            r.decided_by.as_deref().unwrap_or("-"),
            r.patch_sha256
                .as_deref()
                .map(|s| sync::prefix(s, 12))
                .unwrap_or("-"),
            r.comment
                .as_deref()
                .map(|c| format!(" – {}", crate::mask::mask(c)))
                .unwrap_or_default()
        ));
    }
    v
}

pub fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn fmt_ts(t: Ts) -> String {
    t.map(|t| {
        t.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    })
    .unwrap_or_else(|| "-".into())
}

pub fn fmt_dur(s: i64) -> String {
    match s {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m {:02}s", s / 60, s % 60),
        s => format!("{}h {:02}m", s / 3600, (s % 3600) / 60),
    }
}

pub fn clip(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        one.chars().take(n.saturating_sub(1)).collect::<String>() + "…"
    }
}

/// The configured default Claude agent, present from start. Its process
/// starts with the first message, so an unused agent costs nothing.
fn default_claude(name: &str) -> Vec<crate::claude::Session> {
    let name = name.trim();
    if name.is_empty() {
        return Vec::new();
    }
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    vec![crate::claude::Session::named(slug, name.to_string())]
}
