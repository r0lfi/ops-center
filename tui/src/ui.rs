//! Rendering. Pure function of App state; ratatui diffs frames, so only
//! changed cells reach the terminal.

use crate::app::*;
use crate::model::*;
use crate::sync::{short, Conn};
use chrono::{Local, Utc};
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, BorderType, Borders, Cell, Clear, List, ListItem, ListState, Paragraph, Row, Sparkline,
    Table, TableState, Wrap,
};
use ratatui::Frame;

mod floor;

pub const BG: Color = Color::Rgb(8, 11, 22);
pub const PANEL: Color = Color::Rgb(11, 15, 30);
pub const BORDER: Color = Color::Rgb(34, 64, 120);
pub const ACCENT: Color = Color::Rgb(124, 92, 255);
pub const GREEN: Color = Color::Rgb(34, 197, 94);
pub const YELLOW: Color = Color::Rgb(234, 179, 8);
pub const RED: Color = Color::Rgb(239, 68, 68);
pub const BLUE: Color = Color::Rgb(59, 130, 246);
pub const CYAN: Color = Color::Rgb(56, 189, 248);
pub const TEXT: Color = Color::Rgb(220, 226, 240);
pub const DIM: Color = Color::Rgb(115, 125, 150);
pub const SEL: Color = Color::Rgb(36, 32, 82);
pub const KEY_BG: Color = Color::Rgb(36, 44, 68);

fn s(text: impl Into<String>, color: Color) -> Span<'static> {
    Span::styled(text.into(), Style::new().fg(color))
}

fn b(text: impl Into<String>, color: Color) -> Span<'static> {
    Span::styled(
        text.into(),
        Style::new().fg(color).add_modifier(Modifier::BOLD),
    )
}

pub fn status_color(status: &str) -> Color {
    match status {
        x if is_working(x) => GREEN,
        "completed" | "ok" | "passed" | "approved" | "executed" | "in_production" | "deployed" => {
            GREEN
        }
        "waiting" | "queued" | "pending" | "proposed" | "ready_for_review"
        | "changes_requested" | "warning" | "degraded" => YELLOW,
        "error" | "failed" | "rejected" | "rolled_back" | "expired" | "high" => RED,
        "idle" | "cancelled" | "disabled" | "not_run" => DIM,
        _ => BLUE,
    }
}

fn badge(label: &str, color: Color) -> Span<'static> {
    Span::styled(
        format!(" {} ", label.to_uppercase().replace('_', " ")),
        Style::new()
            .fg(Color::Rgb(10, 10, 16))
            .bg(color)
            .add_modifier(Modifier::BOLD),
    )
}

fn status_badge(status: &str) -> Span<'static> {
    badge(status, status_color(status))
}

fn panel(title: Line<'static>, focused: bool) -> Block<'static> {
    Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(if focused { ACCENT } else { BORDER }))
        .style(Style::new().bg(PANEL).fg(TEXT))
        .title(title)
}

fn title(icon: &str, text: impl Into<String>) -> Line<'static> {
    Line::from(vec![
        s(format!(" {icon} "), CYAN),
        b(text.into(), TEXT),
        Span::raw(" "),
    ])
}

fn time(t: chrono::DateTime<Utc>) -> String {
    t.with_timezone(&Local).format("%H:%M:%S").to_string()
}

fn ago(t: Ts) -> String {
    match t {
        Some(t) => {
            let s = (Utc::now() - t).num_seconds().max(0);
            if s < 60 {
                format!("{s}s ago")
            } else if s < 3600 {
                format!("{}m ago", s / 60)
            } else if s < 86400 {
                format!("{}h ago", s / 3600)
            } else {
                format!("{}d ago", s / 86400)
            }
        }
        None => "-".into(),
    }
}

fn header(cols: &[&str]) -> Row<'static> {
    Row::new(cols.iter().map(|c| Cell::from(c.to_string())))
        .style(Style::new().fg(DIM).add_modifier(Modifier::BOLD))
}

fn table_state(sel: usize, len: usize, focused: bool) -> TableState {
    TableState::default().with_selected((focused && len > 0).then_some(sel.min(len - 1)))
}

fn empty(area: Rect, f: &mut Frame, block: Block<'static>, msg: &str) {
    f.render_widget(
        Paragraph::new(Line::from(s(msg, DIM)))
            .block(block)
            .wrap(Wrap { trim: true }),
        area,
    );
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    f.render_widget(Block::new().style(Style::new().bg(BG).fg(TEXT)), area);
    app.hit_tabs.clear();
    app.hit_panels.clear();
    app.hit_chat_header = None;
    app.hit_floor.clear();
    app.pin_approval();
    app.screen = area;
    if !app.signed_in() {
        draw_login(f, app, area);
        return;
    }
    let [top, nav, body, usage, foot] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(5),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);
    draw_top(f, app, top);
    draw_nav(f, app, nav);
    match app.view {
        View::Dashboard => draw_dashboard(f, app, body),
        View::Agents => draw_agents(f, app, body),
        View::Tasks => draw_tasks(f, app, body),
        View::Approvals => draw_approvals(f, app, body),
        View::Logs => draw_logs(f, app, body),
        View::Chat => draw_chat(f, app, body),
        View::History => draw_history(f, app, body),
        View::Settings => draw_settings(f, app, body),
        View::Floor => floor::draw_floor(f, app, body),
    }
    draw_usage(f, app, usage);
    draw_footer(f, app, foot);
    if let Some(m) = &app.modal {
        draw_modal(f, app, m, area);
    }
}

fn draw_login(f: &mut Frame, app: &App, area: Rect) {
    let r = centered(area, 64, 14);
    let l = &app.login;
    let field = |i: usize, label: &str, value: String| {
        let focused = l.field == i;
        Line::from(vec![
            s(format!("  {label:<10}"), if focused { ACCENT } else { DIM }),
            Span::styled(
                format!(" {value}{} ", if focused { "█" } else { "" }),
                Style::new().fg(TEXT).bg(if focused { SEL } else { KEY_BG }),
            ),
        ])
    };
    let mut lines = vec![
        Line::from(vec![
            b(" ◉ OPS-CENTER", ACCENT),
            s("  AI Operations Terminal", DIM),
        ]),
        Line::default(),
        field(0, "Server", l.server.clone()),
        Line::default(),
        field(1, "Username", l.username.clone()),
        Line::default(),
        field(2, "Password", "•".repeat(l.password.chars().count())),
        Line::default(),
    ];
    if l.busy {
        lines.push(Line::from(s("  Signing in …", YELLOW)));
    } else if let Some(e) = &l.error {
        lines.push(Line::from(s(format!("  {e}"), RED)));
    } else {
        lines.push(Line::from(s(
            "  The password is kept in memory only for this sign-in.",
            DIM,
        )));
    }
    lines.push(Line::default());
    lines.push(Line::from(s(
        "  Tab next field · Enter sign in · Esc quit",
        DIM,
    )));
    f.render_widget(Clear, r);
    f.render_widget(
        Paragraph::new(lines)
            .block(panel(title("⏻", "Sign in"), true))
            .wrap(Wrap { trim: false }),
        r,
    );
}

fn draw_top(f: &mut Frame, app: &App, area: Rect) {
    let version = app
        .health
        .as_ref()
        .map(|h| format!("v{}", h.version))
        .unwrap_or_else(|| "v?".into());
    let left = Line::from(vec![
        b(" ◉ OPS-CENTER ", ACCENT),
        s(format!(" {version} "), DIM),
        s("│", BORDER),
        s(" AI Operations Terminal", TEXT),
    ]);
    let (conn, color) = match &app.conn {
        Conn::Live => ("● CONNECTED".to_string(), GREEN),
        Conn::Connecting => ("◌ CONNECTING".to_string(), YELLOW),
        Conn::Retrying(n, _) => (format!("✕ RECONNECTING in {n}s"), RED),
    };
    let user = app
        .user
        .as_ref()
        .map(|u| format!("{} ({})", u.username, u.role))
        .unwrap_or_default();
    let right = Line::from(vec![
        s(conn, color),
        Span::raw("  "),
        badge(&app.cfg.env_label(), YELLOW),
        s(" │ ", BORDER),
        s(format!("{} agents", app.agents.len()), TEXT),
        s(" │ ", BORDER),
        s(user, DIM),
        s(" │ ", BORDER),
        b(Local::now().format("%H:%M:%S ").to_string(), TEXT),
    ])
    .alignment(Alignment::Right);
    f.render_widget(Paragraph::new(left).style(Style::new().bg(BG)), area);
    if area.width > 90 {
        f.render_widget(Paragraph::new(right), area);
    }
}

fn draw_nav(f: &mut Frame, app: &mut App, area: Rect) {
    let pending = app.pending_count();
    let mut x = area.x;
    let mut spans = Vec::new();
    let full: usize = VIEWS
        .iter()
        .enumerate()
        .map(|(i, n)| format!(" [{}] {} ", i + 1, n).chars().count() + 1)
        .sum::<usize>()
        + if pending > 0 { 5 } else { 0 };
    let compact = full > area.width as usize;
    for (i, name) in VIEWS.iter().enumerate() {
        let mut label = if compact {
            format!(" {} {} ", i + 1, &name[..4.min(name.len())])
        } else {
            format!(" [{}] {} ", i + 1, name)
        };
        if i == 3 && pending > 0 {
            label = format!("{}({pending}) ", label);
        }
        let w = label.chars().count() as u16;
        let active = app.view.index() == i;
        let style = if active {
            Style::new()
                .fg(Color::White)
                .bg(ACCENT)
                .add_modifier(Modifier::BOLD)
        } else if i == 3 && pending > 0 {
            Style::new().fg(YELLOW)
        } else {
            Style::new().fg(DIM)
        };
        if x + w <= area.right() {
            app.hit_tabs.push(Rect::new(x, area.y, w, 1));
        }
        spans.push(Span::styled(label, style));
        spans.push(s("│", BORDER));
        x += w + 1;
    }
    f.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::new().bg(PANEL)),
        area,
    );
}

fn keyhint(k: &str, label: &str) -> Vec<Span<'static>> {
    vec![
        Span::styled(format!(" {k} "), Style::new().fg(TEXT).bg(KEY_BG)),
        s(format!(" {label}  "), DIM),
    ]
}

