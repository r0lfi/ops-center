"""Authentication observations and explicitly configured trusted origins."""

import asyncio
import ipaddress
import socket
import time
from sqlalchemy import select, or_
from app.services.traffic_settings import load_config, enabled_sources
from app.models.traffic import TrafficEntry as E, TrafficSecurityAlert as A

AUTH_SIGNALS = ("auth_failure", "auth_throttled", "auth_success", "auth_attempt")
TITLES = {
    "ssh_rejected": "SSH authentication rejected outside trusted addresses",
    "foreign_ssh": "Successful SSH login outside your current IP",
    "login_rejected": "Login rejected",
    "foreign_login": "Successful login outside trusted origins",
    "foreign_vpn": "Authenticated VPN handshake outside trusted origins",
}
_cache = None
_cache_until = 0.0
_cache_hosts = ()


async def trusted_origins(config=None):
    """Resolve only configured hostnames; DNS failures never retain stale exemptions."""
    global _cache, _cache_until, _cache_hosts
    settings = config if config is not None else await load_config()
    hosts = tuple(settings.trusted_dns)
    countries = list(settings.allowed_countries)
    source_policy = {
        "source_ids": [s.id for s in enabled_sources(settings)],
        "ssh_failure_sources": [
            s.id
            for s in enabled_sources(settings)
            if s.kind == "ssh" and s.ssh_failures
        ],
    }
    if _cache is not None and hosts == _cache_hosts and time.monotonic() < _cache_until:
        return {**_cache, "countries": countries, **source_policy}
    addresses, errors = set(), []
    for host in hosts:
        try:
            rows = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(
                    host, None, type=socket.SOCK_STREAM
                ),
                5,
            )
            ips = {
                str(ipaddress.ip_address(row[4][0]))
                for row in rows
                if ipaddress.ip_address(row[4][0]).is_global
            }
            if not ips:
                raise ValueError("No public addresses")
            addresses.update(ips)
        except (OSError, ValueError, asyncio.TimeoutError):
            errors.append("Could not resolve public addresses for " + host)
    _cache = {
        "countries": countries,
        "dns_names": list(hosts),
        "addresses": sorted(addresses),
        "checked_at": time.time(),
        "error": "; ".join(errors) or None,
    }
    _cache_hosts = hosts
    _cache_until = time.monotonic() + (10 if errors else 60)
    return {**_cache, **source_policy}


def origin_reason(ip, country, policy, kind=None):
    if (
        kind != "ssh"
        and country
        and country.casefold() in {name.casefold() for name in policy["countries"]}
    ):
        return "Allowed country"
    try:
        if str(ipaddress.ip_address(ip)) in policy["addresses"]:
            return "Current trusted DNS address"
    except ValueError:
        pass
    return None


def outcome(event):
    if event["kind"] == "wireguard":
        return "vpn_handshake"
    return {
        "auth_attempt": "login_attempt",
        "auth_success": "login_success",
        "auth_failure": "login_failure",
        "auth_throttled": "login_limited",
    }.get(event.get("signal"))


def candidate(event, policy):
    result = outcome(event)
    if result is None:
        return None
    ssh = event["kind"] == "ssh"
    if (
        ssh
        and result != "login_success"
        and event.get("source") not in policy.get("ssh_failure_sources", [])
    ):
        return None
    if ssh and origin_reason(event["ip"], event.get("country"), policy, "ssh"):
        return None
    if result in ("login_failure", "login_limited", "login_attempt"):
        rule, severity = ("ssh_rejected" if ssh else "login_rejected"), "warning"
        note = (
            "SSH authentication was rejected or the connection ended before authentication; this is not proof of a bad password."
            if ssh
            else "Authentication submission was rejected or rate-limited. This does not establish that an account exists."
        )
    else:
        if origin_reason(event["ip"], event.get("country"), policy, event["kind"]):
            return None
        rule, severity = (
            "foreign_ssh"
            if ssh
            else "foreign_vpn" if result == "vpn_handshake" else "foreign_login"
        ), "high"
        note = (
            "OpenSSH accepted authentication from outside the current trusted DNS addresses. Investigate promptly."
            if ssh
            else (
                "Authenticated WireGuard handshake observed outside trusted origins. Rekeys are not separate user logins; endpoint location is sampled."
                if result == "vpn_handshake"
                else "Application returned a successful authentication response outside trusted origins. Investigate promptly; IP location does not establish who signed in."
            )
        )
    return dict(
        source=event.get("source"),
        rule=rule,
        severity=severity,
        ip=event["ip"],
        domain=event["domain"],
        count=1,
        last_seen=event["ts"],
        evidence={
            "country": event.get("country") or "Unknown",
            "outcome": result,
            "note": note,
        },
    )


async def persist(db, item, now):
    # Group pending submissions into the next digest. A new login after delivery
    # produces a new pending alert, even for a previously seen IP.
    cooldown = 3600 if item["rule"] == "foreign_vpn" else 60
    previous = (
        await db.execute(
            select(A)
            .where(
                A.source == item.get("source"),
                A.rule == item["rule"],
                A.domain == item["domain"],
                A.ip == item["ip"],
                A.created_at >= now - cooldown,
            )
            .order_by(A.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if previous and (
        item["rule"] == "foreign_vpn"
        or (previous.notified_at is None and previous.reviewed_at is None)
    ):
        previous.last_seen = max(previous.last_seen, item["last_seen"])
        previous.count += item["count"]
        previous.evidence = item["evidence"]
    else:
        db.add(A(**item, created_at=now))


async def scan(db, checkpoint, max_id, now, policy):
    if "auth_cursor" not in checkpoint:
        checkpoint.update(auth_cursor=max_id, auth_started_at=now, auth_policy=policy)
        return False
    rows = (
        (
            await db.execute(
                select(E)
                .where(
                    E.id > checkpoint["auth_cursor"],
                    E.id <= max_id,
                    E.source.in_(policy.get("source_ids", [])),
                    or_(E.signal.in_(AUTH_SIGNALS), E.kind == "wireguard"),
                )
                .order_by(E.id)
                .limit(501)
            )
        )
        .scalars()
        .all()
    )
    grouped = {}
    for e in rows[:500]:
        if not checkpoint["auth_started_at"] <= e.ts <= now + 60:
            continue
        item = candidate(
            {
                k: getattr(e, k)
                for k in ("ts", "ip", "country", "kind", "signal", "domain", "source")
            },
            policy,
        )
        if item:
            key = (item["source"], item["rule"], item["domain"], item["ip"])
            if key in grouped:
                grouped[key]["count"] += 1
                grouped[key]["last_seen"] = max(
                    grouped[key]["last_seen"], item["last_seen"]
                )
            else:
                grouped[key] = item
    for item in grouped.values():
        await persist(db, item, now)
    # Never discard unprocessed successes when the bounded batch fills up.
    checkpoint.update(
        auth_cursor=rows[499].id if len(rows) > 500 else max_id, auth_policy=policy
    )
    return len(rows) > 500
