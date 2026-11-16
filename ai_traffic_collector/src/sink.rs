//! Delivery to ops-api: a bounded buffer posted in batches over plain HTTP to
//! the local Ops Center proxy. When the API is unreachable the buffer keeps
//! the newest events up to its limit and counts what it had to drop.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

pub struct Sink {
    pub base: String,
    pub token: String,
    pub node: String,
    pub buffer: VecDeque<Value>,
    pub limit: usize,
    pub dropped: u64,
    pub sent: u64,
    pub post_failures: u64,
    pub last_error: Option<String>,
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Sink {
    pub fn push(&mut self, event: Value) {
        if self.buffer.len() >= self.limit {
            self.buffer.pop_front();
            self.dropped += 1;
        }
        self.buffer.push_back(event);
    }

    /// Post up to `batch` events plus the source status. Returns true when delivered.
    pub fn flush(&mut self, batch: usize, source: Value) -> bool {
        let n = self.buffer.len().min(batch);
        let events: Vec<Value> = self.buffer.iter().take(n).cloned().collect();
        let body = json!({"node": self.node, "source": source, "events": events}).to_string();
        match self.request("POST", "/api/ai-traffic/ingest", "application/json", body.as_bytes(), &[]) {
            Ok(r) if r.status == 200 => {
                self.buffer.drain(..n);
                self.sent += n as u64;
                self.last_error = None;
                true
            }
            Ok(r) => {
                self.post_failures += 1;
                self.last_error = Some(format!("ingest HTTP {}", r.status));
                false
            }
            Err(e) => {
                self.post_failures += 1;
                self.last_error = Some(e);
                false
            }
        }
    }

    pub fn request(&self, method: &str, path: &str, ctype: &str, body: &[u8], headers: &[(&str, String)]) -> Result<Response, String> {
        let rest = self.base.strip_prefix("http://").ok_or("AI_TRAFFIC_API must be http://host:port")?;
        let (hostport, prefix) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, String::new()));
        let mut s = TcpStream::connect(hostport).map_err(|e| format!("connect {hostport}: {e}"))?;
        s.set_read_timeout(Some(Duration::from_secs(20))).ok();
        s.set_write_timeout(Some(Duration::from_secs(20))).ok();
        let mut head = format!(
            "{method} {}{path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nX-AI-Traffic-Token: {}\r\nX-AI-Traffic-Node: {}\r\n",
            prefix.trim_end_matches('/'), body.len(), self.token, self.node
        );
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
        s.write_all(body).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad HTTP response")?;
        let headtext = String::from_utf8_lossy(&buf[..split]).to_string();
        let status = headtext.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("bad status line")?;
        let mut body = buf[split + 4..].to_vec();
        if headtext.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            body = dechunk(&body);
        }
        Ok(Response { status, body })
    }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(eol) = b.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&b[..eol]).split(';').next().unwrap_or("0").trim(), 16).unwrap_or(0);
        if size == 0 || b.len() < eol + 2 + size {
            break;
        }
        out.extend_from_slice(&b[eol + 2..eol + 2 + size]);
        b = &b[(eol + 4 + size).min(b.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn dechunks() {
        assert_eq!(super::dechunk(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), b"abcde");
    }
}
