//! Read-only Docker Engine API client over the unix socket: lists the AI
//! containers, their addresses and bridges. Only GET requests are sent.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub pid: u32,
    pub ips: Vec<IpAddr>,
    pub bridges: Vec<String>,
    /// Bridge subnets as (network, prefix length): destinations inside them never leave the host.
    pub subnets: Vec<(IpAddr, u8)>,
}

pub fn get(socket: &str, path: &str) -> Result<Value, String> {
    let mut s = UnixStream::connect(socket).map_err(|e| format!("docker socket: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    s.set_write_timeout(Some(Duration::from_secs(5))).ok();
    write!(s, "GET {path} HTTP/1.0\r\nHost: docker\r\nAccept: application/json\r\n\r\n").map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad docker response")?;
    let head = String::from_utf8_lossy(&buf[..split]);
    if !head.starts_with("HTTP/1.0 200") && !head.starts_with("HTTP/1.1 200") {
        return Err(head.lines().next().unwrap_or("docker error").to_string());
    }
    serde_json::from_slice(&buf[split + 4..]).map_err(|e| e.to_string())
}

pub fn discover(socket: &str, names: &[String], label: &str) -> Result<Vec<Container>, String> {
    let list = get(socket, "/containers/json")?;
    let mut networks: HashMap<String, (String, Vec<(IpAddr, u8)>)> = HashMap::new();
    let mut out = Vec::new();
    for c in list.as_array().cloned().unwrap_or_default() {
        let name = c["Names"].as_array().and_then(|n| n.first()).and_then(|n| n.as_str()).unwrap_or("").trim_start_matches('/').to_string();
        let labelled = c["Labels"].get(label).and_then(|v| v.as_str()) == Some("1");
        if !labelled && !names.iter().any(|n| n == &name) {
            continue;
        }
        let id = c["Id"].as_str().unwrap_or("").to_string();
        let inspect = get(socket, &format!("/containers/{id}/json"))?;
        let pid = inspect["State"]["Pid"].as_u64().unwrap_or(0) as u32;
        let mut ips = Vec::new();
        let mut bridges = Vec::new();
        let mut subnets = Vec::new();
        if let Some(nets) = inspect["NetworkSettings"]["Networks"].as_object() {
            for net in nets.values() {
                if let Some(ip) = net["IPAddress"].as_str().and_then(|s| s.parse().ok()) {
                    ips.push(ip);
                }
                let Some(nid) = net["NetworkID"].as_str() else { continue };
                if !networks.contains_key(nid) {
                    let n = get(socket, &format!("/networks/{nid}"))?;
                    let bridge = n["Options"]["com.docker.network.bridge.name"].as_str().map(str::to_string)
                        .unwrap_or_else(|| format!("br-{}", &nid[..12.min(nid.len())]));
                    let nets = n["IPAM"]["Config"].as_array().cloned().unwrap_or_default().iter()
                        .filter_map(|cfg| cfg["Subnet"].as_str().and_then(parse_cidr)).collect();
                    networks.insert(nid.to_string(), (bridge, nets));
                }
                let (bridge, nets) = &networks[nid];
                bridges.push(bridge.clone());
                subnets.extend(nets.iter().cloned());
            }
        }
        out.push(Container { id, name, pid, ips, bridges, subnets });
    }
    Ok(out)
}

pub fn parse_cidr(s: &str) -> Option<(IpAddr, u8)> {
    let (ip, len) = s.split_once('/')?;
    Some((ip.parse().ok()?, len.parse().ok()?))
}

pub fn in_subnet(ip: &IpAddr, net: &(IpAddr, u8)) -> bool {
    match (ip, net.0) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let bits = net.1.min(32) as u32;
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
            (u32::from(*a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let bits = net.1.min(128) as u32;
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            (u128::from(*a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnet_membership() {
        let net = parse_cidr("203.0.113.0/24").unwrap();
        assert!(in_subnet(&"203.0.113.200".parse().unwrap(), &net));
        assert!(!in_subnet(&"198.51.100.200".parse().unwrap(), &net));
    }
}
