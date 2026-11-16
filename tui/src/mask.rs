//! Masks credentials before text reaches the screen or the log file.
//! Conservative: a false positive hides a harmless string, never the reverse.

const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "bearer",
    "cookie",
    "private_key",
    "access_key",
    "client_secret",
];
const SECRET_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "pk_",
    "rk_",
    "ghp_",
    "gho_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "glpat-",
    "AKIA",
    "eyJ",
];

fn looks_secret(word: &str) -> bool {
    let w = word.trim_matches(|c: char| "\"',;()[]{}<>".contains(c));
    if SECRET_PREFIXES
        .iter()
        .any(|p| w.starts_with(p) && w.len() >= p.len() + 8)
    {
        return true;
    }
    // Long opaque strings (keys, hashes used as tokens); paths and URLs excluded.
    w.len() >= 32
        && !w.contains('/')
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "+=_-.".contains(c))
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
        && !w.chars().all(|c| c.is_ascii_hexdigit()) // SHA-256 patch hashes stay visible
}

/// Mask `key=value`, `key: value`, `Bearer xyz` and opaque tokens.
pub fn mask(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut hide_next = false;
    for (i, piece) in text.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if piece.is_empty() {
            continue;
        }
        let lower = piece.to_ascii_lowercase();
        if hide_next && lower != "bearer" && lower != "basic" {
            out.push_str("****");
            hide_next = false;
            continue;
        }
        hide_next = false;
        if let Some(pos) = piece.find(['=', ':']) {
            let key = lower[..pos]
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
            if SECRET_KEYS.iter().any(|k| key.ends_with(k)) {
                out.push_str(&piece[..=pos]);
                if pos + 1 < piece.len() {
                    out.push_str("****");
                } else {
                    hide_next = true;
                }
                continue;
            }
        }
        if lower == "bearer" || lower == "basic" {
            out.push_str(piece);
            hide_next = true;
            continue;
        }
        if looks_secret(piece) {
            out.push_str("****");
        } else {
            out.push_str(piece);
        }
    }
    out
}

/// Mask a multi-line text line by line (diffs, responses, notes).
pub fn mask_lines(text: &str) -> Vec<String> {
    text.lines().map(mask).collect()
}

/// Mask every string inside a JSON value (keys named like secrets entirely).
pub fn mask_json(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => Value::String(mask(s)),
        Value::Array(a) => Value::Array(a.iter().map(mask_json).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    let lk = k.to_ascii_lowercase();
                    if SECRET_KEYS.iter().any(|s| lk.contains(s)) && !v.is_null() {
                        (k.clone(), Value::String("****".into()))
                    } else {
                        (k.clone(), mask_json(v))
                    }
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credentials() {
        assert_eq!(mask("password=hunter2 ok"), "password=**** ok");
        assert_eq!(mask("api_key: abc"), "api_key: ****");
        assert_eq!(
            mask("Authorization: Bearer abc.def"),
            "Authorization: Bearer ****"
        );
        assert_eq!(mask("use sk-ant-0123456789abcdef now"), "use **** now");
        assert_eq!(
            mask("x Q2hhbmdlTWUxMjM0NTY3ODkwYWJjZGVmZ2hpams9 y"),
            "x **** y"
        );
    }

    #[test]
    fn keeps_ordinary_text() {
        let t = "Read file worker_ai/ai/tools/file_read.py status: ok";
        assert_eq!(mask(t), t);
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(mask(sha), sha);
    }

    #[test]
    fn masks_json_keys() {
        let v = serde_json::json!({"host":"a","db_password":"x","nested":{"token":"y","cmd":"ls"}});
        let m = mask_json(&v);
        assert_eq!(m["db_password"], "****");
        assert_eq!(m["nested"]["token"], "****");
        assert_eq!(m["nested"]["cmd"], "ls");
    }
}
