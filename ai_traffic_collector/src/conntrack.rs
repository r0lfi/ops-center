//! Conntrack event listener over netlink (NETLINK_NETFILTER, groups NEW and
//! DESTROY). Subscribing only reads the kernel's connection table events; it
//! adds no rule, no expectation and no helper, and never writes to the table.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

const NETLINK_NETFILTER: libc::c_int = 12;
const NFNLGRP_CONNTRACK_NEW: u32 = 1;
const NFNLGRP_CONNTRACK_DESTROY: u32 = 3;
const NFNL_SUBSYS_CTNETLINK: u16 = 1;
const IPCTNL_MSG_CT_NEW: u16 = 0;
const IPCTNL_MSG_CT_DELETE: u16 = 2;
const NLMSG_HDRLEN: usize = 16;
const NFGENMSG_LEN: usize = 4;

const CTA_TUPLE_ORIG: u16 = 1;
const CTA_TUPLE_REPLY: u16 = 2;
const CTA_STATUS: u16 = 3;
const CTA_COUNTERS_ORIG: u16 = 9;
const CTA_COUNTERS_REPLY: u16 = 10;
const CTA_ID: u16 = 12;
const CTA_TUPLE_IP: u16 = 1;
const CTA_TUPLE_PROTO: u16 = 2;
const CTA_IP_V4_SRC: u16 = 1;
const CTA_IP_V4_DST: u16 = 2;
const CTA_IP_V6_SRC: u16 = 3;
const CTA_IP_V6_DST: u16 = 4;
const CTA_PROTO_NUM: u16 = 1;
const CTA_PROTO_SRC_PORT: u16 = 2;
const CTA_PROTO_DST_PORT: u16 = 3;
const CTA_COUNTERS_PACKETS: u16 = 1;
const CTA_COUNTERS_BYTES: u16 = 2;
const NLA_TYPE_MASK: u16 = 0x3fff;

pub const IPS_SEEN_REPLY: u32 = 1 << 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Tuple {
    pub src: IpAddr,
    pub dst: IpAddr,
    pub proto: u8,
    pub sport: u16,
    pub dport: u16,
}

#[derive(Debug, Clone)]
pub struct CtEvent {
    pub destroy: bool,
    pub id: u32,
    pub orig: Tuple,
    /// The reply direction after NAT: its source is the real remote, its destination our host.
    pub reply: Option<Tuple>,
    pub status: u32,
    pub orig_bytes: Option<u64>,
    pub reply_bytes: Option<u64>,
    pub orig_packets: Option<u64>,
    pub reply_packets: Option<u64>,
}

#[derive(Default)]
pub struct CtStats {
    pub events: AtomicU64,
    /// ENOBUFS: the kernel dropped events because we read too slowly.
    pub overruns: AtomicU64,
    pub errors: AtomicU64,
}

pub fn listen(tx: Sender<CtEvent>, stats: Arc<CtStats>) -> io::Result<()> {
    let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, NETLINK_NETFILTER) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let size: libc::c_int = 8 * 1024 * 1024;
    unsafe {
        // SO_RCVBUFFORCE needs CAP_NET_ADMIN; fall back to the normal limit.
        if libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_RCVBUFFORCE, &size as *const _ as *const libc::c_void, 4) != 0 {
            libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_RCVBUF, &size as *const _ as *const libc::c_void, 4);
        }
    }
    let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    addr.nl_family = libc::AF_NETLINK as u16;
    addr.nl_groups = (1 << (NFNLGRP_CONNTRACK_NEW - 1)) | (1 << (NFNLGRP_CONNTRACK_DESTROY - 1));
    let rc = unsafe {
        libc::bind(fd, &addr as *const _ as *const libc::sockaddr, std::mem::size_of::<libc::sockaddr_nl>() as u32)
    };
    if rc != 0 {
        let err = io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(err);
    }
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if n < 0 {
            let err = io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::ENOBUFS) => {
                    stats.overruns.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                Some(libc::EINTR) => continue,
                _ => {
                    stats.errors.fetch_add(1, Ordering::Relaxed);
                    unsafe { libc::close(fd) };
                    return Err(err);
                }
            }
        }
        for event in parse_messages(&buf[..n as usize]) {
            stats.events.fetch_add(1, Ordering::Relaxed);
            if tx.send(event).is_err() {
                unsafe { libc::close(fd) };
                return Ok(());
            }
        }
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_ne_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_ne_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

