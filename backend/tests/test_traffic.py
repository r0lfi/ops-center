import json
import os
from pathlib import Path
from app.services.traffic_reader import parse_line, read_file, collect

LINE = '[12/Sep/2026:14:30:10 +0200] - 200 200 - GET https media.example.com "/secret?token=NEVER_STORE" [Client 8.8.8.8] [Length 1]\n'


def test_npm_metadata_drops_paths_and_uses_log_time():
    row = parse_line(LINE, "npm")
    assert row["domain"] == "media.example.com" and row["status"] == 200
    assert row["ts"] == 1789216210
    assert "NEVER_STORE" not in json.dumps(row) and "path" not in row


def test_private_and_malformed_logs_are_ignored():
    for ip in ["192." + "168.20.4", "127.0.0.1", "::1", "not-an-ip", "10." + "23.0.3"]:
        assert parse_line(LINE.replace("8.8.8.8", ip), "npm") is None
    assert parse_line("garbage", "npm") is None


def test_caddy_real_client_and_event_time():
    row = parse_line(
        json.dumps(
            {
                "ts": 1234,
                "status": 403,
                "request": {
                    "client_ip": "1.1.1.1",
                    "remote_ip": "10." + "0.0.1",
                    "host": "MEDIA.EXAMPLE.COM:443",
                    "headers": {"Secret": "never"},
                },
            }
        ),
        "caddy",
    )
    assert (
        row["ip"] == "1.1.1.1"
        and row["domain"] == "media.example.com"
        and row["ts"] == 1234
    )
    assert "never" not in json.dumps(row)


def test_partial_line_only_advances_after_newline(tmp_path):
    p = tmp_path / "access.log"
    p.write_bytes(b"first\npart")
    rows, cursor, _ = read_file(p, {}, 1000)
    assert [r[2] for r in rows] == ["first\n"] and cursor["offset"] == 6
    with p.open("ab") as f:
        f.write(b"ial\n")
    rows, after, _ = read_file(p, cursor, 1000)
    assert [r[2] for r in rows] == ["partial\n"] and after["offset"] == 14


def test_same_length_rotation_restarts_at_new_inode(tmp_path):
    p = tmp_path / "access.log"
    p.write_text("first\n")
    _, cursor, _ = read_file(p, {}, 1000)
    p.rename(tmp_path / "rotated.log")
    p.write_text("other\n")
    rows, after, _ = read_file(p, cursor, 1000)
    assert [r[2] for r in rows] == ["other\n"] and after["inode"] != cursor["inode"]


def test_checkpoint_retry_keeps_event_identity(tmp_path, monkeypatch):
    p = tmp_path / "access.log"
    p.write_text(LINE)
    monkeypatch.setattr("app.services.traffic_reader.glob.glob", lambda _: [str(p)])
    first = collect("npm", {}, {"id": "proxy", "log_path": str(p)})
    retry = collect("npm", {}, {"id": "proxy", "log_path": str(p)})
    assert first["events"] == retry["events"]
    assert (
        collect("npm", first["checkpoint"], {"id": "proxy", "log_path": str(p)})[
            "events"
        ]
        == []
    )


def test_append_bounded_reads_resume_without_skips(tmp_path):
    p = tmp_path / "access.log"
    p.write_text("a\nb\nc\n")
    rows, cursor, _ = read_file(p, {}, 4)
    rows2, _, _ = read_file(p, cursor, 4)
    assert [r[2] for r in rows + rows2] == ["a\n", "b\n", "c\n"]
