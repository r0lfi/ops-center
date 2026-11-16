//! ai-traffic-collector: passive observer of the network activity of Ops
//! Center's AI containers on one host.
//!
//! Sources, all read-only:
//! * conntrack NEW/DESTROY events over netlink: every connection the kernel
//!   tracks for an AI container, with byte counters when nf_conntrack_acct=1;
//! * a header-only packet capture on the container's bridges with a kernel
//!   filter for SYN/RST, DNS, TLS handshakes and ICMP errors only;
//! * the Docker API (GET only) for container names, addresses and bridges;
//! * /proc for the PID owning a socket.
//!
//! It never installs a rule, proxy, route or policy, never decrypts and never
//! keeps payload. Events are posted to ops-api, which merges them with the
//! AI worker's own observations of the same connection.

mod conntrack;
mod docker;
mod packet;
mod procs;
mod sink;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::fd::AsRawFd;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use conntrack::{CtEvent, CtStats, Tuple, IPS_SEEN_REPLY};
use packet::{Pkt, TCP_ACK, TCP_RST, TCP_SYN};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_FLOWS: usize = 50_000;
/// A SYN that conntrack has not confirmed after this long never left this host.
const UNCONFIRMED_AFTER: f64 = 3.0;
const EMIT_AFTER: f64 = 1.5;

enum Msg {
    Ct(CtEvent),
    Pkt(Pkt, f64),
    CaptureError(String, String),
}

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

fn log(msg: &str) {
    eprintln!("{} ai-traffic-collector: {msg}", now() as u64);
}

#[derive(Default)]
struct Flow {
    obs_id: String,
    first: f64,
    container: String,
    ct_id: Option<u32>,
    confirmed: bool,
    syn_at: Option<f64>,
    synack: bool,
    rst_remote: bool,
    icmp: Option<(u8, u8, IpAddr)>,
    sni: Option<String>,
    alpn: Vec<String>,
    tls_version: Option<u16>,
    pid: Option<u32>,
    process: Option<String>,
    emitted: bool,
    dirty: bool,
    finished: Option<f64>,
    status: u32,
    bytes_out: Option<u64>,
    bytes_in: Option<u64>,
    packets_out: Option<u64>,
    packets_in: Option<u64>,
    reply_src: Option<IpAddr>,
    nat_src: Option<IpAddr>,
    outcome: Option<(&'static str, String)>,
}

struct Pending {
    ts: f64,
    qname: String,
    qtype: u16,
    resolver: IpAddr,
    src: IpAddr,
    sport: u16,
}

#[derive(Clone)]
struct CaptureShared {
    filter: Arc<Mutex<String>>,
    generation: Arc<AtomicU64>,
    stats: Arc<Mutex<HashMap<String, Value>>>,
}

struct State {
    node: String,
    containers: Vec<docker::Container>,
    by_ip: HashMap<IpAddr, usize>,
    flows: HashMap<Tuple, Flow>,
    dns_pending: HashMap<(IpAddr, u16, u16), Pending>,
    names: HashMap<IpAddr, (String, f64)>,
    procs: procs::Procs,
    ct_stats: Arc<CtStats>,
    overruns_seen: u64,
    last_overrun_at: f64,
    flows_evicted: u64,
    sink: sink::Sink,
}

impl State {
    fn ai(&self, ip: &IpAddr) -> Option<&docker::Container> {
        self.by_ip.get(ip).map(|i| &self.containers[*i])
    }

    fn local_dst(&self, ip: &IpAddr) -> bool {
        self.containers.iter().flat_map(|c| c.subnets.iter()).any(|n| docker::in_subnet(ip, n))
    }

    fn flow(&mut self, key: Tuple, ts: f64) -> &mut Flow {
        if !self.flows.contains_key(&key) && self.flows.len() >= MAX_FLOWS {
            if let Some(oldest) = self.flows.iter().min_by(|a, b| a.1.first.total_cmp(&b.1.first)).map(|(k, _)| *k) {
                self.flows.remove(&oldest);
                self.flows_evicted += 1;
            }
        }
        let container = self.ai(&key.src).map(|c| c.name.clone()).unwrap_or_default();
        self.flows.entry(key).or_insert_with(|| Flow {
            obs_id: format!("{:x}-{}-{}", (ts * 1000.0) as u64, key.sport, key.dport),
            first: ts,
            container,
            ..Default::default()
        })
    }

