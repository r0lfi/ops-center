//! API client and live stream against a small in-process mock of the
//! Ops-Center endpoints opstui uses (same status codes, headers and cookie
//! rules as backend/app/api/routes/auth.py and api/deps.py).

use opstui::api::{Api, ApiError};
use opstui::sync::{self, Conn, Msg};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct State {
    valid: String,
    expire_next: bool,
    refreshes: u32,
    streams: u32,
}

struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
    }
    fn bearer(&self) -> Option<&str> {
        self.header("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
    }
}

async fn read_req(sock: &mut TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| {
            l.split_once(": ")
                .map(|(a, b)| (a.to_string(), b.to_string()))
        })
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(Req {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn resp(code: u16, extra: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}",
        body.len()
    )
}

fn token(t: &str) -> String {
    format!(
        r#"{{"access_token":"{t}","token_type":"bearer","role":"admin","username":"alice","remember":false}}"#
    )
}

async fn handle(mut sock: TcpStream, st: Arc<Mutex<State>>) {
    let Some(r) = read_req(&mut sock).await else {
        return;
    };
    let path = r.path.split('?').next().unwrap_or("").to_string();
    let out = match (r.method.as_str(), path.as_str()) {
        ("POST", "/api/auth/login") => {
            if r.body.contains(r#""password":"pw""#) {
                st.lock().unwrap().valid = "t1".into();
                resp(
                    200,
                    "set-cookie: ops_refresh=r1; Path=/api/auth; HttpOnly; SameSite=strict\r\n",
                    &token("t1"),
                )
            } else {
                resp(401, "", r#"{"detail":"invalid username or password"}"#)
            }
        }
        ("POST", "/api/auth/refresh") => {
            let csrf = r.header("x-requested-with") == Some("ops-center");
            let cookie = r
                .header("cookie")
                .is_some_and(|c| c.contains("ops_refresh=r1"));
            if csrf && cookie {
                let mut s = st.lock().unwrap();
                s.refreshes += 1;
                s.valid = "t2".into();
                resp(200, "", &token("t2"))
            } else {
                resp(401, "", r#"{"detail":"not signed in"}"#)
            }
        }
        ("POST", "/api/auth/reauth") => {
            if r.body.contains(r#""password":"pw""#) {
                st.lock().unwrap().valid = "t3".into();
                resp(200, "", &token("t3"))
            } else {
                resp(403, "", r#"{"detail":"password incorrect"}"#)
            }
        }
        ("GET", "/api/ai/agents/stream") => {
            let n = {
                let mut s = st.lock().unwrap();
                s.streams += 1;
                s.streams
            };
            if !r
                .path
                .contains(&format!("token={}", st.lock().unwrap().valid))
            {
                resp(401, "", r#"{"detail":"invalid or expired token"}"#)
            } else {
                // Two events, then the connection drops (as on a network cut).
                let ev = |i: u32| {
                    format!("data: {{\"agent\":\"dev\",\"status\":\"working\",\"event\":\"tool_started\",\"tool\":\"t{i}\"}}\n\n")
                };
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n: keepalive\n\n{}{}",
                    ev(n * 10),
                    ev(n * 10 + 1)
                )
            }
        }
        _ => {
            let valid = {
                let mut s = st.lock().unwrap();
                if s.expire_next {
                    s.expire_next = false;
                    s.valid = "expired".into();
                }
                r.bearer() == Some(s.valid.as_str())
            };
            if !valid {
                resp(401, "", r#"{"detail":"invalid or expired token"}"#)
            } else {
                match path.as_str() {
                    "/api/ai/agents" => resp(
                        200,
                        "",
                        r#"[{"id":"a1","slug":"dev","name":"Developer","status":"working","enabled":true,"running_tasks":12}]"#,
                    ),
                    "/api/ai/tasks" => resp(500, "", r#"{"detail":"boom"}"#),
                    "/api/ai/actions" => {
                        resp(403, "", r#"{"detail":"requires operator role or higher"}"#)
                    }
                    "/api/ai/proposals/p1/review" => {
                        if st.lock().unwrap().valid == "t3" {
                            resp(
                                200,
                                "",
                                r#"{"id":"p1","status":"approved","stage":"approved"}"#,
                            )
                        } else {
                            resp(
                                403,
                                "x-reauth-required: 1\r\n",
                                r#"{"detail":"reauthentication required"}"#,
                            )
                        }
                    }
                    _ => resp(404, "", r#"{"detail":"Not Found"}"#),
                }
            }
        }
    };
    let _ = sock.write_all(out.as_bytes()).await;
    let _ = sock.shutdown().await;
}

async fn mock() -> (String, Arc<Mutex<State>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = format!("http://{}", l.local_addr().unwrap());
    let st = Arc::new(Mutex::new(State::default()));
    let s2 = st.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = l.accept().await {
            tokio::spawn(handle(sock, s2.clone()));
        }
    });
    (addr, st)
}

#[tokio::test]
async fn login_failure_is_reported_without_a_session() {
    let (url, _) = mock().await;
    let api = Api::new(&url).unwrap();
    let e = api.login("alice", "wrong").await.unwrap_err();
    assert_eq!(
        e,
        ApiError::Unauthorized("invalid username or password".into())
    );
    // No token: reads are refused locally rather than sent anonymously.
    assert!(matches!(
        api.get::<serde_json::Value>("/ai/agents").await,
        Err(ApiError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn expired_token_is_refreshed_with_cookie_and_csrf_header() {
    let (url, st) = mock().await;
    let api = Api::new(&url).unwrap();
    api.login("alice", "pw").await.unwrap();
    st.lock().unwrap().expire_next = true;
    let agents: Vec<opstui::model::Agent> = api.get("/ai/agents").await.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(st.lock().unwrap().refreshes, 1);
}

#[tokio::test]
async fn production_approval_needs_reauth_and_backend_errors_surface() {
    let (url, _) = mock().await;
    let api = Api::new(&url).unwrap();
    api.login("alice", "pw").await.unwrap();
    let body = serde_json::json!({"decision":"approve","patch_sha256":"ab"});
    let e = api
        .post::<serde_json::Value>("/ai/proposals/p1/review", &body)
        .await
        .unwrap_err();
    assert!(e.needs_reauth(), "{e:?}");
    assert!(api.reauth("nope").await.is_err());
    api.reauth("pw").await.unwrap();
    let r: serde_json::Value = api.post("/ai/proposals/p1/review", &body).await.unwrap();
    assert_eq!(r["stage"], "approved");

    let e = api.get::<serde_json::Value>("/ai/tasks").await.unwrap_err();
    assert_eq!(e, ApiError::Status(500, "boom".into()));
    let e = api
        .get::<serde_json::Value>("/ai/actions")
        .await
        .unwrap_err();
    assert!(matches!(e, ApiError::Forbidden { reauth: false, .. }));
}

#[tokio::test]
async fn snapshot_keeps_going_when_a_list_is_forbidden() {
    let (url, _) = mock().await;
    let api = Api::new(&url).unwrap();
    api.login("alice", "pw").await.unwrap();
    let s = sync::snapshot(&api).await.unwrap();
    assert_eq!(s.agents.unwrap()[0].running_tasks, 12);
    assert!(s.actions.is_none());
    assert!(s
        .errors
        .iter()
        .any(|e| e.starts_with("approvals: forbidden")));
    assert!(s.errors.iter().any(|e| e.starts_with("tasks: HTTP 500")));
}

#[tokio::test]
async fn stream_reconnects_after_disconnect_and_expired_token() {
    let (url, st) = mock().await;
    let api = Arc::new(Api::new(&url).unwrap());
    api.login("alice", "pw").await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let poke = Arc::new(tokio::sync::Notify::new());
    let h = tokio::spawn(sync::stream(api.clone(), tx, poke));
    let (mut live, mut retry, mut tools, mut expired) = (0, 0, Vec::new(), false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while live < 3 {
        if live == 1 && retry == 1 && !expired {
            expired = true;
            // Token expires during the outage: the next connect must refresh.
            st.lock().unwrap().valid = "old".into();
        }
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Msg::Conn(Conn::Live))) => live += 1,
            Ok(Some(Msg::Conn(Conn::Retrying(..)))) => retry += 1,
            Ok(Some(Msg::Event(e))) => tools.push(e.tool.unwrap_or_default()),
            Ok(Some(_)) => {}
            _ => panic!("stream did not reconnect: live={live} retry={retry} tools={tools:?}"),
        }
    }
    h.abort();
    assert!(retry >= 2);
    assert!(st.lock().unwrap().refreshes >= 1);
    // Each connection's events arrive once, in order (connection 2 was refused).
    assert_eq!(tools[..4], ["t10", "t11", "t30", "t31"]);
}