fn draw_footer(f: &mut Frame, app: &App, area: Rect) {
    if let Some(q) = &app.search {
        let l = Line::from(vec![
            b(" / ", ACCENT),
            s(format!("{q}█"), TEXT),
            s("   Enter apply · Esc cancel", DIM),
        ]);
        f.render_widget(Paragraph::new(l).style(Style::new().bg(PANEL)), area);
        return;
    }
    let mut keys: Vec<(&str, &str)> = vec![
        ("q", "Quit"),
        ("1-9", "View"),
        ("↑↓", "Move"),
        ("Enter", "Open"),
    ];
    let approvals = app.view == View::Approvals || (app.view == View::Dashboard && app.focus == 2);
    if app.chat.typing {
        keys = vec![
            ("Enter", "Send"),
            ("Alt+Enter", "Newline"),
            ("Esc", "Stop typing"),
            ("Tab", "Change agent"),
        ];
    } else if approvals {
        keys.extend([
            ("a", "Approve"),
            ("r", "Reject"),
            ("d", "Diff"),
            ("c", "Changes"),
            ("p", "Release"),
        ]);
    } else {
        match app.view {
            View::Dashboard | View::Agents => keys.extend([
                ("←→", "Group"),
                ("Tab", "Panel"),
                ("m", "Message"),
                ("n", "New task"),
                ("l", "Logs"),
                ("x", "Stop"),
                ("f", "Filter"),
            ]),
            View::Tasks => keys.extend([
                ("n", "New"),
                ("x", "Stop"),
                ("R", "Resume"),
                ("l", "Logs"),
                ("f", "Group"),
            ]),
            View::Logs => keys.extend([
                ("Space", "Pause"),
                ("F", "Follow"),
                ("g", "Agent"),
                ("e", "Severity"),
                ("t", "AI traffic"),
                ("c", "Clear"),
            ]),
            View::Chat => keys.extend([
                ("←→", "Group"),
                ("Tab", "Panel"),
                ("i", "Type"),
                ("N", "New conversation"),
            ]),
            View::History => keys.extend([("←→", "Tab"), ("r", "Reload")]),
            View::Settings => keys.extend([("L", "Sign out")]),
            View::Floor => keys.extend([
                ("←↑↓→", "Desk"),
                ("a", "Approvals"),
                ("m", "Message"),
                ("n", "New task"),
                ("l", "Logs"),
                ("x", "Stop"),
                ("f", "Filter"),
            ]),
            View::Approvals => {}
        }
    }
    if app.view == View::Dashboard && !app.chat.typing && !approvals {
        keys.push(("c", "Chat"));
    }
    if matches!(
        app.view,
        View::Dashboard | View::Agents | View::Chat | View::Floor
    ) && !app.chat.typing
    {
        keys.push(("C/right-click", "New Claude"));
    }
    if app.view != View::Settings && !app.chat.typing {
        keys.extend([("/", "Search"), ("?", "Help")]);
    }
    let mut spans: Vec<Span> = keys.iter().flat_map(|(k, l)| keyhint(k, l)).collect();
    if let Some((msg, err, _)) = &app.flash {
        spans.push(s(format!("  {msg}"), if *err { RED } else { GREEN }));
    }
    f.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::new().bg(BG)),
        area,
    );
}

// ---------------------------------------------------------------- dashboard

fn draw_dashboard(f: &mut Frame, app: &mut App, area: Rect) {
    if area.width < 120 || area.height < 30 {
        return draw_dashboard_compact(f, app, area);
    }
    // Bottom row holds the queue, system events and the chat you type into.
    let bottom_h = (area.height * 3 / 10).clamp(10, 18);
    // Tiles: three inner lines so CPU, RAM and GPU all fit.
    let [tiles, main, bottom] = Layout::vertical([
        Constraint::Length(5),
        Constraint::Min(10),
        Constraint::Length(bottom_h),
    ])
    .areas(area);
    draw_tiles(f, app, tiles);
    let [left, mid, right] = Layout::horizontal([
        Constraint::Percentage(30),
        Constraint::Percentage(37),
        Constraint::Percentage(33),
    ])
    .areas(main);
    draw_agent_table(f, app, left, app.focus == 0, false);
    app.hit_panels.push((left, 0));
    let [task, act] =
        Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(mid);
    draw_active_task(f, app, task);
    draw_activity(f, app, act, app.focus == 1);
    app.hit_panels.push((act, 1));
    draw_approval_detail(f, app, right, app.focus == 2, false);
    app.hit_panels.push((right, 2));
    let [q, sys, chat] = Layout::horizontal([
        Constraint::Percentage(34),
        Constraint::Percentage(28),
        Constraint::Percentage(38),
    ])
    .areas(bottom);
    draw_queue(f, app, q);
    app.hit_panels.push((q, 3));
    draw_system_events(f, app, sys);
    draw_chat_mini(f, app, chat);
    app.hit_panels.push((chat, 4));
    app.hit_chat_header = Some(Rect::new(chat.x, chat.y, chat.width, 1));
}

fn draw_dashboard_compact(f: &mut Frame, app: &mut App, area: Rect) {
    let c = app.counts();
    let res = app.resources.clone().unwrap_or_default();
    let pct = |v: Option<f64>| {
        v.map(|v| format!("{v:.0}%"))
            .unwrap_or_else(|| "n/a".into())
    };
    let summary = Line::from(vec![
        b(format!(" {} ", c.registered), BLUE),
        s("agents ", DIM),
        b(format!("{} ", c.working), GREEN),
        s(format!("working ({} tasks) ", c.running_tasks), DIM),
        b(format!("{} ", c.waiting), YELLOW),
        s("waiting ", DIM),
        b(format!("{} ", c.errors), RED),
        s("errors ", DIM),
        s(
            format!("│ CPU {} RAM {} ", pct(res.cpu), pct(res.ram)),
            TEXT,
        ),
        s(format!("│ {} approvals", app.approvals().len()), YELLOW),
    ]);
    let [sum, rest] = Layout::vertical([Constraint::Length(1), Constraint::Min(4)]).areas(area);
    f.render_widget(Paragraph::new(summary), sum);
    if area.width >= 80 {
        let [l, r] = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
            .areas(rest);
        draw_agent_table(f, app, l, app.focus == 0, false);
        app.hit_panels.push((l, 0));
        let [act, appr] =
            Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(r);
        draw_activity(f, app, act, app.focus == 1);
        app.hit_panels.push((act, 1));
        draw_approval_list(f, app, appr, app.focus == 2);
        app.hit_panels.push((appr, 2));
    } else {
        let [l, act] =
            Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(rest);
        draw_agent_table(f, app, l, app.focus == 0, false);
        app.hit_panels.push((l, 0));
        draw_activity(f, app, act, app.focus == 1);
        app.hit_panels.push((act, 1));
    }
}

/// Stat tile: big value, a dim qualifier on the same line, label below.
fn tile(f: &mut Frame, area: Rect, icon: &str, value: (usize, String), label: &str, color: Color) {
    let block = Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(color))
        .style(Style::new().bg(PANEL));
    let text = vec![
        Line::from(vec![
            s(format!(" {icon}  "), color),
            b(value.0.to_string(), TEXT),
            s(format!("  {}", value.1), DIM),
        ]),
        Line::from(s(format!("    {label}"), DIM)),
    ];
    f.render_widget(Paragraph::new(text).block(block), area);
}

fn bar_line(label: &str, pct: Option<f64>, color: Color, width: u16) -> Line<'static> {
    let w = width.saturating_sub(12).max(4) as usize;
    match pct {
        Some(p) => {
            let fill = ((p.clamp(0.0, 100.0) / 100.0) * w as f64).round() as usize;
            Line::from(vec![
                s(format!(" {label:<4}"), TEXT),
                s("━".repeat(fill), color),
                s("━".repeat(w - fill), KEY_BG),
                s(format!("{p:>4.0}%"), TEXT),
            ])
        }
        None => Line::from(vec![
            s(format!(" {label:<4}"), TEXT),
            s(format!("{:<w$} n/a", "unavailable"), DIM),
        ]),
    }
}

fn draw_tiles(f: &mut Frame, app: &App, area: Rect) {
    let c = app.counts();
    let cols = Layout::horizontal([
        Constraint::Fill(2),
        Constraint::Fill(2),
        Constraint::Fill(2),
        Constraint::Fill(2),
        Constraint::Fill(3),
        Constraint::Fill(3),
    ])
    .split(area);
    // Agents, not tasks: twelve tasks on one agent is one working agent.
    let enabled = format!("{} enabled", c.enabled);
    tile(
        f,
        cols[0],
        "◉",
        (c.registered, enabled),
        "Registered agents",
        BLUE,
    );
    let tasks = format!("{} tasks", c.running_tasks);
    tile(f, cols[1], "▶", (c.working, tasks), "Working agents", GREEN);
    let queued = format!("{} queued", c.queued_tasks);
    tile(
        f,
        cols[2],
        "⏸",
        (c.waiting, queued),
        "Waiting agents",
        YELLOW,
    );
    tile(
        f,
        cols[3],
        "▲",
        (c.errors, String::new()),
        "Agents in error",
        RED,
    );

    let res = app.resources.clone();
    let health = match &app.health {
        Some(h) if h.status == "ok" => s(
            format!(" Health ok · {} components", h.components.len()),
            GREEN,
        ),
        Some(h) => {
            let bad: Vec<&str> = h
                .components
                .iter()
                .filter(|(_, v)| *v != "ok")
                .map(|(k, _)| k.as_str())
                .collect();
            s(format!(" Degraded: {}", bad.join(", ")), YELLOW)
        }
        None => s(" Health unknown", DIM),
    };
    let sys = panel(title("", "System (last 15 min)"), false);
    let inner = sys.inner(cols[4]);
    f.render_widget(sys, cols[4]);
    let [l1, l2] = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(inner);
    f.render_widget(Paragraph::new(Line::from(health)), l1);
    match res.as_ref().filter(|r| !r.cpu_history.is_empty()) {
        Some(r) => f.render_widget(
            Sparkline::default()
                .data(&r.cpu_history)
                .max(100)
                .style(Style::new().fg(GREEN)),
            l2,
        ),
        None => f.render_widget(Paragraph::new(s(" CPU history unavailable", DIM)), l2),
    }

    let rb = panel(Line::default(), false);
    let inner = rb.inner(cols[5]);
    f.render_widget(rb, cols[5]);
    let (cpu, ram, hosts) = res
        .map(|r| (r.cpu, r.ram, r.hosts))
        .unwrap_or((None, None, 0));
    let mut lines = vec![
        bar_line("CPU", cpu, GREEN, inner.width),
        bar_line("RAM", ram, BLUE, inner.width),
        // The backend exposes no GPU metrics; shown as such, never invented.
        bar_line("GPU", None, ACCENT, inner.width),
    ];
    if !app.metrics_seen {
        lines = vec![Line::from(s(" Loading metrics …", DIM))];
    } else if hosts > 1 && inner.height > 3 {
        lines.push(Line::from(s(format!(" average of {hosts} hosts"), DIM)));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn agent_dot(a: &Agent) -> Span<'static> {
    s(
        "● ",
        if a.enabled {
            status_color(&a.status)
        } else {
            DIM
        },
    )
}

fn draw_agent_table(f: &mut Frame, app: &App, area: Rect, focused: bool, full: bool) {
    let list = app.agent_list();
    let filter = AGENT_FILTERS[app.agent_filter];
    let mut t = format!("Agents ({}", list.len());
    if list.len() != app.agents.len() {
        t += &format!("/{}", app.agents.len());
    }
    t += ")";
    let mut tl = title("⚙", t);
    tl.push_span(s(format!(" {filter} ▾ "), DIM));
    if !app.agent_query.is_empty() {
        tl.push_span(s(format!(" /{} ", app.agent_query), ACCENT));
    }
    let block = panel(tl, focused);
    if app.agents.is_empty() {
        return empty(
            area,
            f,
            block,
            if app.last_snapshot.is_none() {
                "Loading agents …"
            } else {
                "No agents registered"
            },
        );
    }
    let now = Utc::now();
    let agent_rows = app.agent_rows();
    let cols = if full { 8 } else { 3 };
    let rows: Vec<Row> = agent_rows
        .iter()
        .map(|r| {
            let i = match *r {
                AgentRow::Agent(i) => i,
                AgentRow::Group {
                    group,
                    open,
                    total,
                    active,
                } => return group_row(group, open, total, active, cols),
            };
            let a = &app.agents[i];
            let task = app.active_task_of(&a.id);
            let activity = a
                .current_task
                .clone()
                .or_else(|| task.map(|t| t.title()))
                .map(|x| crate::mask::mask(&x))
                .unwrap_or_else(|| {
                    if a.enabled {
                        "-".into()
                    } else {
                        "disabled".into()
                    }
                });
            let status = if a.enabled {
                a.status.as_str()
            } else {
                "disabled"
            };
            let mut cells = vec![
                Cell::from(Line::from(vec![
                    s(" ", TEXT),
                    agent_dot(a),
                    s(a.name.clone(), TEXT),
                ])),
                Cell::from(status_badge(status)),
            ];
            if full {
                cells.push(Cell::from(clip(
                    a.responsibility.as_deref().unwrap_or("-"),
                    30,
                )));
                cells.push(Cell::from(a.model.clone().unwrap_or_else(|| "-".into())));
                cells.push(Cell::from(format!(
                    "{}/{}",
                    a.running_tasks, a.queued_tasks
                )));
                cells.push(Cell::from(
                    task.and_then(|t| t.elapsed_secs(now))
                        .filter(|_| task.is_some_and(|t| t.status == "running"))
                        .map(fmt_dur)
                        .unwrap_or_default(),
                ));
                cells.push(Cell::from(ago(a.last_activity_at)));
            }
            cells.push(Cell::from(activity));
            Row::new(cells)
        })
        .collect();
    let (hdr, widths): (Vec<&str>, Vec<Constraint>) = if full {
        (
            vec![
                "Name",
                "Status",
                "Role",
                "Model",
                "Run/Q",
                "Runtime",
                "Last active",
                "Activity",
            ],
            vec![
                Constraint::Min(21),
                Constraint::Length(15),
                Constraint::Length(22),
                Constraint::Length(20),
                Constraint::Length(6),
                Constraint::Length(8),
                Constraint::Length(10),
                Constraint::Min(10),
            ],
        )
    } else {
        (
            vec!["Name", "Status", "Activity"],
            vec![
                Constraint::Min(21),
                Constraint::Length(15),
                Constraint::Min(8),
            ],
        )
    };
    let table = Table::new(rows, widths)
        .header(header(&hdr))
        .block(block)
        .row_highlight_style(Style::new().bg(SEL))
        .highlight_symbol("▌");
    let mut st = table_state(app.sel_agent, agent_rows.len(), true);
    f.render_stateful_widget(table, area, &mut st);
}

/// Category header: `▼ OPS Agents (11)` in bold accent, then how many of
/// them are working; the other cells stay empty.
fn group_row(
    group: AgentGroup,
    open: bool,
    total: usize,
    active: usize,
    cols: usize,
) -> Row<'static> {
    let mut cells = vec![
        Cell::from(Line::from(vec![
            s(if open { "▼ " } else { "▶ " }, ACCENT),
            Span::styled(
                format!("{} ({total})", group.label()),
                Style::new().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
        ])),
        Cell::from(if active > 0 {
            s(format!("{active} active"), GREEN)
        } else {
            s("", DIM)
        }),
    ];
    cells.resize(cols, Cell::from(""));
    Row::new(cells)
}

fn step_line(item: &WorkItem) -> Line<'static> {
    let (icon, color) = match item.status.as_str() {
        "completed" => ("✔", GREEN),
        "running" => ("◐", YELLOW),
        "failed" | "blocked" => ("✕", RED),
        "waiting_for_approval" | "waiting_for_agent" => ("⏸", YELLOW),
        "inconclusive" => ("?", DIM),
        _ => ("○", DIM),
    };
    let when = item
        .finished_at
        .or(item.started_at)
        .map(time)
        .unwrap_or_default();
    Line::from(vec![
        s(format!(" {icon} "), color),
        s(
            clip(&item.title, 60),
            if item.status == "queued" { DIM } else { TEXT },
        ),
        s(format!("  {}", item.agent.clone().unwrap_or_default()), DIM),
        s(format!("  {when}"), DIM),
    ])
}