pub fn parse_messages(mut b: &[u8]) -> Vec<CtEvent> {
    let mut out = Vec::new();
    while b.len() >= NLMSG_HDRLEN {
        let len = u32_at(b, 0) as usize;
        if len < NLMSG_HDRLEN || len > b.len() {
            break;
        }
        let kind = u16_at(b, 4);
        let subsys = kind >> 8;
        let msg = kind & 0xff;
        if subsys == NFNL_SUBSYS_CTNETLINK && (msg == IPCTNL_MSG_CT_NEW || msg == IPCTNL_MSG_CT_DELETE) && len > NLMSG_HDRLEN + NFGENMSG_LEN {
            if let Some(ev) = parse_ct(&b[NLMSG_HDRLEN + NFGENMSG_LEN..len], msg == IPCTNL_MSG_CT_DELETE) {
                out.push(ev);
            }
        }
        let aligned = (len + 3) & !3;
        if aligned >= b.len() {
            break;
        }
        b = &b[aligned..];
    }
    out
}

/// Iterate netlink attributes: (type, payload).
fn attrs(mut b: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    while b.len() >= 4 {
        let len = u16_at(b, 0) as usize;
        if len < 4 || len > b.len() {
            break;
        }
        out.push((u16_at(b, 2) & NLA_TYPE_MASK, &b[4..len]));
        let aligned = (len + 3) & !3;
        if aligned >= b.len() {
            break;
        }
        b = &b[aligned..];
    }
    out
}

fn be_u64(b: &[u8]) -> Option<u64> {
    (b.len() >= 8).then(|| u64::from_be_bytes(b[..8].try_into().unwrap()))
}

fn be_u32(b: &[u8]) -> Option<u32> {
    (b.len() >= 4).then(|| u32::from_be_bytes(b[..4].try_into().unwrap()))
}

fn be_u16(b: &[u8]) -> Option<u16> {
    (b.len() >= 2).then(|| u16::from_be_bytes([b[0], b[1]]))
}

