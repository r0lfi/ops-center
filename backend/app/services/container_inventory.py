"""One allowlist for both existing inventory collectors. Never persist Env/commands."""
import re
from datetime import datetime, timezone


def monitoring_metadata(inspect: dict) -> dict:
    config = inspect.get("Config") or {}
    state = inspect.get("State") or {}
    limits = inspect.get("HostConfig") or {}
    network = inspect.get("NetworkSettings") or {}
    return {
        "stack": (config.get("Labels") or {}).get("com.docker.compose.project"),
        "started_at": state.get("StartedAt"),
        "exit_code": state.get("ExitCode"),
        "memory_limit": limits.get("Memory") or None,
        "nano_cpus": limits.get("NanoCpus") or None,
        "cpu_quota": limits.get("CpuQuota") if (limits.get("CpuQuota") or 0) > 0 else None,
        "cpu_period": limits.get("CpuPeriod") or None,
        "log_driver": (limits.get("LogConfig") or {}).get("Type"),
        "ports": network.get("Ports") or {},
        "networks": list((network.get("Networks") or {}).keys()),
        "mounts": [{k: m.get(k) for k in ("Type", "Source", "Destination", "RW")}
                   for m in inspect.get("Mounts") or []],
    }


def runtime_id(inspect: dict) -> str | None:
    value = inspect.get("Id") or ""
    return value if re.fullmatch(r"[a-f0-9]{64}", value) else None


def runtime_stats(inspect_id: str | None, rows: list[dict]) -> dict | None:
    """A current snapshot, never used to fabricate historical datapoints."""
    if not inspect_id:
        return None
    matches = [r for r in rows if re.fullmatch(r"[a-f0-9]{12,64}", str(r.get("ID", "")))
               and inspect_id.startswith(r["ID"])]
    if len(matches) != 1:
        return None
    row = matches[0]
    cpu = str(row.get("CPUPerc", "")).rstrip("%")
    memory = str(row.get("MemUsage", "")).split(" / ")[0]
    units = {"B": 1, "kB": 1000, "KB": 1000, "MB": 1000**2, "GB": 1000**3,
             "TB": 1000**4, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)", memory)
    return {"cpu_percent": float(cpu) if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", cpu) else None,
            "memory_bytes": float(match[1]) * units[match[2]] if match else None,
            "network_io": str(row["NetIO"])[:100] if row.get("NetIO") else None,
            "block_io": str(row["BlockIO"])[:100] if row.get("BlockIO") else None,
            "captured_at": datetime.now(timezone.utc).isoformat()}