    fn resolve_owner(&mut self, key: &Tuple) {
        let Some(c) = self.ai(&key.src).cloned() else { return };
        if self.flows.get(key).map(|f| f.pid.is_some()).unwrap_or(true) {
            return;
        }
        if let Some(owner) = self.procs.owner(&c.id, c.pid, key.proto, key.src, key.sport) {
            if let Some(f) = self.flows.get_mut(key) {
                f.pid = Some(owner.pid);
                f.process = Some(owner.process);
            }
        }
    }

    fn on_ct(&mut self, ev: CtEvent) {
        if self.ai(&ev.orig.src).is_none() {
            return;
        }
        let ts = now();
        let key = ev.orig;
        {
            let f = self.flow(key, ts);
            f.ct_id = Some(ev.id);
            f.confirmed = true;
            f.status |= ev.status;
            if let Some(reply) = ev.reply {
                f.reply_src = Some(reply.src);
                if reply.dst != key.src {
                    f.nat_src = Some(reply.dst);
                }
            }
        }
        if !ev.destroy {
            self.resolve_owner(&key);
            return;
        }
        let f = self.flows.get_mut(&key).unwrap();
        f.bytes_out = ev.orig_bytes;
        f.bytes_in = ev.reply_bytes;
        f.packets_out = ev.orig_packets;
        f.packets_in = ev.reply_packets;
        f.finished = Some(ts);
        f.outcome = Some(destroy_outcome(f, key.proto));
        f.dirty = true;
    }

    fn on_pkt(&mut self, pkt: Pkt, ts: f64) {
        match pkt {
            Pkt::Tcp { src, dst, sport, dport, flags } => {
                if self.ai(&src).is_some() && flags & TCP_SYN != 0 && flags & TCP_ACK == 0 {
                    let key = Tuple { src, dst, proto: 6, sport, dport };
                    let f = self.flow(key, ts);
                    f.syn_at.get_or_insert(ts);
                } else if self.ai(&dst).is_some() {
                    let key = Tuple { src: dst, dst: src, proto: 6, sport: dport, dport: sport };
                    if let Some(f) = self.flows.get_mut(&key) {
                        if flags & TCP_SYN != 0 && flags & TCP_ACK != 0 {
                            f.synack = true;
                        } else if flags & TCP_RST != 0 && !f.synack {
                            f.rst_remote = true;
                            if f.outcome.is_none() {
                                f.outcome = Some(("connect_error", "connection refused: the remote answered the SYN with a TCP RST".into()));
                            }
                            f.dirty = true;
                        }
                    }
                }
            }
            Pkt::Tls { src, dst, sport, dport, sni, alpn, version } => {
                if self.ai(&src).is_some() {
                    let key = Tuple { src, dst, proto: 6, sport, dport };
                    let f = self.flow(key, ts);
                    f.sni = sni;
                    f.alpn = alpn;
                    f.tls_version = Some(version);
                    f.dirty = true;
                }
            }
            Pkt::Unreachable { from, icmp_type, code, inner_src, inner_dst, proto, sport, dport } => {
                if self.ai(&inner_src).is_none() {
                    return;
                }
                let key = Tuple { src: inner_src, dst: inner_dst, proto, sport, dport };
                let f = self.flow(key, ts);
                f.icmp = Some((icmp_type, code, from));
                // An ICMP error is the answer: classify now rather than when conntrack expires the entry.
                f.outcome = icmp_outcome(f);
                f.dirty = true;
            }
            Pkt::Dns { src, dst, sport, dport, msg } => {
                if !msg.response && self.ai(&src).is_some() && dport == 53 {
                    self.dns_pending.insert((src, sport, msg.id), Pending { ts, qname: msg.qname, qtype: msg.qtype, resolver: dst, src, sport });
                } else if msg.response && self.ai(&dst).is_some() && sport == 53 {
                    if let Some(p) = self.dns_pending.remove(&(dst, dport, msg.id)) {
                        for ip in &msg.answers {
                            self.names.insert(*ip, (p.qname.clone(), ts));
                        }
                        let (outcome, reason) = dns_outcome(&msg);
                        self.emit_dns(&p, ts, outcome, reason, Some(&msg));
                    }
                }
            }
        }
    }

