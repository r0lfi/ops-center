//! Ops Floor, 2D plan: the same rooms, seats, statuses and links as the web
//! page (frontend/src/lib/opsFloor/config.ts and model.ts). This module only
//! derives data; ui.rs draws it. Every value comes from the backend snapshot or
//! from live stream events: nothing is guessed.

use crate::model::{Agent, AgentEvent, Task};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub const WORLD_WIDTH: f64 = 1000.0;
pub const WORLD_HEIGHT: f64 = 600.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    pub id: &'static str,
    pub name: &'static str,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Seat {
    pub room: &'static str,
    pub x: f64,
    pub y: f64,
    pub short: Option<&'static str>,
    pub big: bool,
}

const fn room(id: &'static str, name: &'static str, x: f64, y: f64, w: f64, h: f64) -> Room {
    Room {
        id,
        name,
        x,
        y,
        w,
        h,
    }
}

pub const ROOMS: [Room; 6] = [
    room("observe", "Observe & run", 20.0, 20.0, 260.0, 350.0),
    room(
        "infrastructure",
        "Infrastructure",
        300.0,
        20.0,
        400.0,
        170.0,
    ),
    room("security", "Security", 720.0, 20.0, 260.0, 350.0),
    room("core", "Core", 300.0, 210.0, 400.0, 160.0),
    room("front", "Front desk", 20.0, 390.0, 470.0, 190.0),
    room("crew", "external crew", 510.0, 390.0, 470.0, 190.0),
];

/// Where everyone sits; keep in step with the web's `SEATS`.
pub fn fixed_seat(slug: &str) -> Option<Seat> {
    let seat = |room, x, y| Seat {
        room,
        x,
        y,
        short: None,
        big: false,
    };
    Some(match slug {
        "coordinator" => Seat {
            big: true,
            ..seat("core", 420.0, 285.0)
        },
        "developer" => Seat {
            short: Some("Developer"),
            ..seat("core", 625.0, 285.0)
        },
        "monitoring" => seat("observe", 150.0, 125.0),
        "automation" => seat("observe", 150.0, 280.0),
        "linux" => seat("infrastructure", 370.0, 115.0),
        "network" => seat("infrastructure", 500.0, 115.0),
        "container" => seat("infrastructure", 630.0, 115.0),
        "security" => seat("security", 850.0, 125.0),
        "patching" => seat("security", 850.0, 280.0),
        "chat" => seat("front", 105.0, 495.0),
        "general" => seat("front", 255.0, 495.0),
        "nova" => seat("front", 405.0, 495.0),
        "ext-coordinator" => Seat {
            short: Some("Lead"),
            ..seat("crew", 574.0, 495.0)
        },
        "ext-coder" => Seat {
            short: Some("Coder"),
            ..seat("crew", 688.0, 495.0)
        },
        "ext-reader" => Seat {
            short: Some("Reader"),
            ..seat("crew", 802.0, 495.0)
        },
        "ext-reviewer" => Seat {
            short: Some("Reviewer"),
            ..seat("crew", 916.0, 495.0)
        },
        _ => return None,
    })
}

const EXTRA_PER_ROW: usize = 8;
const EXTRA_ROW_HEIGHT: f64 = 190.0;

#[derive(Debug, Clone)]
pub struct Layout {
    pub rooms: Vec<Room>,
    pub seats: HashMap<String, Seat>,
    pub height: f64,
}

/// Fixed seats, then a row of rooms below the plan for local Claude agents and
/// for any agent nobody planned for, so nobody disappears.
pub fn layout(agents: &[Agent]) -> Layout {
    let mut rooms: Vec<Room> = ROOMS.to_vec();
    let mut seats = HashMap::new();
    let mut local: Vec<&str> = Vec::new();
    let mut other: Vec<&str> = Vec::new();
    for a in agents {
        match fixed_seat(&a.slug) {
            Some(s) => {
                seats.insert(a.slug.clone(), s);
            }
            None if a.runtime == crate::claude::RUNTIME => local.push(&a.slug),
            None => other.push(&a.slug),
        }
    }
    other.sort_unstable();
    let mut top = WORLD_HEIGHT;
    for (id, name, slugs) in [("local", "Local Claude", local), ("other", "Other", other)] {
        if slugs.is_empty() {
            continue;
        }
        let rows = slugs.len().div_ceil(EXTRA_PER_ROW);
        let cell = 960.0 / EXTRA_PER_ROW as f64;
        for (i, slug) in slugs.iter().enumerate() {
            let row = (i / EXTRA_PER_ROW) as f64;
            seats.insert(
                slug.to_string(),
                Seat {
                    room: id,
                    x: 20.0 + cell * ((i % EXTRA_PER_ROW) as f64 + 0.5),
                    y: top + EXTRA_ROW_HEIGHT * row + 105.0,
                    short: None,
                    big: false,
                },
            );
        }
        let h = EXTRA_ROW_HEIGHT * rows as f64;
        rooms.push(room(id, name, 20.0, top, 960.0, h));
        top += h;
    }
    Layout {
        rooms,
        seats,
        height: if top > WORLD_HEIGHT { top + 20.0 } else { top },
    }
}

