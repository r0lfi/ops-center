"""Bounded remote log reader. Only parsed observation metadata crosses SSH."""

import datetime
import glob
import hashlib
import ipaddress
import json
import os
import re
import sys

NPM = re.compile(
    r'^\[(?P<date>[^\]]+)\]\s+\S+\s+(?P<upstream>\S+)\s+(?P<status>\d+)\s+-\s+(?P<method>\S+)\s+\S+\s+(?P<domain>\S+)\s+"(?P<uri>[^"]*)"\s+\[Client\s+(?P<ip>[^\]]+)\]'
)
CHUNK = 256 * 1024
BUDGET = 2 * 1024 * 1024


def classify(domain, method, uri, status, upstream=None, config=None):
    config = config or {}
    # Never return/store paths, query parameters, credentials or usernames.
    from urllib.parse import unquote, urlsplit

    path = unquote(urlsplit(uri[:8192]).path).lower().rstrip("/")
    media_auth = (
        config.get("application") == "jellyfin"
        and domain in config.get("auth_domains", [])
        and bool(
            re.fullmatch(
                r"/(?:jellyfin/)?users/(?:authenticatebyname|authenticatewithquickconnect|[0-9a-f-]{32,36}/authenticate)",
                path,
            )
        )
    )
    vpn_admin_auth = (
        config.get("application") == "wg_easy"
        and domain in config.get("auth_domains", [])
        and path == "/api/session"
    )
    generic_auth = path in (
        "/login",
        "/auth/login",
        "/api/auth/login",
        "/wp-login.php",
        "/api/session",
    )
    if method == "POST" and (media_auth or vpn_admin_auth or generic_auth):
        if status in (401, 403):
            return "auth_failure"
        if status == 429:
            return "auth_throttled"
        # Only this verified app contract can establish a successful login.
        # Caddy alone and a generic HTTP 200/302 never imply authentication.
        if (media_auth or vpn_admin_auth) and status == 200 and upstream == "200":
            return "auth_success"
    if (
        re.search(
            r"(?:^|/)(?:\.env(?:\.|$)|\.git(?:/|$)|wp-config\.php|phpmyadmin(?:/|$)|xmlrpc\.php|vendor/phpunit(?:/|$))",
            path,
        )
        or "../" in path
    ):
        return "probe"
    return None


def parse_line(line, source, config=None):
    config = config or {}
    source_id = config.get("id", source)
    try:
        if source == "auth_audit":
            record = json.loads(line)
            ip = str(ipaddress.ip_address(record["ip"]))
            if not re.fullmatch(r"[0-9a-f]{32}", record["id"]):
                return None
            if record["signal"] not in (
                "auth_success",
                "auth_failure",
                "auth_throttled",
            ):
                return None
            return {
                "event_key": hashlib.sha256(
                    (source_id + ":" + record["id"]).encode()
                ).hexdigest(),
                "ts": float(record["ts"]),
                "ip": ip,
                "domain": config.get("domain", "audit.example"),
                "status": None,
                "signal": record["signal"],
                "kind": "auth",
                "source": source_id,
            }
        if source == "caddy":
            record = json.loads(line)
            request = record.get("request", {})
            ip = request.get("client_ip") or request.get("remote_ip")
            method = request.get("method", "")
            uri = request.get("uri", "")
            upstream = None
            domain = request.get("host", "")
            ts = float(record["ts"])
            status = int(record["status"])
        else:
            m = NPM.match(line)
            if not m:
                return None
            ip = m["ip"].strip()
            domain = m["domain"]
            status = int(m["status"])
            method = m["method"]
            uri = m["uri"]
            upstream = m["upstream"]
            ts = datetime.datetime.strptime(
                m["date"], "%d/%b/%Y:%H:%M:%S %z"
            ).timestamp()
        if not ipaddress.ip_address(ip).is_global:
            return None
        domain = domain.lower().rstrip(".").split(":")[0]
        if (
            not re.fullmatch(r"[a-z0-9.-]+", domain)
            or len(domain) > 253
            or not 100 <= status <= 599
        ):
            return None
        return {
            "ts": ts,
            "ip": ip,
            "domain": domain,
            "status": status,
            "signal": classify(domain, method, uri, status, upstream, config),
            "kind": "http",
            "source": source_id,
        }
    except (ValueError, TypeError, KeyError, OverflowError):
        return None


def read_file(path, cursor, limit):
    # An open fd keeps inode and bytes consistent if rotation races this read.
    with open(path, "rb") as f:
        stat = os.fstat(f.fileno())
        identity = str(stat.st_dev) + ":" + str(stat.st_ino)
        offset = cursor.get("offset", 0)
        initial = not cursor
        if cursor.get("inode") != identity or offset > stat.st_size:
            offset = max(0, stat.st_size - CHUNK) if initial else 0
        if initial and offset:
            f.seek(offset - 1)
            if f.read(1) != b"\n":
                f.readline()
                offset = f.tell()
        f.seek(offset)
        raw = f.read(min(limit, CHUNK))
        end = raw.rfind(b"\n")
        if end < 0:
            if len(raw) == CHUNK:  # skip an oversized non-log line; bounded work
                return [], {"inode": identity, "offset": offset + len(raw)}, len(raw)
            return [], {"inode": identity, "offset": offset}, len(raw)
        raw = raw[: end + 1]
        records = []
        position = offset
        for line in raw.splitlines(keepends=True):
            records.append((identity, position, line.decode("utf-8", errors="replace")))
            position += len(line)
        return records, {"inode": identity, "offset": position}, len(raw)


def collect(source, checkpoint, config):
    pattern = config["log_path"]
    paths = sorted(glob.glob(pattern))[:128]
    if source == "auth_audit" and not any(c in pattern for c in "*?"):
        paths = [
            p
            for p in [pattern] + [pattern + "." + str(i) for i in range(1, 4)]
            if os.path.isfile(p)
        ]
    if not paths:
        raise RuntimeError("No access logs found")
    cursors = checkpoint.get("files", {})
    out = {}
    events = []
    budget = BUDGET
    # Rotate starting path to keep high-volume files from starving later files.
    start = int(checkpoint.get("next_file", 0)) % len(paths)
    ordered = paths[start:] + paths[:start]
    visited = 0
    for path in ordered:
        if budget <= 0:
            break
        lines, cursor, used = read_file(path, cursors.get(path, {}), budget)
        out[path] = cursor
        budget -= used
        visited += 1
        for identity, offset, line in lines:
            record = parse_line(line, source, config)
            if record:
                record["event_key"] = (
                    record.get("event_key")
                    or hashlib.sha256(
                        (
                            config["id"]
                            + ":"
                            + path
                            + ":"
                            + identity
                            + ":"
                            + str(offset)
                            + ":"
                            + line
                        ).encode()
                    ).hexdigest()
                )
                events.append(record)
    return {
        "events": events,
        "checkpoint": {
            "files": {p: out.get(p, cursors.get(p, {})) for p in paths},
            "next_file": (start + visited) % len(paths),
            "file_count": len(paths),
        },
    }


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    print(
        json.dumps(
            collect(request["source"], request.get("checkpoint", {}), request["config"])
        )
    )
