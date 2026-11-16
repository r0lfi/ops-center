//! README images of opstui, rendered without a terminal or server.
//!
//! Ignored by default. With synthetic data only, it writes one HTML page per
//! view (colours and bold kept) for `frontend/scripts/capture-tui.mjs`:
//!
//!   OPSTUI_SCREENSHOT_DIR=/tmp/opstui cargo test --test screenshot -- --ignored

use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use opstui::app::App;
use opstui::config::Config;
use opstui::model::*;
use opstui::sync::{Conn, Msg, Snapshot};
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;

/// A time `minutes` ago, so durations and "last activity" look current.
fn ago(minutes: i64) -> Ts {
    Some(chrono::Utc::now() - chrono::Duration::minutes(minutes))
}

const W: u16 = 170;
const H: u16 = 46;

fn key(app: &mut App, c: KeyCode) {
    app.on_term(Event::Key(KeyEvent::new(c, KeyModifiers::NONE)));
}

fn agent(slug: &str, name: &str, status: &str, running: i64, task: Option<&str>) -> Agent {
    Agent {
        id: format!("id-{slug}"),
        slug: slug.into(),
        name: name.into(),
        status: status.into(),
        current_task: task.map(Into::into),
        enabled: true,
        runtime: if slug.starts_with("ext-") {
            "external"
        } else {
            "native"
        }
        .into(),
        personal: slug == "nova",
        running_tasks: running,
        model: Some("example-model".into()),
        last_activity_at: ago(2),
        ..Default::default()
    }
}

fn task(id: &str, agent: &str, status: &str, input: &str, minutes_ago: i64) -> Task {
    Task {
        id: id.into(),
        agent_id: format!("id-{agent}"),
        status: status.into(),
        input_message: input.into(),
        requested_by: Some("demo-admin".into()),
        source: "web".into(),
        agents_used: vec![agent.into()],
        created_at: ago(minutes_ago),
        started_at: ago(minutes_ago),
        ..Default::default()
    }
}

fn demo() -> App {
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    let mut app = App::new(
        Config {
            server: "https://ops.example.com".into(),
            claude_default_agent: String::new(),
            ..Default::default()
        },
        tx,
    );
    app.on_msg(Msg::LoggedIn(TokenResponse {
        access_token: "documentation-fixture-only".into(),
        role: "admin".into(),
        username: "demo-admin".into(),
    }));
    let question = "Why is the example application slower than usual?";
    app.on_msg(Msg::Snapshot(Box::new(Snapshot {
        agents: Some(vec![
            agent("coordinator", "Coordinator", "working", 1, Some(question)),
            agent(
                "linux",
                "Linux Ops",
                "waiting",
                0,
                Some("Reviewing synthetic filesystem metrics"),
            ),
            agent(
                "network",
                "Network",
                "investigating",
                1,
                Some("Probing the example upstream API"),
            ),
            agent(
                "monitoring",
                "Monitoring",
                "working",
                1,
                Some("Correlating latency with example alerts"),
            ),
            agent("security", "Security", "idle", 0, None),
            agent("container", "Containers", "idle", 0, None),
            agent("patching", "Patching", "idle", 0, None),
            agent("automation", "Automation", "idle", 0, None),
            agent("general", "General", "idle", 0, None),
            agent("chat", "Chat", "idle", 0, None),
            agent("nova", "Nova", "idle", 0, None),
            agent(
                "ext-coordinator",
                "External Coordinator",
                "working",
                1,
                Some("Reviewing an example change"),
            ),
            agent(
                "ext-coder",
                "External Coder",
                "working",
                1,
                Some("Editing example code"),
            ),
        ]),
        tasks: Some(vec![
            task("t1", "coordinator", "running", question, 6),
            task(
                "t2",
                "monitoring",
                "running",
                "Summarise example alerts from the last hour",
                2,
            ),
            task(
                "t3",
                "linux",
                "completed",
                "Check free space on app-demo",
                30,
            ),
            task(
                "t4",
                "patching",
                "completed",
                "List pending security updates for the demo fleet",
                10,
            ),
        ]),
        actions: Some(vec![Action {
            id: "a1".into(),
            request_code: "ACT-DEMO0001".into(),
            agent_id: "id-linux".into(),
            task_id: Some("t1".into()),
            action: "Expand /data on app-demo by 10 GiB".into(),
            tool: "expand_disk".into(),
            approval_level: 2,
            risk: "high".into(),
            reason: Some("Example preview: verified device and capacity. Nothing has run.".into()),
            status: "pending".into(),
            source: "web".into(),
            requested_by: Some("demo-admin".into()),
            requested_at: ago(1),
            arguments: serde_json::json!({"disk_target_host": "app-demo", "disk_mount": "/data", "disk_add_gib": 10}),
            ..Default::default()
        }]),
        dev: Some(DevOverview {
            items: vec![Change {
                id: "p1".into(),
                title: "TLS certificate check tool".into(),
                status: "implemented".into(),
                stage: "ready_for_review".into(),
                summary: "Report certificate expiry without running openssl by hand.".into(),
                proposed_by: Some("Monitoring".into()),
                files: 4,
                added: 212,
                removed: 9,
                has_patch: true,
                ..Default::default()
            }],
            can_decide: true,
        }),
        providers: Some(vec![]),
        errors: vec![],
    })));
    app.on_msg(Msg::Conn(Conn::Live));
    app.on_msg(Msg::Event(AgentEvent {
        agent: "coordinator".into(),
        status: Some("working".into()),
        activity: Some("Asking Network to probe the upstream API".into()),
        event: Some("delegated".into()),
        peer: Some("network".into()),
        ..Default::default()
    }));
    app
}