/// The only statuses the floor knows. Every view and count uses these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    Error,
    Approval,
    Paused,
    Working,
    Idle,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Error => "Error",
            Status::Approval => "Needs approval",
            Status::Paused => "Paused",
            Status::Working => "Working",
            Status::Idle => "Idle",
        }
    }
}

/// Worst news first. "waiting" alone is not approval: an agent also waits on
/// the specialists it delegates to.
pub fn floor_status(a: &Agent, pending: usize) -> Status {
    let activity = a.current_task.as_deref().unwrap_or("");
    let st = a.status.as_str();
    let base = if st == "error" {
        Status::Error
    } else if pending > 0 || (st == "waiting" && activity.starts_with("Waiting for approval")) {
        Status::Approval
    } else if !a.enabled || st == "disabled" {
        Status::Paused
    } else if st == "waiting" || crate::app::is_working(st) {
        Status::Working
    } else {
        Status::Idle
    };
    // Running tasks are authoritative, as on the web floor.
    if base == Status::Idle && a.running_tasks > 0 {
        Status::Working
    } else {
        base
    }
}

/// How an agent looks right now, from a real event or the saved status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Motion {
    Idle,
    Paused,
    Busy,
    Starting,
    Tool,
    Thinking,
    Delegating,
    Reviewing,
    Action,
    Approval,
    Error,
    Completed,
}

impl Motion {
    pub fn label(self) -> &'static str {
        match self {
            Motion::Idle => "Idle",
            Motion::Paused => "Paused",
            Motion::Busy => "Working",
            Motion::Starting => "Starting a task",
            Motion::Tool => "Running a tool",
            Motion::Thinking => "Thinking",
            Motion::Delegating => "Delegating",
            Motion::Reviewing => "Reviewing results",
            Motion::Action => "Running an approved action",
            Motion::Approval => "Needs approval",
            Motion::Error => "Error",
            Motion::Completed => "Completed",
        }
    }
}

/// A finished task shows as completed this long before the agent settles.
pub const COMPLETED: Duration = Duration::from_secs(5);

/// The last live event of one agent.
#[derive(Debug, Clone)]
pub struct Live {
    pub event: Option<String>,
    pub peer: Option<String>,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub task_id: Option<String>,
    pub at: Instant,
}

impl Live {
    pub fn from_event(ev: &AgentEvent, at: Instant) -> Self {
        Live {
            event: ev.event.clone(),
            peer: ev.peer.clone(),
            tool: ev.tool.clone(),
            target: ev.target.clone(),
            task_id: ev.task_id.clone(),
            at,
        }
    }
}

pub fn motion_of(status: Status, live: Option<&Live>, now: Instant) -> Motion {
    match status {
        Status::Error => Motion::Error,
        Status::Approval => Motion::Approval,
        Status::Paused => Motion::Paused,
        Status::Idle => match live {
            Some(l)
                if l.event.as_deref() == Some("completed")
                    && now.saturating_duration_since(l.at) < COMPLETED =>
            {
                Motion::Completed
            }
            _ => Motion::Idle,
        },
        Status::Working => match live.and_then(|l| l.event.as_deref()) {
            Some("task_started") => Motion::Starting,
            Some("tool_started") => Motion::Tool,
            Some("tool_finished") => Motion::Thinking,
            Some("delegated") => Motion::Delegating,
            Some("returned") => Motion::Reviewing,
            Some("action_started") => Motion::Action,
            _ => Motion::Busy,
        },
    }
}

#[derive(Debug, Clone)]
pub struct FloorAgent {
    /// Index into `App::agents`.
    pub index: usize,
    pub slug: String,
    pub name: String,
    pub short: String,
    pub status: Status,
    pub motion: Motion,
    pub peer: Option<String>,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub task: Option<String>,
    pub running: i64,
    pub queued: i64,
    pub pending: usize,
    pub seat: Seat,
    pub room: &'static str,
}