    fn emit_dns(&mut self, p: &Pending, ts: f64, outcome: &str, reason: Option<String>, msg: Option<&packet::Dns>) {
        let container = self.ai(&p.src).map(|c| c.name.clone());
        let answers: Vec<String> = msg.map(|m| m.answers.iter().map(|a| a.to_string()).collect()).unwrap_or_default();
        let event = json!({
            "type": "event", "source": "capture", "obs_id": format!("dns-{:x}-{}", (p.ts * 1000.0) as u64, p.sport),
            "ts": p.ts, "ended_at": ts, "duration_ms": ((ts - p.ts) * 1000.0) as i64, "node": self.node, "kind": "dns",
            "container": container, "src_ip": p.src.to_string(), "src_port": p.sport, "dst_ip": p.resolver.to_string(),
            "dst_port": 53, "dst_host": p.qname, "protocol": "dns", "outcome": outcome, "reason": reason,
            "detail": {"qtype": qtype_name(p.qtype), "rcode": msg.map(|m| rcode_name(m.rcode)), "answers": answers, "resolver": p.resolver.to_string()},
        });
        self.sink.push(event);
    }

    fn emit_flow(&mut self, key: Tuple) {
        let node = self.node.clone();
        let name = self.names.get(&key.dst).map(|(n, _)| n.clone());
        let Some(f) = self.flows.get_mut(&key) else { return };
        let ts_end = f.finished;
        let (outcome, reason) = f.outcome.clone().unwrap_or(("ok", String::new()));
        let protocol = if f.sni.is_some() || f.tls_version.is_some() {
            "tls"
        } else if key.proto == 6 {
            "tcp"
        } else if key.proto == 17 {
            if key.dport == 53 { "dns" } else { "udp" }
        } else {
            "ip"
        };
        let mut detail = json!({
            "conntrack_id": f.ct_id, "confirmed_by_conntrack": f.confirmed,
            "seen_reply": f.status & IPS_SEEN_REPLY != 0,
            "packets_sent": f.packets_out, "packets_recv": f.packets_in,
        });
        if let Some(s) = &f.sni { detail["tls_sni"] = json!(s); }
        if !f.alpn.is_empty() { detail["tls_alpn"] = json!(f.alpn); }
        if let Some(v) = f.tls_version { detail["tls_version"] = json!(tls_name(v)); }
        if let Some(n) = &name { detail["dns_name"] = json!(n); }
        if let Some(ip) = f.nat_src { detail["nat_source"] = json!(ip.to_string()); }
        if let Some((t, c, from)) = f.icmp { detail["icmp"] = json!({"type": t, "code": c, "from": from.to_string()}); }
        if f.bytes_out.is_none() && f.finished.is_some() { detail["bytes_note"] = json!("kernel byte counters off (nf_conntrack_acct=0)"); }
        let event = json!({
            "type": "event", "source": "capture", "obs_id": f.obs_id, "ts": f.first, "node": node,
            "kind": if key.proto == 17 { "udp" } else { "tcp" },
            "ended_at": ts_end, "duration_ms": ts_end.map(|e| ((e - f.first) * 1000.0) as i64),
            "container": f.container, "pid": f.pid, "process": f.process,
            "src_ip": key.src.to_string(), "src_port": key.sport, "dst_ip": key.dst.to_string(), "dst_port": key.dport,
            "dst_host": f.sni.clone().or(name), "protocol": protocol,
            "bytes_sent": f.bytes_out, "bytes_recv": f.bytes_in,
            "outcome": outcome, "reason": if reason.is_empty() { Value::Null } else { json!(reason) },
            "detail": detail,
        });
        f.emitted = true;
        f.dirty = false;
        self.sink.push(event);
    }

