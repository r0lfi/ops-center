//! Parsing of captured packet headers: TCP flags, DNS messages, TLS
//! ClientHello (SNI/ALPN) and ICMP destination-unreachable. Payload beyond a
//! DNS message or a ClientHello is never looked at, and nothing is decrypted.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq)]
pub enum Pkt {
    Tcp { src: IpAddr, dst: IpAddr, sport: u16, dport: u16, flags: u8 },
    Dns { src: IpAddr, dst: IpAddr, sport: u16, dport: u16, msg: Dns },
    Tls { src: IpAddr, dst: IpAddr, sport: u16, dport: u16, sni: Option<String>, alpn: Vec<String>, version: u16 },
    /// An ICMP error about a packet we sent: `from` generated it, `inner` is our original packet.
    Unreachable { from: IpAddr, icmp_type: u8, code: u8, inner_src: IpAddr, inner_dst: IpAddr, proto: u8, sport: u16, dport: u16 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Dns {
    pub id: u16,
    pub response: bool,
    pub rcode: u8,
    pub qname: String,
    pub qtype: u16,
    pub answers: Vec<IpAddr>,
}

pub const TCP_SYN: u8 = 0x02;
pub const TCP_RST: u8 = 0x04;
pub const TCP_ACK: u8 = 0x10;

/// Parse one Ethernet frame (or a Linux cooked capture when `cooked`).
pub fn parse_frame(data: &[u8], cooked: bool) -> Option<Pkt> {
    let (mut ethertype, mut off) = if cooked {
        if data.len() < 16 { return None; }
        (u16::from_be_bytes([data[14], data[15]]), 16)
    } else {
        if data.len() < 14 { return None; }
        (u16::from_be_bytes([data[12], data[13]]), 14)
    };
    while ethertype == 0x8100 || ethertype == 0x88a8 {
        if data.len() < off + 4 { return None; }
        ethertype = u16::from_be_bytes([data[off + 2], data[off + 3]]);
        off += 4;
    }
    match ethertype {
        0x0800 => parse_ipv4(&data[off..]),
        0x86dd => parse_ipv6(&data[off..]),
        _ => None,
    }
}

fn parse_ipv4(b: &[u8]) -> Option<Pkt> {
    if b.len() < 20 || b[0] >> 4 != 4 { return None; }
    let ihl = ((b[0] & 0x0f) as usize) * 4;
    if ihl < 20 || b.len() < ihl { return None; }
    let frag = u16::from_be_bytes([b[6], b[7]]) & 0x1fff;
    if frag != 0 { return None; }
    let total = (u16::from_be_bytes([b[2], b[3]]) as usize).clamp(ihl, b.len());
    let src = IpAddr::V4(Ipv4Addr::new(b[12], b[13], b[14], b[15]));
    let dst = IpAddr::V4(Ipv4Addr::new(b[16], b[17], b[18], b[19]));
    transport(b[9], src, dst, &b[ihl..total])
}

fn parse_ipv6(b: &[u8]) -> Option<Pkt> {
    if b.len() < 40 || b[0] >> 4 != 6 { return None; }
    let src = IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&b[8..24]).ok()?));
    let dst = IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&b[24..40]).ok()?));
    // Extension headers are not followed; such packets are simply skipped.
    transport(b[6], src, dst, &b[40..])
}