impl FloorAgent {
    /// What the card's status line says.
    pub fn label(&self) -> &'static str {
        match self.motion {
            Motion::Completed => "Completed",
            Motion::Busy => self.status.label(),
            m if self.status == Status::Working => m.label(),
            _ => self.status.label(),
        }
    }

    /// What the card's second line says.
    pub fn detail(&self) -> String {
        if self.status == Status::Error {
            return "Failed. Enter for details".into();
        }
        if self.status == Status::Approval {
            return "Waiting for you".into();
        }
        if self.motion == Motion::Tool {
            if let Some(t) = &self.tool {
                return match &self.target {
                    Some(on) => format!("{t} on {on}"),
                    None => t.clone(),
                };
            }
        }
        match (&self.task, self.status) {
            (Some(t), _) => t.clone(),
            (None, Status::Paused) => "Paused".into(),
            (None, Status::Idle) => "Ready for the next task".into(),
            (None, _) => "Working".into(),
        }
    }
}

pub struct Floor {
    pub agents: Vec<FloorAgent>,
    pub layout: Layout,
}

/// `pending` counts open approvals per agent id.
pub fn build(
    agents: &[Agent],
    live: &HashMap<String, Live>,
    pending: &HashMap<String, usize>,
    now: Instant,
) -> Floor {
    let layout = layout(agents);
    let out = agents
        .iter()
        .enumerate()
        .map(|(index, a)| {
            let l = live.get(&a.slug);
            let pend = pending.get(&a.id).copied().unwrap_or(0);
            let status = floor_status(a, pend);
            let seat = layout.seats[&a.slug];
            let ev = l.and_then(|l| l.event.as_deref());
            let working = status == Status::Working;
            FloorAgent {
                index,
                slug: a.slug.clone(),
                name: a.name.clone(),
                short: seat.short.map_or_else(|| a.name.clone(), str::to_string),
                status,
                motion: motion_of(status, l, now),
                peer: l
                    .filter(|_| working && matches!(ev, Some("delegated" | "returned")))
                    .and_then(|l| l.peer.clone()),
                tool: l
                    .filter(|_| working && ev == Some("tool_started"))
                    .and_then(|l| l.tool.as_deref().map(crate::mask::mask)),
                // Stream text is masked like every other place it is shown.
                target: l.and_then(|l| l.target.as_deref().map(crate::mask::mask)),
                task: match status {
                    Status::Paused | Status::Idle => None,
                    _ => a
                        .current_task
                        .as_deref()
                        .filter(|t| !t.is_empty())
                        .map(crate::mask::mask),
                },
                running: a.running_tasks.max(0),
                queued: a.queued_tasks.max(0),
                pending: pend,
                seat,
                room: seat.room,
            }
        })
        .collect();
    Floor {
        agents: out,
        layout,
    }
}

impl Floor {
    /// Reading order: room by room, top to bottom, left to right.
    pub fn order(&self) -> Vec<usize> {
        let room_ix = |id: &str| self.layout.rooms.iter().position(|r| r.id == id);
        let mut v: Vec<usize> = (0..self.agents.len()).collect();
        v.sort_by(|a, b| {
            let (a, b) = (&self.agents[*a], &self.agents[*b]);
            room_ix(a.room)
                .cmp(&room_ix(b.room))
                .then(a.seat.y.total_cmp(&b.seat.y))
                .then(a.seat.x.total_cmp(&b.seat.x))
        });
        v
    }

    pub fn find(&self, slug: &str) -> Option<usize> {
        self.agents.iter().position(|a| a.slug == slug)
    }