    fn housekeeping(&mut self) {
        let t = now();
        let overruns = self.ct_stats.overruns.load(Ordering::Relaxed);
        if overruns != self.overruns_seen {
            self.overruns_seen = overruns;
            self.last_overrun_at = t;
        }
        let keys: Vec<Tuple> = self.flows.keys().cloned().collect();
        let mut remove = Vec::new();
        for key in keys {
            let local = self.local_dst(&key.dst);
            let recent_overrun = t - self.last_overrun_at < 30.0;
            let f = self.flows.get_mut(&key).unwrap();
            let age = t - f.first;
            if f.finished.is_none() && !f.confirmed && f.syn_at.is_some() && age >= UNCONFIRMED_AFTER && f.outcome.is_none() {
                // The SYN was on the bridge but the kernel never confirmed the connection.
                f.finished = Some(t);
                f.outcome = Some(unconfirmed_outcome(f, local, recent_overrun));
                f.dirty = true;
            }
            let ready = f.finished.is_some() || (f.confirmed && age >= EMIT_AFTER);
            if ready && (!f.emitted || f.dirty) {
                self.emit_flow(key);
            }
            let f = &self.flows[&key];
            if let Some(end) = f.finished {
                if t - end > 60.0 {
                    remove.push(key);
                }
            } else if !f.confirmed && age > 120.0 {
                remove.push(key);
            }
        }
        for k in remove {
            self.flows.remove(&k);
        }
        let stale: Vec<_> = self.dns_pending.iter().filter(|(_, p)| t - p.ts > 5.0).map(|(k, _)| *k).collect();
        for k in stale {
            if let Some(p) = self.dns_pending.remove(&k) {
                self.emit_dns(&p, t, "timeout", Some("DNS query got no response within 5 s".into()), None);
            }
        }
        self.names.retain(|_, (_, at)| t - *at < 3600.0);
    }
}

fn destroy_outcome(f: &Flow, proto: u8) -> (&'static str, String) {
    if let Some(o) = icmp_outcome(f) {
        return o;
    }
    if proto == 6 && f.rst_remote && !f.synack {
        return ("connect_error", "connection refused: the remote answered the SYN with a TCP RST".into());
    }
    if f.status & IPS_SEEN_REPLY == 0 {
        if proto == 6 {
            return ("timeout", "no reply: the SYN was never answered and the conntrack entry expired".into());
        }
        return ("ok", "no UDP reply observed".into());
    }
    ("ok", String::new())
}

fn icmp_outcome(f: &Flow) -> Option<(&'static str, String)> {
    let (t, code, from) = f.icmp?;
    // ICMPv4 3/9, 3/10, 3/13 and ICMPv6 1/1 are explicit "administratively prohibited" rejects.
    let prohibited = (t == 3 && matches!(code, 9 | 10 | 13)) || (t == 1 && code == 1);
    if prohibited {
        return Some(("firewall_block", format!("rejected by a firewall: ICMP {t}/{code} (administratively prohibited) from {from}")));
    }
    let what = match (t, code) {
        (3, 0) => "network unreachable",
        (3, 1) => "host unreachable",
        (3, 3) | (1, 4) => "port unreachable",
        (1, 0) => "no route",
        (1, 3) => "address unreachable",
        _ => "destination unreachable",
    };
    Some(("connect_error", format!("{what}: ICMP {t}/{code} from {from}")))
}

fn unconfirmed_outcome(f: &Flow, local_dst: bool, recent_overrun: bool) -> (&'static str, String) {
    if let Some(o) = icmp_outcome(f) {
        return o;
    }
    if recent_overrun {
        return ("unknown", "SYN seen but no conntrack entry; conntrack events were lost at the time, so the cause cannot be told".into());
    }
    if local_dst {
        return ("unknown", "SYN to a container on the same bridge was not confirmed by conntrack (bridge traffic may bypass netfilter)".into());
    }
    ("firewall_block", "dropped on this host: the SYN reached the container bridge but the kernel never confirmed the connection and no ICMP error was returned (a netfilter DROP; no drop log names the rule)".into())
}

fn dns_outcome(m: &packet::Dns) -> (&'static str, Option<String>) {
    let null = m.answers.iter().any(|a| a.is_unspecified());
    match m.rcode {
        0 if null => ("dns_block", Some("the resolver answered with a null address (0.0.0.0/::), how Pi-hole blocks a domain".into())),
        0 => ("ok", None),
        3 => ("dns_error", Some("NXDOMAIN: the name does not exist (a blocklist in NXDOMAIN mode looks the same)".into())),
        2 => ("dns_error", Some("SERVFAIL from the resolver".into())),
        5 => ("dns_error", Some("REFUSED by the resolver".into())),
        r => ("dns_error", Some(format!("DNS rcode {r}"))),
    }
}

fn rcode_name(r: u8) -> &'static str {
    match r { 0 => "NOERROR", 1 => "FORMERR", 2 => "SERVFAIL", 3 => "NXDOMAIN", 4 => "NOTIMP", 5 => "REFUSED", _ => "OTHER" }
}

