//! ~/.config/opstui/config.toml. Holds no credentials: the password is typed
//! at every start and the session lives only in memory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Ops-Center base URL, without /api (e.g. https://ops.example.org).
    pub server: String,
    pub username: String,
    /// Label shown in the top bar (prod, staging, lab). Empty: server host.
    pub environment: String,
    /// Seconds between REST snapshots (agents, tasks, approvals).
    pub refresh_seconds: u64,
    /// Restrict CPU/RAM tiles to one Prometheus host; empty = average of all.
    pub metrics_host: String,
    /// Mouse capture (tabs, scrolling). Off keeps terminal text selection.
    pub mouse: bool,
    /// Local Claude Code agents (right-click → New Claude agent).
    pub claude_bin: String,
    /// Working directory new Claude agents start in.
    pub claude_dir: String,
    /// claude --permission-mode: auto, acceptEdits, manual, plan …
    pub claude_permission_mode: String,
    /// Claude agent that is always there from start; empty = none.
    pub claude_default_agent: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: String::new(),
            username: String::new(),
            environment: String::new(),
            refresh_seconds: 5,
            metrics_host: String::new(),
            mouse: true,
            claude_bin: "claude".into(),
            claude_dir: ".".into(),
            claude_permission_mode: "auto".into(),
            claude_default_agent: "Claude-external".into(),
        }
    }
}

pub fn path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("opstui").join("config.toml")
}

pub fn log_path() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("opstui").join("opstui.log")
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let p = path();
        match std::fs::read_to_string(&p) {
            Ok(text) => Self::parse(&text).map_err(|e| format!("{}: {e}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("{}: {e}", p.display())),
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let mut cfg: Config = toml::from_str(text).map_err(|e| e.to_string())?;
        cfg.server = normalize_server(&cfg.server);
        cfg.refresh_seconds = cfg.refresh_seconds.clamp(2, 300);
        Ok(cfg)
    }

    /// Writes the file only if it does not exist yet, so edits are never lost.
    pub fn write_template(&self) -> std::io::Result<PathBuf> {
        let p = path();
        if !p.exists() {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let body = toml::to_string(self).unwrap_or_default();
            std::fs::write(
                &p,
                format!("# opstui configuration. No passwords or tokens are stored here.\n{body}"),
            )?;
        }
        Ok(p)
    }

    pub fn env_label(&self) -> String {
        if !self.environment.is_empty() {
            return self.environment.clone();
        }
        host_of(&self.server).to_string()
    }
}

pub fn normalize_server(s: &str) -> String {
    let s = s.trim().trim_end_matches('/');
    let s = s.strip_suffix("/api").unwrap_or(s);
    if s.is_empty() || s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    }
}

pub fn host_of(server: &str) -> &str {
    let rest = server.split("://").nth(1).unwrap_or(server);
    rest.split(['/', ':']).next().unwrap_or(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_is_normalized() {
        assert_eq!(
            normalize_server("ops.example.org/"),
            "https://ops.example.org"
        );
        assert_eq!(
            normalize_server("http://localhost:8000/api"),
            "http://localhost:8000"
        );
        assert_eq!(host_of("https://ops.example.org:8443/x"), "ops.example.org");
    }

    #[test]
    fn defaults_and_clamping() {
        let c = Config::parse("server = \"ops.example.org\"\nrefresh_seconds = 0\n").unwrap();
        assert_eq!(c.server, "https://ops.example.org");
        assert_eq!(c.refresh_seconds, 2);
        assert!(c.mouse);
        assert_eq!(c.env_label(), "ops.example.org");
        assert_eq!(c.claude_default_agent, "Claude-external");
        assert!(Config::parse("server = 3").is_err());
    }
}