    /// The nearest agent in a direction (dx, dy each -1, 0 or 1), measured
    /// on the plan. Agents straight ahead win over ones far to the side.
    pub fn nearest(&self, from: usize, dx: i32, dy: i32) -> Option<usize> {
        let o = self.agents.get(from)?.seat;
        self.agents
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != from)
            .filter_map(|(i, a)| {
                let (ex, ey) = (a.seat.x - o.x, a.seat.y - o.y);
                let (along, side) = if dx != 0 {
                    (ex * dx as f64, ey)
                } else {
                    (ey * dy as f64, ex)
                };
                (along > 1.0).then_some((i, along + side.abs() * 2.5))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }

    pub fn counts(&self) -> Counts {
        let n = |s: Status| self.agents.iter().filter(|a| a.status == s).count();
        Counts {
            needs: n(Status::Error) + self.agents.iter().map(|a| a.pending).sum::<usize>(),
            working: n(Status::Working),
            idle: n(Status::Idle),
            paused: n(Status::Paused),
            errors: n(Status::Error),
            queued: self.agents.iter().map(|a| a.queued as usize).sum(),
            running: self.agents.iter().map(|a| a.running as usize).sum(),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub needs: usize,
    pub working: usize,
    pub idle: usize,
    pub paused: usize,
    pub errors: usize,
    pub queued: usize,
    pub running: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Dim,
    Active,
    Approval,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub tone: Tone,
}

/// A delegation the configuration allows, or one a running task really made.
/// No targets on the Coordinator mean every enabled agent that is neither
/// personal nor external.
pub fn edges(agents: &[Agent], tasks: &[Task], floor: &[FloorAgent]) -> Vec<Edge> {
    let known: HashSet<&str> = agents.iter().map(|a| a.slug.as_str()).collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut add = |from: &str, to: &str| {
        if from != to
            && known.contains(from)
            && known.contains(to)
            && !pairs.iter().any(|(f, t)| f == from && t == to)
        {
            pairs.push((from.to_string(), to.to_string()));
        }
    };
    for a in agents {
        match &a.allowed_dispatch_targets {
            Some(t) => t.iter().for_each(|t| add(&a.slug, t)),
            None if a.slug == "coordinator" => agents
                .iter()
                .filter(|o| o.enabled && !o.personal && o.runtime != "external")
                .for_each(|o| add(&a.slug, &o.slug)),
            None => {}
        }
    }
    let mut running: HashSet<(String, String)> = HashSet::new();
    for t in tasks.iter().filter(|t| t.status == "running") {
        let Some(from) = agents.iter().find(|a| a.id == t.agent_id) else {
            continue;
        };
        for to in &t.agents_used {
            add(&from.slug, to);
            running.insert((from.slug.clone(), to.clone()));
        }
    }
    let status = |slug: &str| floor.iter().find(|a| a.slug == slug).map(|a| a.status);
    pairs
        .into_iter()
        .map(|(from, to)| {
            let tone = match status(&to) {
                Some(Status::Error) => Tone::Error,
                Some(Status::Approval) => Tone::Approval,
                _ if running.contains(&(from.clone(), to.clone())) => Tone::Active,
                _ => Tone::Dim,
            };
            Edge { from, to, tone }
        })
        .collect()
}

/// Work moving between two agents right now, only from published events:
/// out on `delegated`, back on `returned` (for a few seconds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flow {
    pub from: String,
    pub to: String,
    pub delegate: bool,
}

pub fn flows(floor: &[FloorAgent], live: &HashMap<String, Live>, now: Instant) -> Vec<Flow> {
    let known: HashSet<&str> = floor.iter().map(|a| a.slug.as_str()).collect();
    let mut out = Vec::new();
    for a in floor.iter().filter(|a| a.status == Status::Working) {
        let Some(l) = live.get(&a.slug) else { continue };
        let Some(peer) = l.peer.as_deref().filter(|p| known.contains(p)) else {
            continue;
        };
        match l.event.as_deref() {
            Some("delegated") => out.push(Flow {
                from: a.slug.clone(),
                to: peer.to_string(),
                delegate: true,
            }),
            Some("returned") if now.saturating_duration_since(l.at) < COMPLETED => out.push(Flow {
                from: peer.to_string(),
                to: a.slug.clone(),
                delegate: false,
            }),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(slug: &str, status: &str) -> Agent {
        Agent {
            id: format!("id-{slug}"),
            slug: slug.into(),
            name: slug.to_uppercase(),
            status: status.into(),
            enabled: true,
            runtime: "native".into(),
            ..Default::default()
        }
    }

    fn live(event: &str, peer: Option<&str>, at: Instant) -> Live {
        Live {
            event: Some(event.into()),
            peer: peer.map(Into::into),
            tool: Some("ssh".into()),
            target: None,
            task_id: None,
            at,
        }
    }

    #[test]
    fn status_is_worst_news_first() {
        let mut a = agent("linux", "waiting");
        assert_eq!(floor_status(&a, 0), Status::Working, "waiting on a peer");
        a.current_task = Some("Waiting for approval: reboot".into());
        assert_eq!(floor_status(&a, 0), Status::Approval);
        a.status = "idle".into();
        assert_eq!(floor_status(&a, 1), Status::Approval);
        a.status = "error".into();
        assert_eq!(floor_status(&a, 1), Status::Error);
        let mut b = agent("x", "idle");
        b.enabled = false;
        assert_eq!(floor_status(&b, 0), Status::Paused);
        let mut c = agent("y", "idle");
        c.running_tasks = 2;
        assert_eq!(floor_status(&c, 0), Status::Working);
    }

    #[test]
    fn motion_follows_the_last_event_and_completed_fades() {
        let now = Instant::now();
        let l = live("tool_started", None, now);
        assert_eq!(motion_of(Status::Working, Some(&l), now), Motion::Tool);
        assert_eq!(motion_of(Status::Working, None, now), Motion::Busy);
        let done = live("completed", None, now);
        assert_eq!(motion_of(Status::Idle, Some(&done), now), Motion::Completed);
        assert_eq!(
            motion_of(Status::Idle, Some(&done), now + Duration::from_secs(6)),
            Motion::Idle
        );
    }

    #[test]
    fn unknown_and_local_agents_get_their_own_rooms() {
        let mut local = agent("claude-1", "idle");
        local.runtime = crate::claude::RUNTIME.into();
        let agents = vec![agent("coordinator", "idle"), agent("zeta", "idle"), local];
        let l = layout(&agents);
        assert_eq!(l.seats["coordinator"].room, "core");
        assert_eq!(l.seats["zeta"].room, "other");
        assert_eq!(l.seats["claude-1"].room, "local");
        assert!(l.height > WORLD_HEIGHT);
        assert_eq!(l.rooms.len(), ROOMS.len() + 2);
    }

    #[test]
    fn links_come_from_configuration_and_running_tasks() {
        let mut coord = agent("coordinator", "working");
        coord.id = "c".into();
        let mut personal = agent("chat", "idle");
        personal.personal = true;
        let agents = vec![
            coord,
            agent("linux", "error"),
            personal,
            agent("network", "idle"),
        ];
        let f = build(&agents, &HashMap::new(), &HashMap::new(), Instant::now());
        let task = Task {
            id: "t".into(),
            agent_id: "c".into(),
            status: "running".into(),
            agents_used: vec!["network".into()],
            ..Default::default()
        };
        let e = edges(&agents, &[task], &f.agents);
        let tone = |to: &str| e.iter().find(|x| x.to == to).map(|x| x.tone);
        assert_eq!(tone("linux"), Some(Tone::Error));
        assert_eq!(tone("network"), Some(Tone::Active));
        assert_eq!(tone("chat"), None, "personal agents are not routed to");
    }

    #[test]
    fn flows_only_from_published_delegation() {
        let now = Instant::now();
        let agents = vec![agent("coordinator", "working"), agent("linux", "working")];
        let mut live_map = HashMap::new();
        live_map.insert(
            "coordinator".to_string(),
            live("delegated", Some("linux"), now),
        );
        let f = build(&agents, &live_map, &HashMap::new(), now);
        assert_eq!(f.agents[0].motion, Motion::Delegating);
        let fl = flows(&f.agents, &live_map, now);
        assert_eq!(
            fl,
            vec![Flow {
                from: "coordinator".into(),
                to: "linux".into(),
                delegate: true
            }]
        );
        live_map.insert("coordinator".into(), live("returned", Some("linux"), now));
        let late = now + Duration::from_secs(10);
        assert!(flows(&f.agents, &live_map, late).is_empty());
    }

    #[test]
    fn arrows_move_to_the_nearest_desk_in_that_direction() {
        let agents: Vec<Agent> = ["linux", "network", "container", "coordinator", "monitoring"]
            .iter()
            .map(|s| agent(s, "idle"))
            .collect();
        let f = build(&agents, &HashMap::new(), &HashMap::new(), Instant::now());
        let ix = |s: &str| f.find(s).unwrap();
        assert_eq!(f.nearest(ix("linux"), 1, 0), Some(ix("network")));
        assert_eq!(f.nearest(ix("network"), 0, 1), Some(ix("coordinator")));
        assert_eq!(f.nearest(ix("linux"), -1, 0), Some(ix("monitoring")));
        assert_eq!(f.nearest(ix("monitoring"), -1, 0), None);
        let order: Vec<&str> = f
            .order()
            .iter()
            .map(|i| f.agents[*i].slug.as_str())
            .collect();
        assert_eq!(
            order,
            ["monitoring", "linux", "network", "container", "coordinator"]
        );
    }
}