fn qtype_name(t: u16) -> String {
    match t { 1 => "A".into(), 28 => "AAAA".into(), 5 => "CNAME".into(), 33 => "SRV".into(), 65 => "HTTPS".into(), 16 => "TXT".into(), o => o.to_string() }
}

fn tls_name(v: u16) -> &'static str {
    match v { 0x0304 => "TLS 1.3", 0x0303 => "TLS 1.2", 0x0302 => "TLS 1.1", 0x0301 => "TLS 1.0", _ => "TLS" }
}

fn bpf_filter(ips: &[IpAddr]) -> String {
    let v4: Vec<String> = ips.iter().filter(|i| i.is_ipv4()).map(|i| format!("host {i}")).collect();
    if v4.is_empty() {
        return "less 1".into(); // matches nothing
    }
    format!(
        "({}) and (udp port 53 or icmp or (tcp[tcpflags] & (tcp-syn|tcp-rst) != 0) or (tcp and tcp[((tcp[12:1] & 0xf0) >> 2):1] = 0x16))",
        v4.join(" or ")
    )
}

fn capture_thread(iface: String, shared: CaptureShared, stop: Arc<AtomicBool>, tx: Sender<Msg>) {
    let opened = pcap::Capture::from_device(iface.as_str())
        // No immediate mode: with it libpcap ignores the timeout, and a bridge without matching
        // packets would block the thread forever (no stats, no filter updates, no stop).
        .and_then(|c| c.promisc(false).snaplen(700).timeout(250).buffer_size(4 << 20).open());
    // Non-blocking reads plus poll(): on Linux (TPACKET_V3) the pcap timeout only flushes a
    // buffer that already holds packets, so a blocking read on a quiet bridge never returns.
    let mut cap = match opened.and_then(|c| c.setnonblock()) {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Msg::CaptureError(iface.clone(), e.to_string()));
            return;
        }
    };
    let fd = cap.as_raw_fd();
    let cooked = cap.get_datalink().0 == 113;
    let mut generation = u64::MAX;
    let mut last_stats = Instant::now() - Duration::from_secs(60);
    let mut packets: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        let g = shared.generation.load(Ordering::Relaxed);
        if g != generation {
            let expr = shared.filter.lock().unwrap().clone();
            if let Err(e) = cap.filter(&expr, true) {
                let _ = tx.send(Msg::CaptureError(iface.clone(), format!("filter: {e}")));
                return;
            }
            generation = g;
        }
        match cap.next_packet() {
            Ok(p) => {
                packets += 1;
                let ts = p.header.ts.tv_sec as f64 + p.header.ts.tv_usec as f64 / 1e6;
                if let Some(pkt) = packet::parse_frame(p.data, cooked) {
                    if tx.send(Msg::Pkt(pkt, ts)).is_err() {
                        return;
                    }
                }
            }
            Err(pcap::Error::TimeoutExpired) | Err(pcap::Error::NoMorePackets) => {
                let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                unsafe { libc::poll(&mut pfd, 1, 250) };
            }
            Err(e) => {
                let _ = tx.send(Msg::CaptureError(iface.clone(), e.to_string()));
                return;
            }
        }
        if last_stats.elapsed() > Duration::from_secs(10) {
            last_stats = Instant::now();
            if let Ok(s) = cap.stats() {
                shared.stats.lock().unwrap().insert(iface.clone(), json!({
                    "interface": iface, "packets": packets, "kernel_received": s.received,
                    "kernel_dropped": s.dropped, "interface_dropped": s.if_dropped, "status": "capturing",
                }));
            }
        }
    }
}

