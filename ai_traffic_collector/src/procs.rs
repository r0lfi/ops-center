//! Best-effort socket -> process correlation by reading /proc (host PID
//! namespace): the container's own view of its sockets gives the inode for a
//! local port, and the file descriptors of the container's processes give the
//! PID holding it. Read-only; a connection that is already gone stays unresolved.

use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;
use std::time::{Duration, Instant};

pub struct Procs {
    proc_root: String,
    /// container id -> (pids, refreshed at)
    members: HashMap<String, (Vec<u32>, Instant)>,
}

#[derive(Debug, Clone)]
pub struct Owner {
    pub pid: u32,
    pub process: String,
}

impl Procs {
    pub fn new(proc_root: &str) -> Self {
        Procs { proc_root: proc_root.trim_end_matches('/').to_string(), members: HashMap::new() }
    }

    fn container_pids(&mut self, container_id: &str) -> Vec<u32> {
        if let Some((pids, at)) = self.members.get(container_id) {
            if at.elapsed() < Duration::from_secs(15) {
                return pids.clone();
            }
        }
        let mut pids = Vec::new();
        if let Ok(dir) = fs::read_dir(&self.proc_root) {
            for entry in dir.flatten() {
                let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
                if let Ok(cg) = fs::read_to_string(format!("{}/{pid}/cgroup", self.proc_root)) {
                    if cg.contains(container_id) {
                        pids.push(pid);
                    }
                }
            }
        }
        self.members.insert(container_id.to_string(), (pids.clone(), Instant::now()));
        pids
    }

    /// The process in `container_id` (whose network namespace `ns_pid` is in) owning a socket bound to ip:port.
    pub fn owner(&mut self, container_id: &str, ns_pid: u32, proto: u8, ip: IpAddr, port: u16) -> Option<Owner> {
        let inode = self.inode(ns_pid, proto, ip, port)?;
        let needle = format!("socket:[{inode}]");
        for pid in self.container_pids(container_id) {
            let Ok(fds) = fs::read_dir(format!("{}/{pid}/fd", self.proc_root)) else { continue };
            for fd in fds.flatten() {
                if fs::read_link(fd.path()).map(|l| l.to_string_lossy() == needle).unwrap_or(false) {
                    let comm = fs::read_to_string(format!("{}/{pid}/comm", self.proc_root)).unwrap_or_default();
                    let cmdline = fs::read(format!("{}/{pid}/cmdline", self.proc_root)).unwrap_or_default();
                    // Program and first arguments only, one line, short: never a whole inline script.
                    let args: Vec<String> = cmdline.split(|b| *b == 0).filter(|a| !a.is_empty()).take(4)
                        .map(|a| {
                            let a = String::from_utf8_lossy(a);
                            let a = if a.starts_with('/') { a.rsplit('/').next().unwrap_or("").to_string() } else { a.to_string() };
                            let a: String = a.split_whitespace().collect::<Vec<_>>().join(" ");
                            if a.chars().count() > 40 { a.chars().take(39).collect::<String>() + "…" } else { a }
                        })
                        .collect();
                    let process = if args.is_empty() { comm.trim().to_string() } else { args.join(" ") };
                    return Some(Owner { pid, process: process.chars().take(120).collect() });
                }
            }
        }
        None
    }

    fn inode(&self, ns_pid: u32, proto: u8, ip: IpAddr, port: u16) -> Option<u64> {
        let table = match (proto, ip.is_ipv4()) {
            (6, true) => "tcp",
            (6, false) => "tcp6",
            (17, true) => "udp",
            (17, false) => "udp6",
            _ => return None,
        };
        let text = fs::read_to_string(format!("{}/{ns_pid}/net/{table}", self.proc_root)).ok()?;
        let want = format!(":{port:04X}");
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 {
                continue;
            }
            if cols[1].ends_with(&want) {
                return cols[9].parse().ok().filter(|i| *i != 0);
            }
        }
        None
    }
}