fn draw_active_task(f: &mut Frame, app: &App, area: Rect) {
    let Some(agent) = app.selected_agent() else {
        return empty(
            area,
            f,
            panel(title("▣", "Active task"), false),
            "Select an agent",
        );
    };
    let task = app.active_task_of(&agent.id);
    let mut tl = title("▣", format!("Active task – {}", agent.name));
    if let Some(t) = task {
        tl.push_span(status_badge(&t.status));
    }
    let block = panel(tl, false);
    let Some(t) = task else {
        let mut lines = vec![Line::from(s(" No open task", DIM))];
        if let Some(a) = &agent.current_task {
            lines.push(Line::from(s(
                format!(" Last activity: {}", crate::mask::mask(a)),
                TEXT,
            )));
        }
        if let Some(e) = &agent.error_message {
            lines.push(Line::from(s(
                format!(" Error: {}", crate::mask::mask(e)),
                RED,
            )));
        }
        f.render_widget(
            Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
            area,
        );
        return;
    };
    let tools = t.tool_names();
    let model = agent.model.clone().unwrap_or_else(|| "-".into());
    let runtime = t
        .elapsed_secs(Utc::now())
        .map(fmt_dur)
        .unwrap_or_else(|| "not started".into());
    let mut lines = vec![
        Line::from(b(
            format!(" {}", clip(&crate::mask::mask(&t.title()), 120)),
            TEXT,
        )),
        Line::from(vec![
            s(format!(" ID {}", short(&t.id)), DIM),
            s(" │ ", BORDER),
            s(format!("Runtime {runtime}"), DIM),
            s(" │ ", BORDER),
            s(format!("Model {model}"), DIM),
        ]),
        Line::from(s(
            format!(
                " Tools: {}",
                if tools.is_empty() {
                    "none yet".into()
                } else {
                    clip(&tools.join(", "), 120)
                }
            ),
            DIM,
        )),
        Line::default(),
    ];
    match app.board(&t.id) {
        Some(b) if !b.items.is_empty() => {
            let (d, n) = b.progress().unwrap_or((0, 0));
            lines.push(Line::from(s(format!(" Steps {d}/{n}"), CYAN)));
            lines.extend(b.items.iter().map(step_line));
        }
        Some(_) => {
            lines.push(Line::from(s(" No step plan recorded for this task", DIM)));
            if let Some(a) = &agent.current_task {
                lines.push(Line::from(s(
                    format!(" ◐ {}", crate::mask::mask(a)),
                    YELLOW,
                )));
            }
        }
        None => lines.push(Line::from(s(" Loading steps …", DIM))),
    }
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn event_line(l: &Logged, width: u16) -> Line<'static> {
    let e = &l.ev;
    let color = match e.severity() {
        Severity::Error => RED,
        Severity::Warn => YELLOW,
        Severity::Info => TEXT,
    };
    let tag = format!("[{}]", e.agent.to_uppercase());
    let room = width.saturating_sub(tag.len() as u16 + 12) as usize;
    Line::from(vec![
        s(format!("{} ", time(l.at)), DIM),
        s(
            format!("{tag} "),
            if e.severity() == Severity::Info {
                BLUE
            } else {
                color
            },
        ),
        s(clip(&e.describe(), room.max(10)), color),
    ])
}

fn draw_activity(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let mut tl = title("▤", "Activity (live)");
    if app.log.paused_at.is_some() {
        tl.push_span(badge("paused", YELLOW));
    }
    let block = panel(tl, focused);
    let events = app.visible_events();
    if events.is_empty() {
        let msg = match app.conn {
            Conn::Live => "Waiting for agent activity …",
            _ => "Not connected to the live stream",
        };
        return empty(area, f, block, msg);
    }
    let items: Vec<ListItem> = events
        .iter()
        .map(|l| ListItem::new(event_line(l, area.width)))
        .collect();
    let sel = if focused && !app.log.follow {
        app.log.sel.min(items.len() - 1)
    } else {
        items.len() - 1
    };
    let list = List::new(items)
        .block(block)
        .highlight_style(Style::new().bg(if focused { SEL } else { PANEL }));
    f.render_stateful_widget(
        list,
        area,
        &mut ListState::default().with_selected(Some(sel)),
    );
}

fn approval_label(app: &App, r: ApprovalRef) -> (String, String, String, Color) {
    match r {
        ApprovalRef::Prompt(i) => {
            let (slug, p) = &app.claude_prompts[i];
            let name = app
                .claude_session(slug)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| slug.clone());
            let what = if p.is_question() {
                p.questions()
                    .first()
                    .map(|q| q.question.clone())
                    .unwrap_or_else(|| "Question".into())
            } else {
                format!(
                    "{}: {}",
                    p.tool,
                    crate::claude::summarize_input(&p.tool, &p.input)
                )
            };
            let kind = if p.is_question() {
                "question"
            } else {
                "permission"
            };
            (what, name, kind.into(), ACCENT)
        }
        ApprovalRef::Action(i) => {
            let a = &app.actions[i];
            (
                format!("{} {}", a.request_code, a.tool),
                app.agent_name(&a.agent_id),
                format!("level {} {}", a.approval_level, a.risk),
                if a.approval_level >= 3 || a.risk == "high" {
                    RED
                } else {
                    YELLOW
                },
            )
        }
        ApprovalRef::Change(i) => {
            let c = &app.changes[i];
            (
                c.title.clone(),
                c.proposed_by.clone().unwrap_or_else(|| "developer".into()),
                c.stage.clone(),
                status_color(&c.stage),
            )
        }
    }
}

fn draw_approval_list(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let list = app.approvals();
    let block = panel(title("⚑", format!("Approvals ({})", list.len())), focused);
    if list.is_empty() {
        return empty(area, f, block, "Nothing is waiting for approval");
    }
    let rows: Vec<Row> = list
        .iter()
        .map(|r| {
            let (t, agent, stage, color) = approval_label(app, *r);
            let kind = if matches!(r, ApprovalRef::Prompt(_)) {
                "claude"
            } else if matches!(r, ApprovalRef::Action(_)) {
                "action"
            } else {
                "change"
            };
            Row::new(vec![
                Cell::from(s(kind, DIM)),
                Cell::from(t),
                Cell::from(agent),
                Cell::from(badge(&stage, color)),
            ])
        })
        .collect();
    let table = Table::new(
        rows,
        [
            Constraint::Length(7),
            Constraint::Min(16),
            Constraint::Length(14),
            Constraint::Length(20),
        ],
    )
    .header(header(&["Type", "Title", "Agent", "State"]))
    .block(block)
    .row_highlight_style(Style::new().bg(SEL))
    .highlight_symbol("▌");
    f.render_stateful_widget(
        table,
        area,
        &mut table_state(app.sel_approval, list.len(), true),
    );
}

fn diff_line(l: &str) -> Line<'static> {
    let style = if l.starts_with("+++") || l.starts_with("---") || l.starts_with("diff --git") {
        Style::new().fg(TEXT).add_modifier(Modifier::BOLD)
    } else if l.starts_with('+') {
        Style::new().fg(GREEN).bg(Color::Rgb(10, 40, 22))
    } else if l.starts_with('-') {
        Style::new().fg(RED).bg(Color::Rgb(48, 12, 16))
    } else if l.starts_with("@@") {
        Style::new().fg(CYAN)
    } else {
        Style::new().fg(DIM)
    };
    Line::styled(l.replace('\t', "    "), style)
}