/// Bounded, header-only PCAP of the AI containers' traffic, requested by an administrator.
fn run_pcap(api: sink::Sink, id: String, seconds: u64, max_bytes: u64, bridges: Vec<String>, ips: Vec<IpAddr>) {
    let expr: Vec<String> = ips.iter().filter(|i| i.is_ipv4()).map(|i| format!("host {i}")).collect();
    let path = format!("/tmp/ai-traffic-{}.pcap", id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
    let result = (|| -> Result<u64, String> {
        if expr.is_empty() || bridges.is_empty() {
            return Err("no AI container addresses to capture".into());
        }
        let mut caps = Vec::new();
        for b in &bridges {
            let c = pcap::Capture::from_device(b.as_str()).and_then(|c| c.promisc(false).snaplen(128).timeout(100).immediate_mode(true).open())
                .map_err(|e| format!("{b}: {e}"))?;
            let mut c = c.setnonblock().map_err(|e| e.to_string())?;
            c.filter(&expr.join(" or "), true).map_err(|e| e.to_string())?;
            caps.push(c);
        }
        let mut save = caps[0].savefile(&path).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let (mut size, mut count) = (24u64, 0u64);
        'outer: while Instant::now() < deadline {
            let mut idle = true;
            for c in caps.iter_mut() {
                while let Ok(p) = c.next_packet() {
                    idle = false;
                    size += 16 + p.header.caplen as u64;
                    if size > max_bytes {
                        break 'outer;
                    }
                    save.write(&p);
                    count += 1;
                }
            }
            if idle {
                thread::sleep(Duration::from_millis(20));
            }
        }
        save.flush().map_err(|e| e.to_string())?;
        Ok(count)
    })();
    let (status, count, error, body) = match result {
        Ok(n) => ("done", n, String::new(), fs::read(&path).unwrap_or_default()),
        Err(e) => ("failed", 0, e, Vec::new()),
    };
    let _ = fs::remove_file(&path);
    let headers = [("X-Capture-Status", status.to_string()), ("X-Capture-Packets", count.to_string()),
                   ("X-Capture-Error", error.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).take(200).collect())];
    match api.request("POST", &format!("/api/ai-traffic/collector/captures/{id}"), "application/vnd.tcpdump.pcap", &body, &headers) {
        Ok(r) if r.status == 200 => log(&format!("capture {id}: {status}, {count} packets")),
        Ok(r) => log(&format!("capture {id}: upload HTTP {}", r.status)),
        Err(e) => log(&format!("capture {id}: upload failed: {e}")),
    }
}

fn read_flag(path: &str) -> Value {
    match fs::read_to_string(path) {
        Ok(v) => json!(v.trim() == "1"),
        Err(_) => Value::Null,
    }
}