fn transport(proto: u8, src: IpAddr, dst: IpAddr, b: &[u8]) -> Option<Pkt> {
    match proto {
        6 => {
            if b.len() < 20 { return None; }
            let sport = u16::from_be_bytes([b[0], b[1]]);
            let dport = u16::from_be_bytes([b[2], b[3]]);
            let doff = ((b[12] >> 4) as usize) * 4;
            let flags = b[13];
            let payload = if doff >= 20 && b.len() > doff { &b[doff..] } else { &[][..] };
            if payload.len() > 5 && payload[0] == 0x16 && payload[1] == 0x03 {
                if let Some((sni, alpn, version)) = client_hello(payload) {
                    return Some(Pkt::Tls { src, dst, sport, dport, sni, alpn, version });
                }
            }
            Some(Pkt::Tcp { src, dst, sport, dport, flags })
        }
        17 => {
            if b.len() < 8 { return None; }
            let sport = u16::from_be_bytes([b[0], b[1]]);
            let dport = u16::from_be_bytes([b[2], b[3]]);
            if sport == 53 || dport == 53 {
                let msg = dns(&b[8..])?;
                return Some(Pkt::Dns { src, dst, sport, dport, msg });
            }
            None
        }
        1 | 58 => {
            if b.len() < 8 { return None; }
            let (t, code) = (b[0], b[1]);
            let unreachable = (proto == 1 && t == 3) || (proto == 58 && t == 1);
            if !unreachable { return None; }
            let inner = &b[8..];
            let (inner_src, inner_dst, iproto, rest) = if proto == 1 {
                if inner.len() < 20 { return None; }
                let ihl = ((inner[0] & 0x0f) as usize) * 4;
                if inner.len() < ihl + 4 { return None; }
                (IpAddr::V4(Ipv4Addr::new(inner[12], inner[13], inner[14], inner[15])),
                 IpAddr::V4(Ipv4Addr::new(inner[16], inner[17], inner[18], inner[19])), inner[9], &inner[ihl..])
            } else {
                if inner.len() < 44 { return None; }
                (IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&inner[8..24]).ok()?)),
                 IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&inner[24..40]).ok()?)), inner[6], &inner[40..])
            };
            let sport = u16::from_be_bytes([rest[0], rest[1]]);
            let dport = u16::from_be_bytes([rest[2], rest[3]]);
            Some(Pkt::Unreachable { from: src, icmp_type: t, code, inner_src, inner_dst, proto: iproto, sport, dport })
        }
        _ => None,
    }
}

fn name_at(msg: &[u8], mut pos: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut end = None;
    for _ in 0..64 {
        let len = *msg.get(pos)? as usize;
        if len == 0 {
            end.get_or_insert(pos + 1);
            break;
        }
        if len & 0xc0 == 0xc0 {
            let ptr = ((len & 0x3f) << 8) | *msg.get(pos + 1)? as usize;
            end.get_or_insert(pos + 2);
            if ptr >= pos { return None; }
            pos = ptr;
            continue;
        }
        let label = msg.get(pos + 1..pos + 1 + len)?;
        labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
        pos += 1 + len;
    }
    Some((labels.join("."), end?))
}

pub fn dns(msg: &[u8]) -> Option<Dns> {
    if msg.len() < 12 { return None; }
    let id = u16::from_be_bytes([msg[0], msg[1]]);
    let response = msg[2] & 0x80 != 0;
    let rcode = msg[3] & 0x0f;
    let qd = u16::from_be_bytes([msg[4], msg[5]]);
    let an = u16::from_be_bytes([msg[6], msg[7]]) as usize;
    if qd == 0 { return None; }
    let (qname, mut pos) = name_at(msg, 12)?;
    let qtype = u16::from_be_bytes([*msg.get(pos)?, *msg.get(pos + 1)?]);
    pos += 4;
    let mut answers = Vec::new();
    for _ in 0..an.min(32) {
        let Some((_, p)) = name_at(msg, pos) else { break };
        let Some(hdr) = msg.get(p..p + 10) else { break };
        let rtype = u16::from_be_bytes([hdr[0], hdr[1]]);
        let rdlen = u16::from_be_bytes([hdr[8], hdr[9]]) as usize;
        let Some(rdata) = msg.get(p + 10..p + 10 + rdlen) else { break };
        match (rtype, rdlen) {
            (1, 4) => answers.push(IpAddr::V4(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]))),
            (28, 16) => answers.push(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(rdata).ok()?))),
            _ => {}
        }
        pos = p + 10 + rdlen;
    }
    Some(Dns { id, response, rcode, qname, qtype, answers })
}