fn check_line(c: &Check) -> Line<'static> {
    let (icon, color) = match c.result.as_str() {
        "passed" => ("✔", GREEN),
        "failed" => ("✕", RED),
        "warning" => ("⚠", YELLOW),
        _ => ("○", DIM),
    };
    Line::from(vec![
        s(format!(" {icon} "), color),
        b(c.name.clone(), TEXT),
        s(format!("  {}", c.detail), DIM),
    ])
}

fn button(k: &str, label: &str, color: Color) -> Vec<Span<'static>> {
    vec![
        s("[", color),
        b(k.to_string(), color),
        s(format!("] {label}"), color),
        Span::raw("  "),
    ]
}

fn draw_approval_detail(f: &mut Frame, app: &App, area: Rect, focused: bool, full: bool) {
    let list = app.approvals();
    let Some(sel) = app.selected_approval() else {
        return empty(
            area,
            f,
            panel(title("⚑", "Approvals"), focused),
            "Nothing is waiting for approval",
        );
    };
    let (t, agent, stage, color) = approval_label(app, sel);
    let mut tl = title(
        "⚑",
        format!(
            "Approval {}/{}",
            app.sel_approval.min(list.len() - 1) + 1,
            list.len()
        ),
    );
    tl.push_span(badge(&stage, color));
    let block = panel(tl, focused);
    let inner = block.inner(area);
    f.render_widget(block, area);
    let [head, tabs, body, btns] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Min(2),
        Constraint::Length(1),
    ])
    .areas(inner);
    let sub = match sel {
        ApprovalRef::Prompt(i) => {
            let p = &app.claude_prompts[i].1;
            format!(
                "{agent} is waiting for you • {}",
                p.description.clone().unwrap_or_else(|| p.tool.clone())
            )
        }
        ApprovalRef::Action(i) => {
            let a = &app.actions[i];
            format!("{agent} • {} • requested {}", a.action, ago(a.requested_at))
        }
        ApprovalRef::Change(i) => {
            let c = &app.changes[i];
            format!(
                "{agent} • {} files +{} -{} • {}",
                c.files,
                c.added,
                c.removed,
                c.branch.clone().unwrap_or_default()
            )
        }
    };
    f.render_widget(
        Paragraph::new(vec![
            Line::from(b(format!(" {}", clip(&t, 100)), TEXT)),
            Line::from(s(format!(" {sub}"), DIM)),
        ]),
        head,
    );
    let tab = |label: &str, k: &str, on: bool| {
        Span::styled(
            format!(" {label} [{k}] "),
            if on {
                Style::new().fg(Color::White).bg(ACCENT)
            } else {
                Style::new().fg(DIM).bg(KEY_BG)
            },
        )
    };
    let dt = app.detail_tab;
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::raw(" "),
            tab("Diff", "d", dt == DetailTab::Diff),
            Span::raw(" "),
            tab("Tests", "t", dt == DetailTab::Tests),
            Span::raw(" "),
            tab("Security", "s", dt == DetailTab::Security),
            Span::raw(" "),
            tab("Details", "o", dt == DetailTab::Details),
        ])),
        tabs,
    );
    let lines: Vec<Line> = match sel {
        // Shown unmasked: what is allowed is exactly what runs.
        ApprovalRef::Prompt(i) => {
            let p = &app.claude_prompts[i].1;
            if p.is_question() {
                let mut v = Vec::new();
                for q in p.questions() {
                    v.push(Line::from(b(format!(" {}", q.question), TEXT)));
                    for (l, d) in q.options {
                        v.push(Line::from(vec![
                            s(format!("   • {l}"), ACCENT),
                            s(format!("  {d}"), DIM),
                        ]));
                    }
                }
                v.push(Line::from(s(" Press a to answer, r to decline", DIM)));
                v
            } else {
                let mut v = vec![Line::from(vec![s(" Tool ", DIM), b(p.tool.clone(), TEXT)])];
                v.extend(
                    serde_json::to_string_pretty(&p.input)
                        .unwrap_or_default()
                        .lines()
                        .map(|l| Line::from(s(format!(" {l}"), TEXT))),
                );
                v.push(Line::from(s(
                    " a allow · A always allow · r deny · o details",
                    DIM,
                )));
                v
            }
        }
        ApprovalRef::Action(i) => {
            let a = &app.actions[i];
            match dt {
                DetailTab::Security => vec![
                    Line::from(vec![
                        s(" Risk: ", DIM),
                        badge(&a.risk, status_color(&a.risk)),
                    ]),
                    Line::from(s(
                        format!(
                            " Approval level {} ({})",
                            a.approval_level,
                            if a.approval_level >= 3 {
                                "admin"
                            } else {
                                "operator"
                            }
                        ),
                        TEXT,
                    )),
                    Line::from(s(format!(" Expires {}", fmt_ts(a.expires_at)), DIM)),
                ],
                DetailTab::Tests => {
                    vec![Line::from(s(" Agent actions carry no test results.", DIM))]
                }
                _ => action_lines(a)
                    .into_iter()
                    .map(|l| Line::from(s(format!(" {l}"), TEXT)))
                    .collect(),
            }
        }
        ApprovalRef::Change(i) => {
            let c = &app.changes[i];
            let detail = app.change.as_ref().filter(|d| d.summary.id == c.id);
            match (dt, detail) {
                (_, None) => vec![Line::from(s(" Loading change …", DIM))],
                (DetailTab::Diff, Some(d)) => match app.patches.get(&c.id) {
                    // Unmasked: the reviewer approves exactly these bytes.
                    Some(Ok(p)) => p.lines().map(diff_line).collect(),
                    Some(Err(e)) => vec![Line::from(s(format!(" Patch unavailable: {e}"), RED))],
                    None => {
                        let mut v = vec![Line::from(s(
                            if !c.has_patch {
                                " No finished patch yet"
                            } else if app.role() != "admin" {
                                " Reading the patch requires the admin role"
                            } else {
                                " Loading patch …"
                            },
                            DIM,
                        ))];
                        v.extend(d.files_changed.iter().map(|f| {
                            Line::from(vec![
                                s(format!(" {} ", f.path), TEXT),
                                s(format!("+{}", f.added), GREEN),
                                s(format!(" -{}", f.removed), RED),
                            ])
                        }));
                        v
                    }
                },
                (DetailTab::Tests, Some(d)) => {
                    let mut v: Vec<Line> = d
                        .checks
                        .iter()
                        .filter(|c| c.name.starts_with("Test"))
                        .map(check_line)
                        .collect();
                    v.extend(
                        d.files_changed
                            .iter()
                            .filter(|f| f.kind == "test")
                            .map(|f| Line::from(s(format!("   test file {}", f.path), DIM))),
                    );
                    if v.is_empty() {
                        v.push(Line::from(s(" No test information", DIM)));
                    }
                    v
                }
                (DetailTab::Security, Some(d)) => {
                    let mut v: Vec<Line> = d
                        .checks
                        .iter()
                        .filter(|c| !c.name.starts_with("Test"))
                        .map(check_line)
                        .collect();
                    v.push(Line::from(s(
                        format!(
                            " Patch sha256 {}",
                            d.summary.patch_sha256.as_deref().unwrap_or("-")
                        ),
                        DIM,
                    )));
                    v
                }
                (DetailTab::Details, Some(d)) => change_lines(d)
                    .into_iter()
                    .map(|l| Line::from(s(format!(" {l}"), TEXT)))
                    .collect(),
            }
        }
    };
    f.render_widget(
        Paragraph::new(lines).style(Style::new().bg(if dt == DetailTab::Diff {
            BG
        } else {
            PANEL
        })),
        body,
    );
    let mut bt = Vec::new();
    bt.extend(button("a", "Approve", GREEN));
    bt.extend(button("r", "Reject", RED));
    bt.extend(button("d", "Full diff", BLUE));
    if full {
        bt.extend(button("c", "Request changes", YELLOW));
        bt.extend(button("p", "Record release", ACCENT));
    }
    bt.extend(button("o", "Open", DIM));
    f.render_widget(Paragraph::new(Line::from(bt)), btns);
}

fn draw_queue(f: &mut Frame, app: &App, area: Rect) {
    let q = app.queue();
    let block = panel(
        title("☰", format!("Task queue ({})", q.len())),
        app.focus == 3,
    );
    if q.is_empty() {
        return empty(area, f, block, "No open tasks");
    }
    let rows: Vec<Row> = q
        .iter()
        .map(|t| {
            Row::new(vec![
                Cell::from(s(short(&t.id), DIM)),
                Cell::from(clip(&crate::mask::mask(&t.title()), 80)),
                Cell::from(app.agent_name(&t.agent_id)),
                Cell::from(status_badge(&t.status)),
            ])
        })
        .collect();
    let table = Table::new(
        rows,
        [
            Constraint::Length(9),
            Constraint::Min(10),
            Constraint::Length(14),
            Constraint::Length(10),
        ],
    )
    .header(header(&["#", "Task", "Agent", "Status"]))
    .block(block)
    .row_highlight_style(Style::new().bg(SEL));
    f.render_stateful_widget(
        table,
        area,
        &mut table_state(app.sel_queue, q.len(), app.focus == 3),
    );
}

