"""Read authenticated WireGuard handshake metadata, never peer keys."""

import hashlib
import ipaddress
import json
import subprocess
import sys


def collect(config):
    command = (
        ["docker", "exec", config["container"]] if config.get("container") else []
    ) + ["wg", "show", config["interface"]]

    def values(part):
        out = subprocess.check_output(command + [part], text=True, timeout=8)
        return dict(line.split(None, 1) for line in out.splitlines() if line.strip())

    endpoints = values("endpoints")
    handshakes = values("latest-handshakes")
    events = []
    for key, value in handshakes.items():
        ts = int(value)
        endpoint = endpoints.get(key, "")
        if ts <= 0 or endpoint == "(none)":
            continue
        try:
            ip = str(ipaddress.ip_address(endpoint.rsplit(":", 1)[0].strip("[]")))
            if not ipaddress.ip_address(ip).is_global:
                continue
        except ValueError:
            continue
        events.append(
            {
                "event_key": hashlib.sha256(
                    (config["id"] + ":" + key + ":" + str(ts) + ":" + ip).encode()
                ).hexdigest(),
                "ts": ts,
                "ip": ip,
                "domain": config["domain"],
                "status": None,
                "kind": "wireguard",
                "source": config["id"],
            }
        )
    return {"events": events, "checkpoint": {"file_count": 1}}


if __name__ == "__main__":
    print(json.dumps(collect(json.loads(sys.argv[1]))))
