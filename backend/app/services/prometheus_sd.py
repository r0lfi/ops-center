import json
import os
import tempfile
from pathlib import Path

from app.models.host import Host

NODE_EXPORTER_PORT = 9100
FILE_SD_PATH = Path(os.environ.get("PROMETHEUS_SD_PATH", "/app/prometheus-sd/node_exporters.json"))


def write_node_exporter_targets(hosts: list[Host]) -> None:
    """
    Regenerates the Prometheus file_sd target file from the hosts table.
    Written atomically (temp file + rename) so Prometheus - which polls this
    file on its own refresh_interval - never sees a half-written file, and
    never needs to be restarted to pick up new/removed hosts.
    """
    targets = [
        {
            "targets": [f"{host.monitoring_ip_address or host.ip_address}:{NODE_EXPORTER_PORT}"],
            "labels": {
                "hostname": host.hostname,
                "environment": host.environment,
                "criticality": host.criticality,
                "job": "node_exporter",
            },
        }
        for host in hosts
        if host.monitoring_enabled
    ]

    FILE_SD_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=FILE_SD_PATH.parent, prefix=".node_exporters-", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(targets, f, indent=2)
        # mkstemp() creates the file mode 0600 (owner-only) - Prometheus runs
        # as a different container user and needs to be able to read it.
        os.chmod(tmp_path, 0o644)
        os.rename(tmp_path, FILE_SD_PATH)
    except BaseException:
        Path(tmp_path).unlink(missing_ok=True)
        raise