fn draw_system_events(f: &mut Frame, app: &App, area: Rect) {
    let block = panel(title("▤", "System events"), false);
    let mut lines: Vec<Line> = Vec::new();
    if let Some(h) = &app.health {
        for (k, v) in h.components.iter().filter(|(_, v)| *v != "ok") {
            lines.push(Line::from(vec![
                s(" ⚠ ", YELLOW),
                s(format!("Component {k} is {v}"), TEXT),
            ]));
        }
    }
    if let Conn::Retrying(_, why) = &app.conn {
        lines.push(Line::from(vec![
            s(" ✕ ", RED),
            s(format!("Live stream lost: {why}"), TEXT),
        ]));
    }
    for e in &app.snapshot_errors {
        lines.push(Line::from(vec![s(" ⚠ ", YELLOW), s(e.clone(), DIM)]));
    }
    let notable = app
        .events
        .iter()
        .rev()
        .filter(|l| {
            matches!(
                l.ev.event.as_deref(),
                Some(
                    "completed"
                        | "error"
                        | "approval_requested"
                        | "stopped"
                        | "action_finished"
                        | "task_started"
                )
            )
        })
        .take(area.height as usize);
    for l in notable {
        let (icon, color) = match l.ev.event.as_deref() {
            Some("completed" | "action_finished") => ("✔", GREEN),
            Some("error") => ("✕", RED),
            Some("approval_requested" | "stopped") => ("⚠", YELLOW),
            _ => ("ℹ", BLUE),
        };
        lines.push(Line::from(vec![
            s(format!(" {} ", time(l.at)), DIM),
            s(format!("{icon} "), color),
            s(
                format!("{}: {}", l.ev.agent, clip(&l.ev.describe(), 80)),
                TEXT,
            ),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(s(" No notable events yet", DIM)));
    }
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_chat_mini(f: &mut Frame, app: &App, area: Rect) {
    let typing = app.chat.typing && app.view == View::Dashboard;
    let agent = app
        .chat
        .agent
        .clone()
        .or_else(|| app.default_chat_agent())
        .unwrap_or_else(|| "-".into());
    let mut tl = title("✉", "Chat / Command");
    tl.push_span(Span::styled(
        format!(" to {agent} ▾ "),
        Style::new().fg(Color::White).bg(KEY_BG),
    ));
    tl.push_span(s(" click or Tab to change ", DIM));
    let block = panel(tl, app.focus == 4 || typing);
    let inner = block.inner(area);
    f.render_widget(block, area);
    let w = inner.width.saturating_sub(2) as usize;
    let mut input = app.chat.input.clone();
    if typing {
        input.push('█');
    }
    let input_lines = wrap(&input, w);
    let input_h = (input_lines.len() as u16 + 2).clamp(3, (inner.height / 2).max(3));
    let [msgs, inp] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(input_h)]).areas(inner);

    // Conversation: newest at the bottom, as much as fits.
    let mut lines: Vec<Line> = Vec::new();
    for t in &app.chat.msgs {
        for (i, l) in wrap(&crate::mask::mask(&t.title_full()), w.saturating_sub(5))
            .into_iter()
            .enumerate()
        {
            lines.push(Line::from(vec![
                s(if i == 0 { " You " } else { "     " }, ACCENT),
                s(l, DIM),
            ]));
        }
        let (body, color) = match (&t.response_message, &t.error_message) {
            (Some(r), _) => (r.clone(), TEXT),
            (None, Some(e)) => (e.clone(), RED),
            (None, None) if t.is_open() => {
                let tools = t.tool_names();
                let doing = if tools.is_empty() {
                    String::new()
                } else {
                    format!(" – {}", tools.join(", "))
                };
                (format!("… {}{doing}", t.status), YELLOW)
            }
            _ => ("(no answer)".into(), DIM),
        };
        for (i, l) in wrap(&crate::mask::mask(&body), w.saturating_sub(5))
            .into_iter()
            .enumerate()
        {
            lines.push(Line::from(vec![
                s(if i == 0 { "  ⤷  " } else { "     " }, CYAN),
                s(l, color),
            ]));
        }
    }
    if lines.is_empty() {
        let hint = if app.chat.loading {
            " Loading conversation …".to_string()
        } else {
            format!(" Click here or press c to write to {agent}.")
        };
        lines.push(Line::from(s(hint, DIM)));
    }
    let skip = lines.len().saturating_sub(msgs.height as usize);
    f.render_widget(Paragraph::new(lines).scroll((skip as u16, 0)), msgs);

    let ib = Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(if typing { ACCENT } else { BORDER }))
        .title_bottom(
            Line::from(Span::styled(
                if typing {
                    " Send [Enter] · Esc "
                } else {
                    " c / click to type "
                },
                if typing {
                    Style::new().fg(Color::White).bg(ACCENT)
                } else {
                    Style::new().fg(DIM)
                },
            ))
            .alignment(Alignment::Right),
        );
    let shown: Vec<Line> = if input.is_empty() {
        vec![Line::from(s(" Ask or give a task …", DIM))]
    } else {
        input_lines
            .into_iter()
            .map(|l| Line::from(s(format!(" {l}"), TEXT)))
            .collect()
    };
    let skip = shown
        .len()
        .saturating_sub(input_h.saturating_sub(2) as usize);
    f.render_widget(
        Paragraph::new(shown).block(ib).scroll((skip as u16, 0)),
        inp,
    );
}

fn fmt_tokens(n: i64) -> String {
    match n {
        n if n >= 1_000_000 => format!("{:.2}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

fn fmt_cost(c: Option<f64>) -> String {
    c.map(|c| format!("${c:.2}"))
        .unwrap_or_else(|| "cost unknown".into())
}

/// Bottom status line: tokens and cost today and over 7 days, and the
/// shared weekly budget (GET /ai/usage, GET /ai/budget).
fn draw_usage(f: &mut Frame, app: &App, area: Rect) {
    let mut spans = vec![b(" ◆ AI usage ", ACCENT)];
    match &app.usage {
        None if !app.usage_seen => spans.push(s("loading …", DIM)),
        None => spans.push(s("unavailable for this account", DIM)),
        Some(u) => {
            let period = |label: &str, t: &Tokens| {
                vec![
                    s(format!("{label} "), DIM),
                    b(fmt_tokens(t.input), TEXT),
                    s(" in / ", DIM),
                    b(fmt_tokens(t.output), TEXT),
                    s(" out · ", DIM),
                    s(format!("{} calls · ", t.calls), DIM),
                    b(
                        fmt_cost(t.cost),
                        if t.cost.is_some() { GREEN } else { YELLOW },
                    ),
                ]
            };
            spans.extend(period("Today", &u.today));
            spans.push(s("  │  ", BORDER));
            spans.extend(period("7 days", &u.week));
            if let Some(bu) = &u.budget {
                let used = bu.billed_usd + bu.reserved_usd;
                let pct = if bu.limit_usd > 0.0 {
                    (used / bu.limit_usd * 100.0).clamp(0.0, 999.0)
                } else {
                    0.0
                };
                let color = if bu.exhausted {
                    RED
                } else if bu.warning {
                    YELLOW
                } else {
                    GREEN
                };
                let cells = 10usize;
                let fill = ((pct.min(100.0) / 100.0) * cells as f64).round() as usize;
                spans.push(s("  │  ", BORDER));
                spans.push(s("Weekly budget ", DIM));
                spans.push(b(format!("${used:.2}"), color));
                spans.push(s(format!(" / ${:.2} ", bu.limit_usd), DIM));
                spans.push(s("█".repeat(fill), color));
                spans.push(s("░".repeat(cells - fill), KEY_BG));
                spans.push(s(format!(" {pct:.0}%"), color));
                if bu.exhausted {
                    spans.push(b("  EXHAUSTED", RED));
                }
            }
        }
    }
    if !app.claude.is_empty() {
        let (i, o, c) = app.claude.iter().fold((0, 0, 0.0), |(i, o, c), s| {
            (i + s.input_tokens, o + s.output_tokens, c + s.cost_usd)
        });
        spans.push(s("  │  ", BORDER));
        spans.push(s("Claude (local) ", DIM));
        spans.push(b(fmt_tokens(i), TEXT));
        spans.push(s(" in / ", DIM));
        spans.push(b(fmt_tokens(o), TEXT));
        spans.push(s(" out · ", DIM));
        spans.push(b(format!("${c:.2}"), GREEN));
    }
    f.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::new().bg(PANEL)),
        area,
    );
}

// ---------------------------------------------------------------- agents

fn text_lines(lines: Vec<String>) -> Vec<Line<'static>> {
    lines
        .into_iter()
        .map(|l| {
            // "Label:   value" → dim label, bright value.
            match l.split_once(':') {
                Some((k, v)) if !k.starts_with(' ') && k.len() < 16 && !k.is_empty() => {
                    Line::from(vec![s(format!("{k}:"), DIM), s(v.to_string(), TEXT)])
                }
                _ => Line::from(s(l, TEXT)),
            }
        })
        .collect()
}

fn draw_agents(f: &mut Frame, app: &mut App, area: Rect) {
    let [l, r] = if area.width >= 140 {
        Layout::horizontal([Constraint::Percentage(62), Constraint::Percentage(38)]).areas(area)
    } else {
        Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(area)
    };
    draw_agent_table(f, app, l, app.focus == 0, area.width >= 110);
    app.hit_panels.push((l, 0));
    app.hit_panels.push((r, 1));
    let block = panel(title("ⓘ", "Agent details"), app.focus == 1);
    match app.selected_agent() {
        Some(a) => {
            let lines = text_lines(app.agent_lines(a));
            f.render_widget(
                Paragraph::new(lines)
                    .block(block)
                    .wrap(Wrap { trim: false }),
                r,
            );
        }
        None => empty(r, f, block, "No agent matches the filter"),
    }
}

// ---------------------------------------------------------------- tasks

fn draw_tasks(f: &mut Frame, app: &mut App, area: Rect) {
    let [l, r] = if area.width >= 140 {
        Layout::horizontal([Constraint::Percentage(58), Constraint::Percentage(42)]).areas(area)
    } else {
        Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(area)
    };
    app.hit_panels.push((l, 0));
    app.hit_panels.push((r, 1));
    let list = app.task_list();
    let mut tl = title("☰", format!("Tasks ({})", list.len()));
    tl.push_span(s(
        format!(
            " {} ▾ ",
            app.task_group.map(|g| g.label()).unwrap_or("all groups")
        ),
        DIM,
    ));
    if !app.task_query.is_empty() {
        tl.push_span(s(format!(" /{} ", app.task_query), ACCENT));
    }
    let mut counts = std::collections::BTreeMap::new();
    let pending = app.pending_task_ids();
    for t in &app.tasks {
        *counts.entry(app.task_group(t, &pending)).or_insert(0) += 1;
    }
    let summary: Vec<Span> = TaskGroup::ALL
        .iter()
        .flat_map(|g| {
            let color = match g {
                TaskGroup::Running | TaskGroup::Completed => GREEN,
                TaskGroup::Queued | TaskGroup::WaitingApproval => YELLOW,
                TaskGroup::Failed => RED,
                TaskGroup::Cancelled => DIM,
            };
            vec![
                s(format!(" {} ", g.label()), DIM),
                b(counts.get(g).copied().unwrap_or(0).to_string(), color),
            ]
        })
        .collect();
    let block = panel(tl, app.focus == 0).title_bottom(Line::from(summary));
    let now = Utc::now();
    let rows: Vec<Row> = list
        .iter()
        .map(|(g, i)| {
            let t = &app.tasks[*i];
            let progress = app
                .board(&t.id)
                .and_then(|b| b.progress())
                .map(|(d, n)| format!("{d}/{n}"))
                .unwrap_or_else(|| "–".into());
            let label = match g {
                TaskGroup::WaitingApproval => "approval",
                _ => t.status.as_str(),
            };
            Row::new(vec![
                Cell::from(s(short(&t.id), DIM)),
                Cell::from(clip(&crate::mask::mask(&t.title()), 90)),
                Cell::from(app.agent_name(&t.agent_id)),
                Cell::from(status_badge(label)),
                Cell::from(
                    t.started_at
                        .or(t.created_at)
                        .map(|x| x.with_timezone(&Local).format("%d.%m %H:%M").to_string())
                        .unwrap_or_default(),
                ),
                Cell::from(t.elapsed_secs(now).map(fmt_dur).unwrap_or_default()),
                Cell::from(progress),
            ])
        })
        .collect();
    let table = Table::new(
        rows,
        [
            Constraint::Length(9),
            Constraint::Min(16),
            Constraint::Length(14),
            Constraint::Length(12),
            Constraint::Length(12),
            Constraint::Length(8),
            Constraint::Length(5),
        ],
    )
    .header(header(&[
        "ID", "Task", "Agent", "Status", "Started", "Duration", "Steps",
    ]))
    .block(block)
    .row_highlight_style(Style::new().bg(SEL))
    .highlight_symbol("▌");
    f.render_stateful_widget(table, l, &mut table_state(app.sel_task, list.len(), true));

    let block = panel(
        title("ⓘ", "Task run log  (Enter: full screen)"),
        app.focus == 1,
    );
    match app.selected_task() {
        Some(t) => f.render_widget(
            Paragraph::new(text_lines(app.task_lines(t)))
                .block(block)
                .wrap(Wrap { trim: false }),
            r,
        ),
        None => empty(
            r,
            f,
            block,
            if app.tasks.is_empty() {
                "No tasks yet"
            } else {
                "No task matches the filter"
            },
        ),
    }
}