fn parse_tuple(b: &[u8]) -> Option<Tuple> {
    let (mut src, mut dst, mut proto, mut sport, mut dport) = (None, None, 0u8, 0u16, 0u16);
    for (t, v) in attrs(b) {
        match t {
            CTA_TUPLE_IP => {
                for (it, iv) in attrs(v) {
                    match it {
                        CTA_IP_V4_SRC if iv.len() >= 4 => src = Some(IpAddr::V4(Ipv4Addr::new(iv[0], iv[1], iv[2], iv[3]))),
                        CTA_IP_V4_DST if iv.len() >= 4 => dst = Some(IpAddr::V4(Ipv4Addr::new(iv[0], iv[1], iv[2], iv[3]))),
                        CTA_IP_V6_SRC if iv.len() >= 16 => src = Some(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&iv[..16]).unwrap()))),
                        CTA_IP_V6_DST if iv.len() >= 16 => dst = Some(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&iv[..16]).unwrap()))),
                        _ => {}
                    }
                }
            }
            CTA_TUPLE_PROTO => {
                for (pt, pv) in attrs(v) {
                    match pt {
                        CTA_PROTO_NUM if !pv.is_empty() => proto = pv[0],
                        CTA_PROTO_SRC_PORT => sport = be_u16(pv).unwrap_or(0),
                        CTA_PROTO_DST_PORT => dport = be_u16(pv).unwrap_or(0),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Some(Tuple { src: src?, dst: dst?, proto, sport, dport })
}

fn parse_counters(b: &[u8]) -> (Option<u64>, Option<u64>) {
    let (mut packets, mut bytes) = (None, None);
    for (t, v) in attrs(b) {
        match t {
            CTA_COUNTERS_PACKETS => packets = be_u64(v),
            CTA_COUNTERS_BYTES => bytes = be_u64(v),
            _ => {}
        }
    }
    (packets, bytes)
}

fn parse_ct(b: &[u8], destroy: bool) -> Option<CtEvent> {
    let mut orig = None;
    let mut reply = None;
    let mut ev = CtEvent {
        destroy,
        id: 0,
        orig: Tuple { src: IpAddr::V4(Ipv4Addr::UNSPECIFIED), dst: IpAddr::V4(Ipv4Addr::UNSPECIFIED), proto: 0, sport: 0, dport: 0 },
        reply: None,
        status: 0,
        orig_bytes: None,
        reply_bytes: None,
        orig_packets: None,
        reply_packets: None,
    };
    for (t, v) in attrs(b) {
        match t {
            CTA_TUPLE_ORIG => orig = parse_tuple(v),
            CTA_TUPLE_REPLY => reply = parse_tuple(v),
            CTA_STATUS => ev.status = be_u32(v).unwrap_or(0),
            CTA_ID => ev.id = be_u32(v).unwrap_or(0),
            CTA_COUNTERS_ORIG => (ev.orig_packets, ev.orig_bytes) = parse_counters(v),
            CTA_COUNTERS_REPLY => (ev.reply_packets, ev.reply_bytes) = parse_counters(v),
            _ => {}
        }
    }
    ev.orig = orig?;
    ev.reply = reply;
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nla(t: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((payload.len() + 4) as u16).to_ne_bytes());
        v.extend_from_slice(&t.to_ne_bytes());
        v.extend_from_slice(payload);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    }

    fn tuple(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16) -> Vec<u8> {
        let ip = [nla(CTA_IP_V4_SRC, &src), nla(CTA_IP_V4_DST, &dst)].concat();
        let proto = [nla(CTA_PROTO_NUM, &[6]), nla(CTA_PROTO_SRC_PORT, &sport.to_be_bytes()), nla(CTA_PROTO_DST_PORT, &dport.to_be_bytes())].concat();
        [nla(CTA_TUPLE_IP | 0x8000, &ip), nla(CTA_TUPLE_PROTO | 0x8000, &proto)].concat()
    }

    #[test]
    fn parses_destroy_event_with_counters() {
        let counters = [nla(CTA_COUNTERS_PACKETS, &7u64.to_be_bytes()), nla(CTA_COUNTERS_BYTES, &1234u64.to_be_bytes())].concat();
        let body = [
            nla(CTA_TUPLE_ORIG | 0x8000, &tuple([203, 0, 113, 5], [1, 2, 3, 4], 40000, 443)),
            nla(CTA_TUPLE_REPLY | 0x8000, &tuple([1, 2, 3, 4], [198, 51, 100, 45], 443, 40000)),
            nla(CTA_STATUS, &(IPS_SEEN_REPLY | 4).to_be_bytes()),
            nla(CTA_COUNTERS_ORIG | 0x8000, &counters),
            nla(CTA_ID, &99u32.to_be_bytes()),
        ]
        .concat();
        let mut msg = Vec::new();
        let len = (NLMSG_HDRLEN + NFGENMSG_LEN + body.len()) as u32;
        msg.extend_from_slice(&len.to_ne_bytes());
        msg.extend_from_slice(&((NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_DELETE).to_ne_bytes());
        msg.extend_from_slice(&0u16.to_ne_bytes());
        msg.extend_from_slice(&[0; 8]);
        msg.extend_from_slice(&[2, 0, 0, 0]);
        msg.extend_from_slice(&body);
        let events = parse_messages(&msg);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert!(ev.destroy);
        assert_eq!(ev.id, 99);
        assert_eq!(ev.orig.dport, 443);
        assert_eq!(ev.orig.src, "203.0.113.5".parse::<IpAddr>().unwrap());
        assert_eq!(ev.orig_bytes, Some(1234));
        assert_eq!(ev.orig_packets, Some(7));
        assert_eq!(ev.reply.unwrap().dst, "198.51.100.45".parse::<IpAddr>().unwrap());
        assert!(ev.status & IPS_SEEN_REPLY != 0);
    }
}
