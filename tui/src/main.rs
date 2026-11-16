//! opstui – Ops-Center terminal operator interface.

use opstui::{app, config, ui};

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    EventStream,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::prelude::CrosstermBackend;
use ratatui::Terminal;
use std::io::{stdout, IsTerminal};
use std::time::Duration;

const HELP: &str = "\
opstui – Ops-Center terminal operator interface

USAGE:
    opstui [OPTIONS]

OPTIONS:
    -s, --server <URL>   Ops-Center URL (overrides the config file)
    -u, --user <NAME>    Username to prefill
    -c, --config         Show the config file path and contents (creates a template)
    -V, --version        Print version
    -h, --help           Print this help

The password is asked for at every start and kept in memory only.
Config: ~/.config/opstui/config.toml   Log: ~/.local/state/opstui/opstui.log
Press ? inside the program for keyboard shortcuts.";

enum Cli {
    Run {
        server: Option<String>,
        user: Option<String>,
    },
    Exit(i32),
}

fn parse_args(args: &[String]) -> Cli {
    let mut server = None;
    let mut user = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a.as_str(), None),
        };
        match flag {
            "-h" | "--help" => {
                println!("{HELP}");
                return Cli::Exit(0);
            }
            "-V" | "--version" => {
                println!("opstui {}", env!("CARGO_PKG_VERSION"));
                return Cli::Exit(0);
            }
            "-c" | "--config" => {
                return Cli::Exit(show_config());
            }
            "-s" | "--server" | "-u" | "--user" => {
                let Some(v) = inline.or_else(|| it.next().cloned()) else {
                    eprintln!("opstui: {flag} needs a value");
                    return Cli::Exit(2);
                };
                if matches!(flag, "-s" | "--server") {
                    server = Some(v);
                } else {
                    user = Some(v);
                }
            }
            other => {
                eprintln!("opstui: unknown argument {other} (see --help)");
                return Cli::Exit(2);
            }
        }
    }
    Cli::Run { server, user }
}

fn show_config() -> i32 {
    let cfg = match config::Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("opstui: {e}");
            return 1;
        }
    };
    match cfg.write_template() {
        Ok(p) => {
            println!("# {}", p.display());
            print!("{}", std::fs::read_to_string(&p).unwrap_or_default());
            0
        }
        Err(e) => {
            eprintln!("opstui: cannot write {}: {e}", config::path().display());
            1
        }
    }
}

fn init_logging() {
    let path = config::log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path);
    if let Ok(file) = file {
        let filter = tracing_subscriber::EnvFilter::try_from_env("OPSTUI_LOG")
            .unwrap_or_else(|_| "opstui=info".into());
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .try_init();
    }
}

/// Restores the terminal on every exit path, including panics.
struct TermGuard {
    mouse: bool,
}

impl TermGuard {
    fn enter(mouse: bool) -> std::io::Result<Self> {
        enable_raw_mode()?;
        let mut out = stdout();
        execute!(out, EnterAlternateScreen, EnableBracketedPaste)?;
        if mouse {
            execute!(out, EnableMouseCapture)?;
        }
        Ok(Self { mouse })
    }
}

fn restore(mouse: bool) {
    let mut out = stdout();
    if mouse {
        let _ = execute!(out, DisableMouseCapture);
    }
    let _ = execute!(
        out,
        DisableBracketedPaste,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = disable_raw_mode();
}

impl Drop for TermGuard {
    fn drop(&mut self) {
        restore(self.mouse);
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (server, user) = match parse_args(&args) {
        Cli::Exit(code) => std::process::exit(code),
        Cli::Run { server, user } => (server, user),
    };
    if !stdout().is_terminal() {
        eprintln!("opstui: needs an interactive terminal");
        std::process::exit(1);
    }
    let mut cfg = match config::Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("opstui: config: {e}");
            std::process::exit(1);
        }
    };
    if let Some(s) = server {
        cfg.server = config::normalize_server(&s);
    }
    if let Some(u) = user {
        cfg.username = u;
    }
    init_logging();
    tracing::info!(server = %cfg.server, "opstui {} starting", env!("CARGO_PKG_VERSION"));

    let mouse = cfg.mouse;
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore(mouse);
        tracing::error!("panic: {info}");
        hook(info);
    }));

    let code = match run(cfg).await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("opstui: {e}");
            1
        }
    };
    tracing::info!("opstui exiting");
    std::process::exit(code);
}

async fn run(cfg: config::Config) -> std::io::Result<()> {
    let guard = TermGuard::enter(cfg.mouse)?;
    let mut term = Terminal::new(CrosstermBackend::new(stdout()))?;
    term.clear()?;
    let (tx, mut rx) = tokio::sync::mpsc::channel(4096);
    let mut app = app::App::new(cfg, tx);
    let mut input = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // kill, closed SSH session or terminal window: leave cleanly too.
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sighup = signal(SignalKind::hangup())?;
    loop {
        // Redraw after every input, message batch or clock tick; ratatui
        // writes only the cells that changed.
        term.draw(|f| ui::draw(f, &mut app))?;
        tokio::select! {
            ev = input.next() => match ev {
                Some(Ok(ev)) => app.on_term(ev),
                Some(Err(e)) => return Err(e),
                None => break,
            },
            Some(msg) = rx.recv() => {
                app.on_msg(msg);
                // Drain a burst before redrawing once.
                for _ in 0..256 {
                    match rx.try_recv() {
                        Ok(m) => app.on_msg(m),
                        Err(_) => break,
                    }
                }
            }
            _ = tick.tick() => app.on_tick(),
            _ = sigterm.recv() => break,
            _ = sighup.recv() => break,
        }
        if app.quit {
            break;
        }
    }
    // Stop local Claude agents before the terminal is handed back.
    if app.shutdown() {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    drop(term);
    drop(guard);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cli_parses_server_and_user() {
        match parse_args(&args(&["-s", "ops.example.org", "-u", "bob"])) {
            Cli::Run { server, user } => assert_eq!(
                (server.as_deref(), user.as_deref()),
                (Some("ops.example.org"), Some("bob"))
            ),
            Cli::Exit(_) => panic!("expected run"),
        }
        match parse_args(&args(&["--server=ops.example.org", "--user", "alice"])) {
            Cli::Run { server, user } => {
                assert_eq!(server.as_deref(), Some("ops.example.org"));
                assert_eq!(user.as_deref(), Some("alice"));
            }
            Cli::Exit(_) => panic!("expected run"),
        }
        assert!(matches!(parse_args(&args(&["--server"])), Cli::Exit(2)));
        assert!(matches!(parse_args(&args(&["--bogus"])), Cli::Exit(2)));
    }
}