// ---------------------------------------------------------------- approvals

fn draw_approvals(f: &mut Frame, app: &mut App, area: Rect) {
    let [l, r] = if area.width >= 120 {
        Layout::horizontal([Constraint::Percentage(38), Constraint::Percentage(62)]).areas(area)
    } else {
        Layout::vertical([Constraint::Percentage(35), Constraint::Percentage(65)]).areas(area)
    };
    app.hit_panels.push((l, 0));
    app.hit_panels.push((r, 1));
    draw_approval_list(f, app, l, app.focus == 0);
    draw_approval_detail(f, app, r, app.focus == 1, true);
}

// ---------------------------------------------------------------- logs

fn draw_logs(f: &mut Frame, app: &mut App, area: Rect) {
    app.hit_panels.push((area, 0));
    if app.log.traffic {
        return draw_traffic(f, app, area);
    }
    let events = app.visible_events();
    let mut tl = title(
        "▤",
        format!("Live events ({}/{})", events.len(), app.events.len()),
    );
    if let Some(a) = &app.log.agent {
        tl.push_span(s(format!(" agent:{a} "), ACCENT));
    }
    if let Some(t) = &app.log.task {
        tl.push_span(s(format!(" task:{} ", short(t)), ACCENT));
    }
    if app.log.min_sev != Severity::Info {
        tl.push_span(s(format!(" severity≥{:?} ", app.log.min_sev), YELLOW));
    }
    if !app.log.query.is_empty() {
        tl.push_span(s(format!(" /{} ", app.log.query), ACCENT));
    }
    tl.push_span(if app.log.paused_at.is_some() {
        badge("paused", YELLOW)
    } else {
        badge("live", GREEN)
    });
    if app.log.follow {
        tl.push_span(s(" autoscroll ", DIM));
    }
    let block = panel(tl, true);
    if events.is_empty() {
        return empty(
            area,
            f,
            block,
            "No events match. The stream shows activity from the moment opstui connected.",
        );
    }
    let rows: Vec<Row> = events
        .iter()
        .map(|l| {
            let (sev, color) = match l.ev.severity() {
                Severity::Error => ("ERROR", RED),
                Severity::Warn => ("WARN", YELLOW),
                Severity::Info => ("INFO", BLUE),
            };
            Row::new(vec![
                Cell::from(s(time(l.at), DIM)),
                Cell::from(s(sev, color)),
                Cell::from(s(l.ev.agent.clone(), CYAN)),
                Cell::from(s(
                    l.ev.task_id
                        .as_deref()
                        .map(short)
                        .unwrap_or("-")
                        .to_string(),
                    DIM,
                )),
                Cell::from(s(l.ev.describe(), if sev == "INFO" { TEXT } else { color })),
            ])
        })
        .collect();
    let n = rows.len();
    let sel = if app.log.follow {
        n - 1
    } else {
        app.log.sel.min(n - 1)
    };
    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Length(5),
            Constraint::Length(14),
            Constraint::Length(8),
            Constraint::Min(20),
        ],
    )
    .header(header(&["Time", "Level", "Agent", "Task", "What happened"]))
    .block(block)
    .row_highlight_style(Style::new().bg(SEL));
    f.render_stateful_widget(
        table,
        area,
        &mut TableState::default().with_selected(Some(sel)),
    );
}

fn num(v: &serde_json::Value, k: &str) -> String {
    v.get(k)
        .map(|x| x.to_string().trim_matches('"').to_string())
        .unwrap_or_else(|| "-".into())
}

fn draw_traffic(f: &mut Frame, app: &App, area: Rect) {
    let block = panel(
        title(
            "⇄",
            "AI traffic monitor (read-only, last hour)  [t] back to events",
        ),
        true,
    );
    let inner = block.inner(area);
    f.render_widget(block, area);
    let Some(t) = &app.traffic else {
        f.render_widget(Paragraph::new(s(" Loading …", DIM)), inner);
        return;
    };
    let (o, ev) = match t {
        Ok((o, e)) => (o, e),
        Err(e) => {
            f.render_widget(
                Paragraph::new(s(format!(" AI traffic data unavailable: {e}"), RED))
                    .wrap(Wrap { trim: true }),
                inner,
            );
            return;
        }
    };
    let [sum, tops, list] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(8),
        Constraint::Min(3),
    ])
    .areas(inner);
    let tt = &o.totals;
    f.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                s(" Requests ", DIM),
                b(num(tt, "requests"), TEXT),
                s("  Connections ", DIM),
                b(num(tt, "connections"), TEXT),
                s("  Failed ", DIM),
                b(num(tt, "failed"), RED),
                s("  Blocked ", DIM),
                b(num(tt, "blocked"), YELLOW),
                s("  Active ", DIM),
                b(o.active_connections.to_string(), GREEN),
                s("  Last minute ", DIM),
                b(o.requests_last_minute.to_string(), TEXT),
            ]),
            Line::from(s(
                format!(" Coverage: {}", crate::mask::mask(&o.coverage.to_string())),
                DIM,
            )),
        ]),
        sum,
    );
    let cols = Layout::horizontal([Constraint::Ratio(1, 3); 3]).split(tops);
    let top = |items: &[serde_json::Value], key: &str, label: &str| -> Paragraph<'static> {
        let mut lines = vec![Line::from(b(format!(" {label}"), CYAN))];
        for it in items.iter().take(6) {
            lines.push(Line::from(vec![
                s(format!(" {:<28}", clip(&num(it, key), 28)), TEXT),
                s(format!("{:>6}", num(it, "n")), TEXT),
                s(format!(" ({} problems)", num(it, "problems")), DIM),
            ]));
        }
        if items.is_empty() {
            lines.push(Line::from(s(" none", DIM)));
        }
        Paragraph::new(lines)
    };
    f.render_widget(top(&o.top_agents, "agent", "Agents"), cols[0]);
    f.render_widget(
        top(&o.top_destinations, "destination", "Destinations"),
        cols[1],
    );
    f.render_widget(top(&o.top_models, "model", "Models"), cols[2]);
    let rows: Vec<Row> = ev
        .events
        .iter()
        .map(|e| {
            let outcome = e.outcome.clone().unwrap_or_else(|| "-".into());
            let color = if outcome == "ok" {
                GREEN
            } else if outcome.contains("block") || outcome.contains("denied") {
                YELLOW
            } else {
                RED
            };
            let dst = format!(
                "{}{}",
                e.dst_host.clone().or(e.dst_ip.clone()).unwrap_or_default(),
                e.dst_port.map(|p| format!(":{p}")).unwrap_or_default()
            );
            let what = [
                e.method.clone(),
                e.path
                    .clone()
                    .map(|p| crate::mask::mask(p.split('?').next().unwrap_or(""))),
                e.mcp_tool.clone(),
                e.model.clone(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            Row::new(vec![
                Cell::from(s(e.ts.map(time).unwrap_or_default(), DIM)),
                Cell::from(e.agent_slug.clone().unwrap_or_else(|| "-".into())),
                Cell::from(e.kind.clone().unwrap_or_default()),
                Cell::from(dst),
                Cell::from(what),
                Cell::from(e.status_code.map(|c| c.to_string()).unwrap_or_default()),
                Cell::from(s(outcome, color)),
                Cell::from(
                    e.duration_ms
                        .map(|d| format!("{d:.0}ms"))
                        .unwrap_or_default(),
                ),
                Cell::from(format!(
                    "{}/{}",
                    e.bytes_sent.unwrap_or(0),
                    e.bytes_recv.unwrap_or(0)
                )),
            ])
        })
        .collect();
    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Length(12),
            Constraint::Length(5),
            Constraint::Length(28),
            Constraint::Min(12),
            Constraint::Length(4),
            Constraint::Length(10),
            Constraint::Length(8),
            Constraint::Length(13),
        ],
    )
    .header(header(&[
        "Time",
        "Agent",
        "Kind",
        "Destination",
        "Request",
        "Code",
        "Outcome",
        "Time",
        "Bytes ↑/↓",
    ]));
    f.render_widget(table, list);
}

// ---------------------------------------------------------------- chat

/// Word wrap to `w` columns (chat needs exact line counts for scrolling).
pub fn wrap(text: &str, w: usize) -> Vec<String> {
    let w = w.max(8);
    let mut out = Vec::new();
    for para in text.lines() {
        let mut line = String::new();
        for word in para.split(' ') {
            let mut word = word.to_string();
            while word.chars().count() > w {
                if !line.is_empty() {
                    out.push(std::mem::take(&mut line));
                }
                let head: String = word.chars().take(w).collect();
                word = word.chars().skip(w).collect();
                out.push(head);
            }
            if line.chars().count() + word.chars().count() + usize::from(!line.is_empty()) > w {
                out.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(&word);
        }
        out.push(line);
    }
    out
}

fn draw_chat(f: &mut Frame, app: &mut App, area: Rect) {
    let [l, r] = Layout::horizontal([
        Constraint::Length(26.min(area.width / 3)),
        Constraint::Min(20),
    ])
    .areas(area);
    app.hit_panels.push((l, 0));
    app.hit_panels.push((r, 1));
    let items: Vec<ListItem> = app
        .chat_rows()
        .into_iter()
        .map(|r| match r {
            AgentRow::Group {
                group,
                open,
                total,
                active,
            } => {
                let mut l = Line::from(vec![
                    s(if open { "▼ " } else { "▶ " }, ACCENT),
                    Span::styled(
                        format!("{} ({total})", group.label()),
                        Style::new().fg(ACCENT).add_modifier(Modifier::BOLD),
                    ),
                ]);
                if active > 0 {
                    l.push_span(s(format!(" {active}●"), GREEN));
                }
                ListItem::new(l)
            }
            AgentRow::Agent(i) => {
                let a = &app.agents[i];
                let current = app.chat.agent.as_deref() == Some(&a.slug);
                ListItem::new(Line::from(vec![
                    s(" ", TEXT),
                    agent_dot(a),
                    s(a.name.clone(), if current { ACCENT } else { TEXT }),
                ]))
            }
        })
        .collect();
    let n = items.len();
    let list = List::new(items)
        .block(panel(title("⚙", "Agents"), app.focus == 0))
        .highlight_style(Style::new().bg(SEL));
    f.render_stateful_widget(
        list,
        l,
        &mut ListState::default()
            .with_selected((n > 0).then_some(app.chat.sel.min(n.saturating_sub(1)))),
    );

    let input_h =
        (wrap(&app.chat.input, r.width.saturating_sub(4) as usize).len() as u16 + 2).clamp(3, 8);
    let [msgs, input] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(input_h)]).areas(r);
    let name = app.chat.agent.clone().unwrap_or_else(|| "-".into());
    let mut tl = title("✉", format!("Chat – {name}"));
    if let Some(k) = &app.chat.key {
        tl.push_span(s(format!(" {} ", clip(k, 40)), DIM));
    }
    let block = panel(tl, app.focus == 1 && !app.chat.typing);
    let inner = block.inner(msgs);
    let w = inner.width.saturating_sub(2) as usize;
    let mut lines: Vec<Line> = Vec::new();
    for t in &app.chat.msgs {
        lines.push(Line::from(vec![
            b(" You", ACCENT),
            s(format!("  {}", fmt_ts(t.created_at)), DIM),
        ]));
        for l in wrap(&crate::mask::mask(&t.title_full()), w) {
            lines.push(Line::from(s(format!(" {l}"), TEXT)));
        }
        let mut head = vec![
            b(format!(" {name}"), CYAN),
            Span::raw("  "),
            status_badge(&t.status),
        ];
        if let Some(d) = t.elapsed_secs(Utc::now()) {
            head.push(s(format!("  {}", fmt_dur(d)), DIM));
        }
        lines.push(Line::from(head));
        let tools = t.tool_names();
        if !tools.is_empty() {
            for l in wrap(&format!("tools: {}", tools.join(", ")), w) {
                lines.push(Line::from(s(format!(" {l}"), DIM)));
            }
        }
        let body = t
            .response_message
            .clone()
            .or(t.error_message.clone())
            .unwrap_or_else(|| {
                if t.is_open() {
                    "… working".into()
                } else {
                    "(no answer)".into()
                }
            });
        let color = if t.status == "failed" { RED } else { TEXT };
        for l in wrap(&crate::mask::mask(&body), w) {
            lines.push(Line::from(s(format!(" {l}"), color)));
        }
        lines.push(Line::default());
    }
    if lines.is_empty() {
        lines.push(Line::from(s(
            if app.chat.loading {
                " Loading conversation …"
            } else {
                " No messages yet. Click here or press i to type."
            },
            DIM,
        )));
    }
    let max_off = lines.len().saturating_sub(inner.height as usize);
    app.chat.scroll = app.chat.scroll.min(max_off as u16);
    let off = max_off.saturating_sub(app.chat.scroll as usize);
    f.render_widget(
        Paragraph::new(lines).block(block).scroll((off as u16, 0)),
        msgs,
    );

    let ib = panel(
        Line::from(vec![
            s(" › Message ", if app.chat.typing { ACCENT } else { DIM }),
            s("Enter send · Alt+Enter newline · Esc ", DIM),
        ]),
        app.chat.typing,
    );
    let mut text = app.chat.input.clone();
    if app.chat.typing {
        text.push('█');
    }
    let wrapped: Vec<Line> = wrap(&text, r.width.saturating_sub(4) as usize)
        .into_iter()
        .map(|l| Line::from(s(format!(" {l}"), TEXT)))
        .collect();
    let skip = wrapped
        .len()
        .saturating_sub(input_h.saturating_sub(2) as usize);
    f.render_widget(
        Paragraph::new(wrapped).block(ib).scroll((skip as u16, 0)),
        input,
    );
}

