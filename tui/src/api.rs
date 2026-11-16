//! Ops-Center REST client. Uses the same endpoints, sessions and role checks as
//! the web GUI: the access token stays in memory, the refresh cookie lives in
//! the in-memory cookie jar, and every write is decided by the backend.

use crate::model::TokenResponse;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::RwLock;
use std::time::Duration;

/// Header the backend's CSRF guard expects on cookie-authenticated calls.
const CSRF: (&str, &str) = ("x-requested-with", "ops-center");

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// Session ended (expired, revoked, or never signed in).
    Unauthorized(String),
    /// Role too low, or a fresh password confirmation is needed (`reauth`).
    Forbidden {
        detail: String,
        reauth: bool,
    },
    Status(u16, String),
    Network(String),
    Decode(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized(d) => write!(f, "not signed in: {d}"),
            ApiError::Forbidden { detail, .. } => write!(f, "forbidden: {detail}"),
            ApiError::Status(c, d) => write!(f, "HTTP {c}: {d}"),
            ApiError::Network(d) => write!(f, "network: {d}"),
            ApiError::Decode(d) => write!(f, "unexpected response: {d}"),
        }
    }
}

impl ApiError {
    pub fn needs_reauth(&self) -> bool {
        matches!(self, ApiError::Forbidden { reauth: true, .. })
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;

pub struct Api {
    http: reqwest::Client,
    stream_http: reqwest::Client,
    base: String,
    token: RwLock<Option<String>>,
    refreshing: tokio::sync::Mutex<()>,
}

fn net(e: reqwest::Error) -> ApiError {
    // reqwest errors can include the URL; ours never carries a secret (the
    // stream token is redacted before display by the caller).
    ApiError::Network(crate::mask::mask(&e.without_url().to_string()))
}

impl Api {
    pub fn new(server: &str) -> Result<Self> {
        let ua = concat!("opstui/", env!("CARGO_PKG_VERSION"));
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .user_agent(ua)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(net)?;
        // The live stream has no total timeout; a silent connection is cut
        // after missing two 30 s keepalives.
        let stream_http = reqwest::Client::builder()
            .user_agent(ua)
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(75))
            .build()
            .map_err(net)?;
        Ok(Self {
            http,
            stream_http,
            base: format!("{}/api", server.trim_end_matches('/')),
            token: RwLock::new(None),
            refreshing: tokio::sync::Mutex::new(()),
        })
    }

    fn token(&self) -> Option<String> {
        self.token.read().ok().and_then(|t| t.clone())
    }

    fn set_token(&self, t: Option<String>) {
        if let Ok(mut g) = self.token.write() {
            *g = t;
        }
    }

    async fn error_of(resp: reqwest::Response) -> ApiError {
        let status = resp.status();
        let reauth = resp.headers().get("x-reauth-required").is_some();
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| match v.get("detail") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(other) => Some(other.to_string()),
                None => None,
            })
            .unwrap_or_else(|| body.chars().take(200).collect());
        let detail = crate::mask::mask(&detail);
        match status {
            StatusCode::UNAUTHORIZED => ApiError::Unauthorized(detail),
            StatusCode::FORBIDDEN => ApiError::Forbidden { detail, reauth },
            s => ApiError::Status(s.as_u16(), detail),
        }
    }

    async fn token_call(
        &self,
        path: &str,
        body: Option<Value>,
        bearer: bool,
    ) -> Result<TokenResponse> {
        let mut req = self
            .http
            .post(format!("{}{}", self.base, path))
            .header(CSRF.0, CSRF.1);
        if bearer {
            if let Some(t) = self.token() {
                req = req.bearer_auth(t);
            }
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(net)?;
        if !resp.status().is_success() {
            return Err(Self::error_of(resp).await);
        }
        let tok: TokenResponse = resp
            .json()
            .await
            .map_err(|e| ApiError::Decode(e.to_string()))?;
        self.set_token(Some(tok.access_token.clone()));
        Ok(tok)
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<TokenResponse> {
        self.token_call(
            "/auth/login",
            Some(json!({"username": username, "password": password})),
            false,
        )
        .await
    }

    /// New access token from the refresh cookie; concurrent callers share one refresh.
    pub async fn refresh(&self) -> Result<TokenResponse> {
        let _g = self.refreshing.lock().await;
        let r = self.token_call("/auth/refresh", None, false).await;
        if matches!(r, Err(ApiError::Unauthorized(_))) {
            self.set_token(None);
        }
        r
    }

    /// Confirms the password again; required before production approvals.
    pub async fn reauth(&self, password: &str) -> Result<TokenResponse> {
        self.token_call("/auth/reauth", Some(json!({"password": password})), true)
            .await
    }

    pub async fn logout(&self) {
        let _ = self
            .http
            .post(format!("{}/auth/logout", self.base))
            .header(CSRF.0, CSRF.1)
            .send()
            .await;
        self.set_token(None);
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::Response> {
        for attempt in 0..2 {
            let token = self
                .token()
                .ok_or_else(|| ApiError::Unauthorized("no session".into()))?;
            let mut req = self
                .http
                .request(method.clone(), format!("{}{}", self.base, path))
                .bearer_auth(token);
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await.map_err(net)?;
            if resp.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                // Access tokens live 15 minutes; renew once and retry.
                if self.refresh().await.is_ok() {
                    continue;
                }
            }
            if !resp.status().is_success() {
                return Err(Self::error_of(resp).await);
            }
            return Ok(resp);
        }
        Err(ApiError::Unauthorized("session expired".into()))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self.send(Method::GET, path, None).await?;
        resp.json()
            .await
            .map_err(|e| ApiError::Decode(format!("{path}: {e}")))
    }

    pub async fn get_text(&self, path: &str) -> Result<String> {
        let resp = self.send(Method::GET, path, None).await?;
        resp.text().await.map_err(net)
    }

    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        let resp = self.send(Method::POST, path, Some(body)).await?;
        let text = resp.text().await.map_err(net)?;
        serde_json::from_str(if text.is_empty() { "null" } else { &text })
            .map_err(|e| ApiError::Decode(format!("{path}: {e}")))
    }

    /// Opens the Ops Floor event stream. The backend takes the token as a
    /// query parameter (EventSource cannot send headers).
    pub async fn open_stream(&self) -> Result<reqwest::Response> {
        let token = self
            .token()
            .ok_or_else(|| ApiError::Unauthorized("no session".into()))?;
        let resp = self
            .stream_http
            .get(format!("{}/ai/agents/stream", self.base))
            .query(&[("token", token)])
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(net)?;
        if !resp.status().is_success() {
            return Err(Self::error_of(resp).await);
        }
        Ok(resp)
    }
}

/// Percent-encode a query value (RFC 3986 unreserved characters kept).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::enc;

    #[test]
    fn encodes_query_values() {
        assert_eq!(enc("web:dev:a b/ø"), "web%3Adev%3Aa%20b%2F%C3%B8");
    }
}