/// SNI, ALPN and offered version from a TLS ClientHello in one segment.
pub fn client_hello(b: &[u8]) -> Option<(Option<String>, Vec<String>, u16)> {
    let rec_version = u16::from_be_bytes([b[1], b[2]]);
    let hs = b.get(5..)?;
    if *hs.first()? != 1 { return None; }
    let mut p = 4 + 2 + 32; // handshake header, client_version, random
    let version = u16::from_be_bytes([*hs.get(4)?, *hs.get(5)?]).max(rec_version);
    let sid = *hs.get(p)? as usize;
    p += 1 + sid;
    let cs = u16::from_be_bytes([*hs.get(p)?, *hs.get(p + 1)?]) as usize;
    p += 2 + cs;
    let comp = *hs.get(p)? as usize;
    p += 1 + comp;
    let ext_len = u16::from_be_bytes([*hs.get(p)?, *hs.get(p + 1)?]) as usize;
    p += 2;
    let end = (p + ext_len).min(hs.len());
    let (mut sni, mut alpn, mut tls13) = (None, Vec::new(), false);
    while p + 4 <= end {
        let t = u16::from_be_bytes([hs[p], hs[p + 1]]);
        let l = u16::from_be_bytes([hs[p + 2], hs[p + 3]]) as usize;
        let Some(v) = hs.get(p + 4..p + 4 + l) else { break };
        match t {
            0 if v.len() > 5 && v[2] == 0 => {
                let n = u16::from_be_bytes([v[3], v[4]]) as usize;
                if let Some(name) = v.get(5..5 + n) {
                    sni = Some(String::from_utf8_lossy(name).to_ascii_lowercase());
                }
            }
            16 if v.len() > 2 => {
                let mut q = 2;
                while q < v.len() {
                    let n = v[q] as usize;
                    if let Some(proto) = v.get(q + 1..q + 1 + n) {
                        alpn.push(String::from_utf8_lossy(proto).into_owned());
                    }
                    q += 1 + n;
                }
            }
            43 => tls13 = v.chunks(2).skip(1).any(|c| c == [3, 4]) || v.windows(2).any(|w| w == [3, 4]),
            _ => {}
        }
        p += 4 + l;
    }
    Some((sni, alpn, if tls13 { 0x0304 } else { version }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dns_response_with_compression() {
        let mut m = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
        m.extend_from_slice(&[3, b'a', b'p', b'i', 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm', 0, 0, 1, 0, 1]);
        m.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
        let d = dns(&m).unwrap();
        assert!(d.response);
        assert_eq!(d.qname, "api.example.com");
        assert_eq!(d.answers, vec!["93.184.216.34".parse::<IpAddr>().unwrap()]);
        assert_eq!(d.rcode, 0);
    }

    #[test]
    fn parses_client_hello_sni_and_alpn() {
        let name = b"api.mistral.ai";
        let mut sni = vec![0, (name.len() + 3) as u8, 0, 0, name.len() as u8];
        sni.extend_from_slice(name);
        let alpn = [0u8, 3, 2, b'h', b'2'];
        let mut ext = vec![0, 0, 0, sni.len() as u8];
        ext.extend_from_slice(&sni);
        ext.extend_from_slice(&[0, 16, 0, alpn.len() as u8]);
        ext.extend_from_slice(&alpn);
        let mut body = vec![3, 3];
        body.extend_from_slice(&[0; 32]);
        body.extend_from_slice(&[0, 0, 2, 0x13, 0x01, 1, 0]);
        body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        body.extend_from_slice(&ext);
        let mut hs = vec![1, 0, (body.len() >> 8) as u8, body.len() as u8];
        hs.extend_from_slice(&body);
        let mut rec = vec![0x16, 3, 1, (hs.len() >> 8) as u8, hs.len() as u8];
        rec.extend_from_slice(&hs);
        let (s, a, _) = client_hello(&rec).unwrap();
        assert_eq!(s.as_deref(), Some("api.mistral.ai"));
        assert_eq!(a, vec!["h2".to_string()]);
    }

    #[test]
    fn parses_icmp_admin_prohibited() {
        let mut ip = vec![0x45, 0, 0, 56, 0, 0, 0, 0, 64, 1, 0, 0, 198, 51, 100, 1, 203, 0, 113, 5];
        let inner = [0x45, 0, 0, 60, 0, 0, 0x40, 0, 63, 6, 0, 0, 203, 0, 113, 5, 1, 2, 3, 4, 0x9c, 0x40, 1, 187];
        ip.extend_from_slice(&[3, 13, 0, 0, 0, 0, 0, 0]);
        ip.extend_from_slice(&inner);
        let mut frame = vec![0u8; 12];
        frame.extend_from_slice(&[0x08, 0x00]);
        frame.extend_from_slice(&ip);
        match parse_frame(&frame, false).unwrap() {
            Pkt::Unreachable { code, dport, inner_src, .. } => {
                assert_eq!(code, 13);
                assert_eq!(dport, 443);
                assert_eq!(inner_src, "203.0.113.5".parse::<IpAddr>().unwrap());
            }
            other => panic!("{other:?}"),
        }
    }
}