// ---------------------------------------------------------------- history

fn draw_history(f: &mut Frame, app: &mut App, area: Rect) {
    app.hit_panels.push((area, 0));
    let mut tabs: Vec<Span> = vec![Span::raw(" ")];
    for (i, t) in HIST_TABS.iter().enumerate() {
        tabs.push(Span::styled(
            format!(" {t} "),
            if i == app.hist.tab {
                Style::new().fg(Color::White).bg(ACCENT)
            } else {
                Style::new().fg(DIM).bg(KEY_BG)
            },
        ));
        tabs.push(Span::raw(" "));
    }
    if !app.hist.query.is_empty() {
        tabs.push(s(format!(" /{}", app.hist.query), ACCENT));
    }
    let block = panel(title("⟲", "History"), true).title_bottom(Line::from(tabs));
    let rows_idx = app.hist_rows();
    let sel = app.hist.sel;
    let (hdr, widths, rows): (Vec<&str>, Vec<Constraint>, Vec<Row>) = match app.hist.tab {
        0 => {
            let Some(p) = &app.hist.page else {
                return empty(area, f, block, "Loading …");
            };
            (
                vec!["When", "Agent", "Status", "Question", "Answer"],
                vec![
                    Constraint::Length(19),
                    Constraint::Length(14),
                    Constraint::Length(11),
                    Constraint::Percentage(40),
                    Constraint::Min(10),
                ],
                rows_idx
                    .iter()
                    .filter_map(|i| p.items.get(*i))
                    .map(|i| {
                        let t = &i.task;
                        Row::new(vec![
                            Cell::from(fmt_ts(t.created_at)),
                            Cell::from(i.agent.clone()),
                            Cell::from(status_badge(&t.status)),
                            Cell::from(clip(&crate::mask::mask(&t.title()), 100)),
                            Cell::from(clip(
                                &crate::mask::mask(
                                    t.response_message
                                        .as_deref()
                                        .or(t.error_message.as_deref())
                                        .unwrap_or(""),
                                ),
                                100,
                            )),
                        ])
                    })
                    .collect(),
            )
        }
        1 => (
            vec!["Created", "Agent", "Status", "By", "Task", "Why it failed"],
            vec![
                Constraint::Length(19),
                Constraint::Length(14),
                Constraint::Length(11),
                Constraint::Length(10),
                Constraint::Percentage(40),
                Constraint::Min(10),
            ],
            rows_idx
                .iter()
                .map(|i| {
                    let t = &app.tasks[*i];
                    Row::new(vec![
                        Cell::from(fmt_ts(t.created_at)),
                        Cell::from(app.agent_name(&t.agent_id)),
                        Cell::from(status_badge(&t.status)),
                        Cell::from(t.requested_by.clone().unwrap_or_default()),
                        Cell::from(clip(&crate::mask::mask(&t.title()), 100)),
                        Cell::from(s(
                            clip(
                                &crate::mask::mask(t.error_message.as_deref().unwrap_or("")),
                                100,
                            ),
                            RED,
                        )),
                    ])
                })
                .collect(),
        ),
        2 => (
            vec![
                "Updated",
                "Change",
                "Stage",
                "Files",
                "Approved by",
                "Production",
            ],
            vec![
                Constraint::Length(19),
                Constraint::Percentage(35),
                Constraint::Length(18),
                Constraint::Length(12),
                Constraint::Length(14),
                Constraint::Min(10),
            ],
            rows_idx
                .iter()
                .map(|i| {
                    let c = &app.changes[*i];
                    Row::new(vec![
                        Cell::from(fmt_ts(c.updated_at)),
                        Cell::from(c.title.clone()),
                        Cell::from(status_badge(&c.stage)),
                        Cell::from(format!("{} +{} -{}", c.files, c.added, c.removed)),
                        Cell::from(c.approved_by.clone().unwrap_or_else(|| "-".into())),
                        Cell::from(match (&c.release_ref, c.stage.as_str()) {
                            (Some(r), _) => format!("{r} {}", fmt_ts(c.finished_at)),
                            (None, "in_production") => fmt_ts(c.finished_at),
                            _ => "-".into(),
                        }),
                    ])
                })
                .collect(),
        ),
        _ => match &app.hist.audit {
            None => return empty(area, f, block, "Loading …"),
            Some(Err(e)) => return empty(area, f, block, &format!("Audit log unavailable: {e}")),
            Some(Ok(a)) => (
                vec!["When", "User", "Action", "Target", "Result"],
                vec![
                    Constraint::Length(19),
                    Constraint::Length(14),
                    Constraint::Length(10),
                    Constraint::Min(20),
                    Constraint::Length(8),
                ],
                rows_idx
                    .iter()
                    .filter_map(|i| a.get(*i))
                    .map(|e| {
                        Row::new(vec![
                            Cell::from(fmt_ts(e.created_at)),
                            Cell::from(e.user.clone().unwrap_or_default()),
                            Cell::from(e.action.clone()),
                            Cell::from(crate::mask::mask(&e.target)),
                            Cell::from(s(
                                e.result.clone(),
                                if e.result.starts_with('2') {
                                    GREEN
                                } else {
                                    RED
                                },
                            )),
                        ])
                    })
                    .collect(),
            ),
        },
    };
    let n = rows.len();
    if n == 0 {
        return empty(area, f, block, "Nothing found");
    }
    let table = Table::new(rows, widths)
        .header(header(&hdr))
        .block(block)
        .row_highlight_style(Style::new().bg(SEL))
        .highlight_symbol("▌");
    f.render_stateful_widget(table, area, &mut table_state(sel, n, true));
}

// ---------------------------------------------------------------- settings

fn draw_settings(f: &mut Frame, app: &mut App, area: Rect) {
    let kv = |k: &str, v: String| Line::from(vec![s(format!(" {k:<18}"), DIM), s(v, TEXT)]);
    let mut lines = vec![
        Line::from(b(" Connection", CYAN)),
        kv("Server", app.cfg.server.clone()),
        kv(
            "Signed in as",
            app.user
                .as_ref()
                .map(|u| format!("{} ({})", u.username, u.role))
                .unwrap_or_default(),
        ),
        kv("Environment", app.cfg.env_label()),
        kv(
            "Live stream",
            match &app.conn {
                Conn::Live => "connected".into(),
                Conn::Connecting => "connecting".into(),
                Conn::Retrying(n, why) => format!("reconnecting in {n}s ({why})"),
            },
        ),
        kv("Last refresh", fmt_ts(app.last_snapshot)),
        kv("Refresh interval", format!("{} s", app.cfg.refresh_seconds)),
        Line::default(),
        Line::from(b(" Versions", CYAN)),
        kv("opstui", env!("CARGO_PKG_VERSION").into()),
        kv(
            "Ops-Center",
            app.health
                .as_ref()
                .map(|h| h.version.clone())
                .unwrap_or_else(|| "-".into()),
        ),
        Line::default(),
        Line::from(b(" Backend health", CYAN)),
    ];
    if let Some(h) = &app.health {
        for (k, v) in &h.components {
            lines.push(Line::from(vec![
                s(format!(" {k:<18}"), DIM),
                s(v.clone(), status_color(v)),
            ]));
        }
    } else {
        lines.push(Line::from(s(" unknown", DIM)));
    }
    if !app.snapshot_errors.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(b(" Not available to this account", YELLOW)));
        for e in &app.snapshot_errors {
            lines.push(Line::from(s(format!(" {e}"), DIM)));
        }
    }
    lines.extend([
        Line::default(),
        Line::from(b(" Files", CYAN)),
        kv("Config", crate::config::path().display().to_string()),
        kv("Log", crate::config::log_path().display().to_string()),
        Line::default(),
        Line::from(b(" Not supported by the backend (shown, not simulated)", CYAN)),
        Line::from(s(" • Pausing a task: only stop (cancel) exists.", DIM)),
        Line::from(s(" • Task priority: tasks carry no priority field.", DIM)),
        Line::from(s(" • Event replay: the live stream has no event IDs; after a reconnect state is re-read over REST,", DIM)),
        Line::from(s("   but activity during the gap is not shown.", DIM)),
        Line::from(s(" • GPU usage: the metrics API exposes CPU and RAM only.", DIM)),
        Line::from(s(" • Per-agent token use: only totals per model exist (/ai/usage).", DIM)),
        Line::default(),
        Line::from(vec![Span::raw(" "), Span::styled(" L ", Style::new().bg(KEY_BG)), s(" Sign out", DIM)]),
    ]);
    f.render_widget(
        Paragraph::new(lines)
            .block(panel(title("⚙", "Settings"), true))
            .wrap(Wrap { trim: false }),
        area,
    );
}

// ---------------------------------------------------------------- modals