fn css(color: Color, fallback: &str) -> String {
    const ANSI: [&str; 16] = [
        "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
    ];
    match color {
        Color::Reset => fallback.into(),
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::Indexed(i) if i < 16 => ANSI[i as usize].into(),
        Color::Indexed(i) if i >= 232 => {
            let v = 8 + (i - 232) * 10;
            format!("#{v:02x}{v:02x}{v:02x}")
        }
        Color::Indexed(i) => {
            let i = i - 16;
            let c = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
            format!("#{:02x}{:02x}{:02x}", c(i / 36), c((i / 6) % 6), c(i % 6))
        }
        named => {
            let order = [
                Color::Black,
                Color::Red,
                Color::Green,
                Color::Yellow,
                Color::Blue,
                Color::Magenta,
                Color::Cyan,
                Color::Gray,
                Color::DarkGray,
                Color::LightRed,
                Color::LightGreen,
                Color::LightYellow,
                Color::LightBlue,
                Color::LightMagenta,
                Color::LightCyan,
                Color::White,
            ];
            order
                .iter()
                .position(|c| *c == named)
                .map_or(fallback.into(), |i| ANSI[i].into())
        }
    }
}

fn html(app: &mut App) -> String {
    let mut t = Terminal::new(TestBackend::new(W, H)).unwrap();
    t.draw(|f| opstui::ui::draw(f, app)).unwrap();
    let buf = t.backend().buffer().clone();
    let mut out = String::from(
        "<!doctype html><meta charset=utf-8><style>body{margin:0;background:#0b0f17}\
         pre{margin:0;padding:14px 16px;font:15px/1.25 'DejaVu Sans Mono',monospace;color:#d4d4d4;background:#0b0f17}span{display:inline-block;width:1ch;overflow:visible;white-space:pre}</style><pre>",
    );
    for y in 0..H {
        for x in 0..W {
            let cell = &buf[(x, y)];
            let (mut fg, mut bg) = (css(cell.fg, "#d4d4d4"), css(cell.bg, "#0b0f17"));
            if cell.modifier.contains(Modifier::REVERSED) {
                std::mem::swap(&mut fg, &mut bg);
            }
            let weight = if cell.modifier.contains(Modifier::BOLD) {
                ";font-weight:bold"
            } else {
                ""
            };
            let text = cell
                .symbol()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            out.push_str(&format!(
                "<span style=\"color:{fg};background:{bg}{weight}\">{text}</span>"
            ));
        }
        out.push('\n');
    }
    out.push_str("</pre>");
    out
}

#[tokio::test]
#[ignore = "writes README images; run with OPSTUI_SCREENSHOT_DIR set"]
async fn write_readme_views() {
    let dir = std::env::var("OPSTUI_SCREENSHOT_DIR").expect("set OPSTUI_SCREENSHOT_DIR");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, view) in [("dashboard", '1'), ("floor", '9')] {
        let mut app = demo();
        key(&mut app, KeyCode::Char(view));
        std::fs::write(format!("{dir}/opstui-{name}.html"), html(&mut app)).unwrap();
    }
}