fn main() {
    let node = env("AI_TRAFFIC_NODE", "");
    let token = env("AI_TRAFFIC_INGEST_TOKEN", "");
    if node.is_empty() || token.is_empty() {
        log("AI_TRAFFIC_NODE and AI_TRAFFIC_INGEST_TOKEN must be set; idling without collecting");
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    }
    let api_base = env("AI_TRAFFIC_API", "http://127.0.0.1:8080");
    let socket = env("DOCKER_SOCKET", "/var/run/docker.sock");
    let proc_root = env("PROC_ROOT", "/proc");
    let names: Vec<String> = env("AI_TRAFFIC_CONTAINERS", "ops-center-ai-worker").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let capture_enabled = env("AI_TRAFFIC_CAPTURE", "1") != "0";
    let started = now();

    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = channel();
    let ct_stats = Arc::new(CtStats::default());
    let ct_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    {
        let (tx, stats, err) = (tx.clone(), ct_stats.clone(), ct_error.clone());
        thread::spawn(move || {
            let (ctx, crx) = channel();
            let forward = thread::spawn(move || {
                for ev in crx {
                    if tx.send(Msg::Ct(ev)).is_err() {
                        break;
                    }
                }
            });
            if let Err(e) = conntrack::listen(ctx, stats) {
                log(&format!("conntrack listener stopped: {e}"));
                *err.lock().unwrap() = Some(e.to_string());
            }
            let _ = forward.join();
        });
    }

    let shared = CaptureShared { filter: Arc::new(Mutex::new(bpf_filter(&[]))), generation: Arc::new(AtomicU64::new(1)), stats: Arc::new(Mutex::new(HashMap::new())) };
    let mut captures: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    let mut capture_errors: HashMap<String, String> = HashMap::new();
    let new_sink = || sink::Sink {
        base: api_base.clone(), token: token.clone(), node: node.clone(), buffer: Default::default(), limit: 20_000,
        dropped: 0, sent: 0, post_failures: 0, last_error: None,
    };
    let mut st = State {
        node: node.clone(), containers: Vec::new(), by_ip: HashMap::new(), flows: HashMap::new(), dns_pending: HashMap::new(),
        names: HashMap::new(), procs: procs::Procs::new(&proc_root), ct_stats: ct_stats.clone(), overruns_seen: 0,
        last_overrun_at: 0.0, flows_evicted: 0, sink: new_sink(),
    };
    let pcap_running = Arc::new(AtomicBool::new(false));
    let mut docker_error: Option<String> = None;
    let (mut last_docker, mut last_flush, mut last_house, mut last_poll) = (Instant::now() - Duration::from_secs(600), Instant::now(), Instant::now(), Instant::now());
    log(&format!("started on {node}, watching {names:?}, posting to {api_base}"));

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Msg::Ct(ev)) => st.on_ct(ev),
            Ok(Msg::Pkt(p, ts)) => st.on_pkt(p, ts),
            Ok(Msg::CaptureError(iface, e)) => {
                log(&format!("capture on {iface}: {e}"));
                captures.remove(&iface);
                capture_errors.insert(iface, e);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if last_docker.elapsed() > Duration::from_secs(30) {
            last_docker = Instant::now();
            match docker::discover(&socket, &names, "ops-center.ai-traffic") {
                Ok(list) => {
                    docker_error = None;
                    st.by_ip = list.iter().enumerate().flat_map(|(i, c)| c.ips.iter().map(move |ip| (*ip, i))).collect();
                    let ips: Vec<IpAddr> = st.by_ip.keys().cloned().collect();
                    let expr = bpf_filter(&ips);
                    if *shared.filter.lock().unwrap() != expr {
                        *shared.filter.lock().unwrap() = expr;
                        shared.generation.fetch_add(1, Ordering::Relaxed);
                    }
                    let wanted: HashSet<String> = list.iter().flat_map(|c| c.bridges.iter().cloned()).collect();
                    st.containers = list;
                    if capture_enabled {
                        captures.retain(|iface, stop| {
                            let keep = wanted.contains(iface);
                            if !keep { stop.store(true, Ordering::Relaxed); }
                            keep
                        });
                        for iface in wanted {
                            if !captures.contains_key(&iface) {
                                capture_errors.remove(&iface);
                                let stop = Arc::new(AtomicBool::new(false));
                                captures.insert(iface.clone(), stop.clone());
                                let (sh, txc) = (shared.clone(), tx.clone());
                                thread::spawn(move || capture_thread(iface, sh, stop, txc));
                            }
                        }
                    }
                }
                Err(e) => docker_error = Some(e),
            }
        }
        if last_house.elapsed() >= Duration::from_secs(1) {
            last_house = Instant::now();
            st.housekeeping();
        }
        if last_flush.elapsed() >= Duration::from_secs(2) || st.sink.buffer.len() >= 500 {
            last_flush = Instant::now();
            let mut ifaces: Vec<Value> = shared.stats.lock().unwrap().values().cloned().collect();
            for (iface, e) in &capture_errors {
                ifaces.push(json!({"interface": iface, "status": "error", "error": e}));
            }
            let source = json!({
                "version": VERSION, "started_at": started, "capture_enabled": capture_enabled,
                "containers": st.containers.iter().map(|c| json!({"name": c.name, "ips": c.ips.iter().map(|i| i.to_string()).collect::<Vec<_>>(), "bridges": c.bridges, "pid": c.pid})).collect::<Vec<_>>(),
                "docker_error": docker_error,
                "interfaces": ifaces,
                "conntrack": {
                    "listening": ct_error.lock().unwrap().is_none(), "error": *ct_error.lock().unwrap(),
                    "events": ct_stats.events.load(Ordering::Relaxed), "overruns": ct_stats.overruns.load(Ordering::Relaxed),
                    "errors": ct_stats.errors.load(Ordering::Relaxed),
                    "acct": read_flag(&format!("{proc_root}/sys/net/netfilter/nf_conntrack_acct")),
                    "bridge_nf_call_iptables": read_flag(&format!("{proc_root}/sys/net/bridge/bridge-nf-call-iptables")),
                },
                "flows": st.flows.len(), "flows_evicted": st.flows_evicted, "buffer": st.sink.buffer.len(),
                "dropped": st.sink.dropped, "sent": st.sink.sent, "post_failures": st.sink.post_failures,
                "last_error": st.sink.last_error,
                "pcap_running": pcap_running.load(Ordering::Relaxed),
            });
            while st.sink.flush(500, source.clone()) && !st.sink.buffer.is_empty() {}
        }
        if last_poll.elapsed() >= Duration::from_secs(5) && !pcap_running.load(Ordering::Relaxed) {
            last_poll = Instant::now();
            if let Ok(r) = st.sink.request("GET", "/api/ai-traffic/collector/captures", "application/json", b"", &[]) {
                if r.status == 200 {
                    let pending: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
                    if let Some(c) = pending["captures"].as_array().and_then(|a| a.first()) {
                        let id = c["id"].as_str().unwrap_or_default().to_string();
                        let seconds = c["seconds"].as_u64().unwrap_or(30).clamp(1, 300);
                        let max_bytes = c["max_bytes"].as_u64().unwrap_or(5 << 20).clamp(1024, 20 << 20);
                        let bridges: Vec<String> = st.containers.iter().flat_map(|c| c.bridges.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
                        let ips: Vec<IpAddr> = st.by_ip.keys().cloned().collect();
                        let api = new_sink();
                        let running = pcap_running.clone();
                        running.store(true, Ordering::Relaxed);
                        thread::spawn(move || {
                            run_pcap(api, id, seconds, max_bytes, bridges, ips);
                            running.store(false, Ordering::Relaxed);
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow() -> Flow {
        Flow { syn_at: Some(1.0), ..Default::default() }
    }

    #[test]
    fn unanswered_syn_is_a_timeout_not_a_block() {
        let f = flow();
        assert_eq!(destroy_outcome(&f, 6).0, "timeout");
    }

    #[test]
    fn rst_before_synack_is_refused() {
        let f = Flow { rst_remote: true, status: IPS_SEEN_REPLY, ..flow() };
        assert_eq!(destroy_outcome(&f, 6).0, "connect_error");
    }

    #[test]
    fn admin_prohibited_icmp_is_a_firewall_block() {
        let f = Flow { icmp: Some((3, 13, "198.51.100.1".parse().unwrap())), ..flow() };
        assert_eq!(destroy_outcome(&f, 6).0, "firewall_block");
        let f = Flow { icmp: Some((3, 1, "198.51.100.1".parse().unwrap())), ..flow() };
        assert_eq!(destroy_outcome(&f, 6).0, "connect_error");
    }

    #[test]
    fn unconfirmed_syn_needs_clean_evidence_to_count_as_a_drop() {
        let f = flow();
        assert_eq!(unconfirmed_outcome(&f, false, false).0, "firewall_block");
        assert_eq!(unconfirmed_outcome(&f, false, true).0, "unknown");
        assert_eq!(unconfirmed_outcome(&f, true, false).0, "unknown");
    }

    #[test]
    fn null_answer_is_a_dns_block_and_nxdomain_an_error() {
        let mut m = packet::Dns { id: 1, response: true, rcode: 0, qname: "x".into(), qtype: 1, answers: vec!["0.0.0.0".parse().unwrap()] };
        assert_eq!(dns_outcome(&m).0, "dns_block");
        m.answers.clear();
        m.rcode = 3;
        assert_eq!(dns_outcome(&m).0, "dns_error");
    }

    #[test]
    fn filter_only_selects_ai_addresses() {
        let f = bpf_filter(&["203.0.113.5".parse().unwrap()]);
        assert!(f.starts_with("(host 203.0.113.5)"));
        assert_eq!(bpf_filter(&[]), "less 1");
    }
}