/// Where the agent picker is drawn; app.rs uses it to map clicks to rows
/// (row i sits at y + 1 + i, just inside the border).
pub fn picker_rect(area: Rect, n: usize) -> Rect {
    centered(area, 76, n as u16 + 4)
}

pub fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    )
}

/// Right-click menu placement, kept inside the screen; row i at y + 1 + i.
pub fn menu_rect(screen: Rect, x: u16, y: u16, items: &[(String, MenuAction)]) -> Rect {
    let w = items
        .iter()
        .map(|(l, _)| l.chars().count() as u16 + 4)
        .max()
        .unwrap_or(20)
        .max(28)
        .min(screen.width);
    let h = (items.len() as u16 + 2).min(screen.height);
    Rect::new(
        x.min(screen.right().saturating_sub(w)),
        y.min(screen.bottom().saturating_sub(h)),
        w,
        h,
    )
}

fn draw_menu(
    f: &mut Frame,
    area: Rect,
    x: u16,
    y: u16,
    items: &[(String, MenuAction)],
    sel: usize,
) {
    let r = menu_rect(area, x, y, items);
    let lines: Vec<Line> = items
        .iter()
        .enumerate()
        .map(|(i, (l, _))| {
            let st = if i == sel {
                Style::new().fg(Color::White).bg(ACCENT)
            } else {
                Style::new().fg(TEXT)
            };
            Line::styled(
                format!(" {l:<w$}", w = r.width.saturating_sub(3) as usize),
                st,
            )
        })
        .collect();
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines).block(panel(Line::default(), true)), r);
}

fn draw_modal(f: &mut Frame, app: &App, m: &Modal, area: Rect) {
    if let Modal::Menu { x, y, items, sel } = m {
        return draw_menu(f, area, *x, *y, items, *sel);
    }
    let (w, h, t, body): (u16, u16, String, Text) = match m {
        Modal::Help => (
            76,
            30,
            "Keyboard shortcuts".into(),
            Text::from(help_lines()),
        ),
        Modal::Confirm { op, word, typed } => {
            let mut lines = vec![Line::from(b(op.describe(), TEXT)), Line::default()];
            match word {
                Some(w) => {
                    lines.push(Line::from(s(
                        "This step is recorded under your name and cannot be undone here.",
                        YELLOW,
                    )));
                    lines.push(Line::from(vec![
                        s("Type ", DIM),
                        b(w.to_string(), ACCENT),
                        s(" and press Enter, Esc to cancel:", DIM),
                    ]));
                    lines.push(Line::from(s(format!("› {typed}█"), TEXT)));
                }
                None => lines.push(Line::from(vec![
                    b("[y]", GREEN),
                    s(" Confirm    ", DIM),
                    b("[n]", RED),
                    s(" Cancel", DIM),
                ])),
            }
            (80, 9, "Confirm".into(), Text::from(lines))
        }
        Modal::Password {
            op,
            buf,
            error,
            busy,
        } => {
            let mut lines = vec![
                Line::from(b(op.describe(), TEXT)),
                Line::from(s(
                    "The backend requires a recent password confirmation for this step.",
                    DIM,
                )),
                Line::default(),
                Line::from(s(
                    format!("Password › {}█", "•".repeat(buf.chars().count())),
                    TEXT,
                )),
            ];
            if *busy {
                lines.push(Line::from(s("Checking …", YELLOW)));
            }
            if let Some(e) = error {
                lines.push(Line::from(s(e.clone(), RED)));
            }
            (80, 9, "Confirm password".into(), Text::from(lines))
        }
        Modal::Input { title, buf, .. } => (
            80,
            7,
            title.clone(),
            Text::from(vec![
                Line::from(s(format!("› {buf}█"), TEXT)),
                Line::default(),
                Line::from(s("Enter continue · Esc cancel", DIM)),
            ]),
        ),
        Modal::NewTask { agent, buf } => {
            let agents = app.chat_agents();
            let name = agents
                .get(*agent)
                .map(|a| format!("{} ({})", a.name, a.slug))
                .unwrap_or_default();
            let mut lines = vec![
                Line::from(vec![
                    s("Agent  ◀ ", DIM),
                    b(name, ACCENT),
                    s(" ▶   (Tab/←→ to change)", DIM),
                ]),
                Line::from(s("Description:", DIM)),
            ];
            lines.extend(
                wrap(&format!("{buf}█"), 74)
                    .into_iter()
                    .map(|l| Line::from(s(l, TEXT))),
            );
            lines.push(Line::default());
            lines.push(Line::from(s(
                "Enter send · Alt+Enter newline · Esc cancel. The task runs under your account.",
                DIM,
            )));
            (80, 14, "New task".into(), Text::from(lines))
        }
        Modal::Menu { .. } => return,
        Modal::Question {
            idx,
            q,
            sel,
            picked,
            custom,
            ..
        } => {
            let Some((slug, p)) = app.claude_prompts.get(*idx) else {
                return;
            };
            let qs = p.questions();
            let Some(cur) = qs.get(*q) else { return };
            let name = app
                .claude_session(slug)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| slug.clone());
            let mut body = vec![
                Line::from(vec![
                    s(format!("{name} asks"), DIM),
                    s(format!("  ({}/{})", q + 1, qs.len()), DIM),
                ]),
                Line::from(b(cur.question.clone(), TEXT)),
                Line::default(),
            ];
            for (i, (l, d)) in cur.options.iter().enumerate() {
                let mark = if cur.multi {
                    if picked.contains(&i) {
                        "[x] "
                    } else {
                        "[ ] "
                    }
                } else {
                    ""
                };
                let st = if i == *sel && custom.is_empty() {
                    Style::new().fg(Color::White).bg(ACCENT)
                } else {
                    Style::new().fg(TEXT)
                };
                body.push(Line::from(vec![
                    Span::styled(format!(" {mark}{l} "), st),
                    s(format!("  {d}"), DIM),
                ]));
            }
            body.push(Line::default());
            body.push(Line::from(vec![
                s("Or type an answer: ", DIM),
                s(format!("{custom}█"), TEXT),
            ]));
            body.push(Line::default());
            let keys = if cur.multi {
                "↑↓ move · Space pick · Enter answer · Esc later"
            } else {
                "↑↓ choose · Enter answer · Esc later"
            };
            body.push(Line::from(s(keys, DIM)));
            (
                84,
                body.len() as u16 + 4,
                cur.header.clone(),
                Text::from(body),
            )
        }
        Modal::Notice { title, lines, ok } => {
            let color = if *ok { GREEN } else { RED };
            let mut body = vec![
                Line::from(b(format!("{} {title}", if *ok { "✔" } else { "✕" }), color)),
                Line::default(),
            ];
            body.extend(lines.iter().map(|l| {
                let c = if l.starts_with('✔') { GREEN } else { TEXT };
                Line::from(s(l.clone(), c))
            }));
            body.push(Line::default());
            body.push(Line::from(s("Press any key to continue", DIM)));
            (76, lines.len() as u16 + 7, title.clone(), Text::from(body))
        }
        Modal::AgentPicker { sel } => {
            let mut lines: Vec<Line> = app
                .chat_agents()
                .iter()
                .enumerate()
                .map(|(i, a)| {
                    let current = app.chat.agent.as_deref() == Some(&a.slug);
                    let row = Line::from(vec![
                        agent_dot(a),
                        b(
                            format!("{:<18}", clip(&a.name, 18)),
                            if current { ACCENT } else { TEXT },
                        ),
                        s(format!("{:<10} ", a.status), status_color(&a.status)),
                        s(
                            clip(a.responsibility.as_deref().unwrap_or(&a.slug), 34),
                            DIM,
                        ),
                    ]);
                    if i == *sel {
                        row.style(Style::new().bg(SEL))
                    } else {
                        row
                    }
                })
                .collect();
            let n = lines.len();
            lines.push(Line::default());
            lines.push(Line::from(s(
                "↑↓ choose · Enter or click to talk · Esc cancel",
                DIM,
            )));
            let r = picker_rect(area, n);
            (
                r.width,
                r.height,
                "Talk to which agent?".into(),
                Text::from(lines),
            )
        }
        Modal::Text {
            title,
            lines,
            diff,
            scroll,
        } => {
            let body: Vec<Line> = lines
                .iter()
                .skip(*scroll as usize)
                .map(|l| {
                    if *diff {
                        diff_line(l)
                    } else {
                        Line::from(s(l.clone(), TEXT))
                    }
                })
                .collect();
            (
                area.width.saturating_sub(6),
                area.height.saturating_sub(4),
                format!("{title}  (↑↓ PgUp PgDn · Esc close)"),
                Text::from(body),
            )
        }
    };
    let r = centered(area, w, h);
    f.render_widget(Clear, r);
    let wrap_text = !matches!(m, Modal::Text { diff: true, .. });
    let mut p = Paragraph::new(body)
        .block(panel(title("◆", t), true).padding(ratatui::widgets::Padding::horizontal(1)));
    if wrap_text {
        p = p.wrap(Wrap { trim: false });
    }
    f.render_widget(p, r);
}

fn help_lines() -> Vec<Line<'static>> {
    let rows = [
        ("1-9", "Switch view (9: Ops Floor)"),
        ("↑↓ / j k, PgUp PgDn", "Move"),
        ("Enter", "Open or select"),
        ("→ / ←", "Agents, Chat: open / close a category"),
        ("Esc", "Back / clear filter"),
        ("Tab", "Next panel"),
        ("/", "Search in the current view"),
        ("a / r", "Approve / reject (approvals)"),
        ("d / t / s / o", "Diff, tests, security checks, details"),
        ("c", "Request changes to a patch"),
        ("p", "Record a production release (separate step)"),
        ("n", "New task for an agent"),
        ("m", "Message the selected agent"),
        ("x", "Stop the selected task (confirm)"),
        ("R", "Resume a resumable task"),
        ("l", "Logs for the selected agent or task"),
        ("f", "Filter (agent status / task group)"),
        ("Space / F", "Logs: pause / follow"),
        ("g / e / t", "Logs: agent filter, severity, AI traffic"),
        ("i / N", "Chat: type / new conversation"),
        (
            "← ↑ ↓ →",
            "Ops Floor: nearest desk that way (j/k: in order)",
        ),
        ("a / Enter", "Ops Floor: the agent's approvals / details"),
        ("?", "This help"),
        ("q / Ctrl+C", "Quit"),
    ];
    let mut v: Vec<Line> = rows
        .iter()
        .map(|(k, d)| Line::from(vec![b(format!("{k:<22}"), ACCENT), s(d.to_string(), TEXT)]))
        .collect();
    v.push(Line::default());
    v.push(Line::from(s(
        "Selecting a row never changes anything; writes need a key and a confirmation.",
        DIM,
    )));
    v
}

impl Task {
    /// The whole question as typed, without the web UI's page context.
    pub fn title_full(&self) -> String {
        self.input_message
            .split("\n\n---\nPage context")
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::wrap;

    #[test]
    fn wrap_breaks_words_and_long_tokens() {
        assert_eq!(wrap("aaa bbb ccc", 8), vec!["aaa bbb", "ccc"]);
        assert_eq!(wrap("abcdefghijkl", 8), vec!["abcdefgh", "ijkl"]);
        assert_eq!(wrap("a\n\nb", 8), vec!["a", "", "b"]);
    }
}
