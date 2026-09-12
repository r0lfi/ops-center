"""Bounded OpenSSH journal reader, executed on the configured managed host. No usernames or keys leave the host."""

import hashlib
import ipaddress
import json
import re
import subprocess
import sys
import time


def parse(record, config=None):
    config = config or {}
    if record.get("_COMM") not in ("sshd", "sshd-session", "sshd-auth"):
        return None
    message = record.get("MESSAGE", "")
    if not isinstance(message, str):
        return None
    match = re.match(r"Accepted \S+ for .*? from (\S+) port \d+", message)
    signal = "auth_success"
    if not match and config.get("ssh_failures"):
        match = re.match(r"Failed \S+ for .*? from (\S+) port \d+", message)
        signal = "auth_failure"
    if not match:
        return None
    try:
        ip = ipaddress.ip_address(match[1])
        if ip.is_unspecified or ip.is_multicast:
            return None
        return {
            "event_key": hashlib.sha256(
                (config.get("id", "ssh") + ":" + record["__CURSOR"]).encode()
            ).hexdigest(),
            "ts": int(record["__REALTIME_TIMESTAMP"]) / 1000000,
            "ip": str(ip),
            "kind": "ssh",
            "domain": config.get("domain") or config.get("hostname", "ssh"),
            "source": config.get("id", "ssh"),
            "status": None,
            "signal": signal,
        }
    except (ValueError, KeyError, TypeError):
        return None


def collect(checkpoint, config=None):
    config = config or {}
    base = [
        "journalctl",
        "-u",
        config.get("journal_unit", "sshd"),
        "--no-pager",
        "-o",
        "json",
        "--output-fields=MESSAGE,__REALTIME_TIMESTAMP,_COMM",
    ]
    if "cursor" not in checkpoint:
        raw = subprocess.check_output(base + ["-n", "1"], text=True, timeout=7)
        records = [
            json.loads(line) for line in raw.splitlines() if line.startswith("{")
        ]
        return {
            "events": [],
            "checkpoint": {
                "cursor": records[-1]["__CURSOR"] if records else "",
                "since": (
                    int(records[-1]["__REALTIME_TIMESTAMP"]) / 1000000
                    if records
                    else time.time()
                ),
                "file_count": 1,
            },
        }
    args = (
        base
        + ["-n", "+501"]
        + (
            ["--after-cursor=" + checkpoint["cursor"]]
            if checkpoint["cursor"]
            else ["--since=@" + str(checkpoint["since"])]
        )
    )
    result = subprocess.run(args, capture_output=True, text=True, timeout=7)
    cp = dict(checkpoint)
    if result.returncode:
        raw = subprocess.check_output(
            base + ["-n", "+501", "--since=@" + str(checkpoint["since"])],
            text=True,
            timeout=7,
        )
        cp["history_gap"] = cp.get("history_gap") or time.time()
    else:
        raw = result.stdout
    records = [json.loads(line) for line in raw.splitlines() if line.startswith("{")]
    events = []
    for record in records[:500]:
        event = parse(record, config)
        if event:
            events.append(event)
        cp.update(
            cursor=record["__CURSOR"],
            since=int(record["__REALTIME_TIMESTAMP"]) / 1000000,
        )
    cp.update(file_count=1, backlog=len(records) > 500)
    return {"events": events, "checkpoint": cp}


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    print(json.dumps(collect(request.get("checkpoint", {}), request.get("config", {}))))
