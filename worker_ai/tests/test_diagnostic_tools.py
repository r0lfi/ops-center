import json
from pathlib import Path

import pytest

from worker_ai.ai.tools import TOOL_REGISTRY, TOOL_SCHEMAS
from worker_ai.ai.tools import diagnostic_tools as dt
from worker_ai.ai.tools.exec_tools import TOOL_APPROVAL_LEVEL

PLAYBOOK = Path(__file__).resolve().parents[2] / "ansible/playbooks/diagnostic-query.yml"

# Every check must start with one of these read-only programs, with a fixed
# subcommand where the program can also write (systemctl, docker).
READ_ONLY_PREFIXES = {
    ("df",), ("lsblk",), ("pvs",), ("vgs",), ("lvs",), ("findmnt",), ("free",), ("uptime",),
    ("cat", "/etc/os-release"), ("uname",), ("ps",), ("systemctl", "--failed"),
    ("systemctl", "status"), ("journalctl",), ("ss",), ("docker", "ps"), ("docker", "logs"),
    ("docker", "inspect"), ("docker", "stats"), ("docker", "system", "df"), ("curl",), ("getent",),
    ("find", "-P"), ("dnf", "-q", "updateinfo"), ("dnf", "-q", "check-update"), ("dnf", "-q", "needs-restarting"),
    ("apt-get", "-s"), ("find", "/var/lib/apt/lists"), ("find", "/run"), ("rpm", "-q", "--last"),
    ("dpkg-query", "-W"), ("needrestart", "-b"),
}

SAMPLE_ARGS = {"path": "/data", "unit": "docker.service", "container": "ops-center-api",
               "url": "https://example.com/health", "name": "example.com",
               "pattern": "server_name|listen"}


def _prefixes(argv):
    return {tuple(argv[:n]) for n in range(1, 4)}


@pytest.mark.parametrize("check", list(dt.CHECKS))
def test_every_check_is_a_known_read_only_command(check):
    args = dict(SAMPLE_ARGS, path="/etc/nginx/conf.d/*.conf") if check == "file_grep" else dict(SAMPLE_ARGS)
    for argv in dt.build_commands(check, args):
        assert _prefixes(argv) & READ_ONLY_PREFIXES, argv
        assert all(isinstance(a, str) and "{{" not in a and "{%" not in a for a in argv)


def test_curl_is_plain_bounded_get_with_body_discarded():
    argv = dt.build_commands("http_check", {"url": "https://example.com"})[0]
    assert "--max-time" in argv and argv[argv.index("-o") + 1] == "/dev/null"
    assert not {"-X", "-d", "--data", "-F", "-T", "--upload-file"} & set(argv)


@pytest.mark.parametrize("check,args", [
    ("service_status", {"unit": "docker; rm -rf /"}),
    ("service_status", {"unit": "--kill-who=all"}),
    ("service_status", {"unit": "a{{ lookup('pipe','id') }}"}),
    ("service_status", {"unit": "foo\\x2dbar"}),
    ("service_status", {}),
    ("journal", {"unit": "$(id)"}),
    ("journal", {"lines": 100000}),
    ("journal", {"minutes": -5}),
    ("journal", {"lines": True}),
    ("journal", {"priority": "everything"}),
    ("docker_logs", {"container": "-f"}),
    ("docker_logs", {"container": "api && reboot"}),
    ("docker_inspect", {"container": "../x"}),
    ("disk_usage", {"path": "relative/path"}),
    ("disk_usage", {"path": "/data/../etc"}),
    ("disk_usage", {"path": "/data/*"}),
    ("http_check", {"url": "file:///etc/shadow"}),
    ("http_check", {"url": "https://example.com/{a,b}"}),
    ("http_check", {"url": "https://example.com/ -o /etc/passwd"}),
    ("dns_lookup", {"name": "-s"}),
    ("file_grep", {"path": "/etc/shadow", "pattern": "root"}),
    ("file_grep", {"path": "/root/.ssh/id_rsa", "pattern": "x"}),
    ("file_grep", {"path": "/data/docker/config/../../../etc/shadow", "pattern": "x"}),
    ("file_grep", {"path": "/data/docker/config/./x/*.conf", "pattern": "x"}),
    ("file_grep", {"path": "/data/docker/config/*/x.conf", "pattern": "x"}),
    ("file_grep", {"path": "/data/docker/config/npm/-delete", "pattern": "x"}),
    ("file_grep", {"path": "/data/docker/config/npm/*.conf", "pattern": "{{ lookup('pipe','id') }}"}),
    ("file_grep", {"path": "/data/docker/config/npm/*.conf", "pattern": "a\nb"}),
    ("file_grep", {"path": "/data/docker/config/npm/*.conf", "pattern": ""}),
    ("file_grep", {"path": "/data/docker/config/npm/*.conf", "pattern": "x", "max_matches": 5000}),
    ("file_grep", {"path": "/etc/nginxevil/x.conf", "pattern": "x"}),
    ("not_a_check", {}),
])
def test_rejects_unsafe_or_invalid_arguments(check, args):
    with pytest.raises(ValueError):
        dt.build_commands(check, args)


def test_invalid_arguments_never_reach_ansible(monkeypatch):
    called = []
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a, **k: called.append(a))
    result = dt.run_diagnostic("docker-host-01", "service_status", unit="x; reboot")
    assert result["available"] is False and "unit" in result["error"]
    assert called == []


def test_runs_catalog_argv_through_diagnostic_playbook(monkeypatch):
    seen = {}

    def fake(hostname, playbook, extra_vars):
        seen.update(hostname=hostname, playbook=playbook, extra_vars=extra_vars)
        return {"available": True, "results": [
            {"item": ["timeout", "25", "df", "-hT", "/data"], "rc": 0, "stdout": "Filesystem ...", "stderr": ""}]}

    monkeypatch.setattr(dt, "run_ansible_query", fake)
    result = dt.run_diagnostic("docker-host-02", "disk_usage", path="/data")
    assert seen == {"hostname": "docker-host-02", "playbook": "diagnostic-query.yml",
                    "extra_vars": {"diag_commands": [["df", "-hT", "/data"]]}}
    assert result["available"] and result["outputs"][0]["stdout"] == "Filesystem ..."
    assert result["outputs"][0]["timed_out"] is False


def test_unreachable_host_is_passed_through(monkeypatch):
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a: {"available": False, "error": "no host"})
    assert dt.run_diagnostic("nope", "uptime") == {"available": False, "error": "no host"}


def test_timeout_is_flagged(monkeypatch):
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a: {
        "available": True, "results": [{"item": ["docker", "ps", "-a"], "rc": 124, "stdout": "", "stderr": ""}]})
    assert dt.run_diagnostic("h", "docker_ps")["outputs"][0]["timed_out"] is True


def test_docker_inspect_strips_env_values(monkeypatch):
    inspect = [{"Name": "/api", "Config": {"Env": ["DATABASE_URL=postgres://u:secret@db/x", "TZ=UTC"]}}]
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a: {
        "available": True, "results": [{"item": [], "rc": 0, "stdout": json.dumps(inspect), "stderr": ""}]})
    out = dt.run_diagnostic("h", "docker_inspect", container="api")["outputs"][0]["stdout"]
    assert "secret" not in out and "UTC" not in out
    assert "DATABASE_URL=<redacted>" in out and "TZ=<redacted>" in out


def test_docker_inspect_non_json_is_withheld(monkeypatch):
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a: {
        "available": True, "results": [{"item": [], "rc": 1, "stdout": "PASSWORD=x", "stderr": ""}]})
    assert "PASSWORD" not in dt.run_diagnostic("h", "docker_inspect", container="api")["outputs"][0]["stdout"]


def test_long_output_keeps_newest_tail():
    text = "old\n" * 5000 + "NEWEST"
    clipped = dt._clip(text)
    assert clipped.endswith("NEWEST") and len(clipped) < len(text) and "omitted" in clipped


def test_registered_as_direct_read_tool_not_approval_gated():
    assert TOOL_REGISTRY["run_diagnostic"] is dt.run_diagnostic
    assert TOOL_SCHEMAS["run_diagnostic"]["name"] == "run_diagnostic"
    assert "run_diagnostic" not in TOOL_APPROVAL_LEVEL
    assert set(TOOL_SCHEMAS["run_diagnostic"]["parameters"]["properties"]["check"]["enum"]) == set(dt.CHECKS)


def test_playbook_uses_argv_command_not_shell():
    text = PLAYBOOK.read_text()
    assert "ansible.builtin.command:" in text and "argv:" in text
    assert "ansible.builtin.shell" not in text and "raw:" not in text
    assert "changed_when: false" in text


def test_tls_check_pins_endpoint_and_rejects_unsafe_input():
    from worker_ai.ai.tools.diagnostic_tools import build_commands
    argv = build_commands("tls_check", {"url": "https://vpn.example.org/", "ip": "192.0.2.10"})[0]
    assert argv[:3] == ["curl", "-sS", "-v"] and argv[-1] == "https://vpn.example.org/"
    assert argv[argv.index("--resolve") + 1] == "vpn.example.org:443:192.0.2.10"
    v6 = build_commands("tls_check", {"url": "https://vpn.example.org:8443/", "ip": "2001:db8::1"})[0]
    assert v6[v6.index("--resolve") + 1] == "vpn.example.org:8443:[2001:db8::1]"
    for bad in ({"url": "http://vpn.example.org/"}, {"url": "https://x/", "ip": "1.2.3.4 -k"},
                {"url": "https://x/ -k"}, {"url": "https://{{x}}/"}):
        with pytest.raises(ValueError):
            build_commands("tls_check", bad)


def test_http_check_reports_redirect_target():
    from worker_ai.ai.tools.diagnostic_tools import build_commands
    argv = build_commands("http_check", {"url": "https://media.example.org/"})[0]
    assert "redirect=%{redirect_url}" in argv[argv.index("-w") + 1]



def test_file_grep_stays_in_one_allowed_directory_and_skips_secret_files():
    argv = dt.build_commands("file_grep", {"path": "/data/docker/config/nginx-proxy/nginx/proxy_host/*.conf",
                                           "pattern": "server_name|listen"})[0]
    assert argv[:3] == ["find", "-P", "/data/docker/config/"]  # always the fixed root, never the requested path
    assert argv[argv.index("-mindepth") + 1] == argv[argv.index("-maxdepth") + 1] == "4"
    assert argv[argv.index("-path") + 1] == "/data/docker/config/nginx-proxy/nginx/proxy_host/*.conf"
    assert argv[argv.index("-type") + 1] == "f"
    for glob in ("*.key", "*.pem", "*.env", ".env*", "*secret*"):
        assert glob in argv
    grep = argv[argv.index("-exec") + 1:]
    assert grep[:2] == ["grep", "-nHIE"] and grep[grep.index("-e") + 1] == "server_name|listen" and grep[-3:] == ["--", "{}", "+"]


def test_file_grep_output_is_redacted_before_it_reaches_the_model(monkeypatch):
    leaked = "\n".join([
        "/data/docker/config/x/app.yml:3:  pass" + "word: hunter2" + "hunter2",
        "/data/docker/config/x/app.yml:4:  api_" + "key = 'abcd1234" + "efgh'",
        "/data/docker/config/x/app.yml:5:  url: postgres://ops:" + "s3cr3t@db/ops",
        "/data/docker/config/x/app.yml:6:  Authorization: Bearer abcdefghijklmnop",
        "/data/docker/config/x/app.yml:7:  server_name media.example.org;",
        "/data/docker/config/x/app.yml:8:  jwt_" + "secret_key: zz9" + "plural",
        "/data/docker/config/x/app.yml:9:  DB_PASS" + "WORD=qq7" + "longvalue",
    ])
    monkeypatch.setattr(dt, "run_ansible_query", lambda *a, **k: {"available": True, "results": [{"item": ["find"], "rc": 0, "stdout": leaked, "stderr": ""}]})
    out = dt.run_diagnostic("h", "file_grep", path="/data/docker/config/x/*.yml", pattern="password|key|url|Auth|server")["outputs"][0]["stdout"]
    for secret in ("hunter2", "abcd1234", "s3cr3t", "abcdefghijklmnop", "zz9", "qq7"):
        assert secret not in out
    assert "server_name media.example.org;" in out and out.count("<redacted>") >= 4


def test_package_checks_never_install_and_skip_the_other_family(monkeypatch):
    for check in dt.PACKAGE_CHECKS:
        for argv in dt.build_commands(check, {}):
            assert not {"install", "upgrade", "update", "remove", "erase", "autoremove", "--refresh", "-y"} & set(argv), argv
            if argv[0] == "apt-get":
                assert argv[1] == "-s"
            if argv[0] == "needrestart":
                assert argv[1:] == ["-b", "-r", "l"]  # batch, list only: never restarts
    seen = {}
    apt = "\n".join(["Inst openssl [3.0.1] (3.0.2 Debian-Security:12/stable-security [amd64])",
                      "Conf openssl (3.0.2 Debian-Security:12/stable-security [amd64])",
                      "Inst vim [9.0] (9.1 Debian:12.9/stable [amd64])", "2 upgraded, 0 newly installed, 0 to remove"])
    def query(hostname, playbook, extra, timeout=45):
        seen.update(extra=extra, timeout=timeout)
        return {"available": True, "results": [
            {"item": ["dnf", "-q", "check-update"], "rc": 127, "stdout": "", "stderr": "timeout: failed to run command 'dnf': No such file or directory"},
            {"item": ["apt-get", "-s", "-o", "Debug::NoLocking=1", "dist-upgrade"], "rc": 0, "stdout": apt, "stderr": ""},
        ]}
    monkeypatch.setattr(dt, "run_ansible_query", query)
    out = dt.run_diagnostic("pve", "pending_updates")["outputs"]
    assert out[0]["skipped"] == "not available on this host"
    assert out[1]["stdout"].startswith("2 packages to upgrade, 1 from a security origin") and "Conf " not in out[1]["stdout"]
    assert seen["extra"]["diag_timeout"] == dt.PACKAGE_TIMEOUT_SECONDS and seen["timeout"] > dt.PACKAGE_TIMEOUT_SECONDS


def test_playbook_takes_a_bounded_per_check_timeout():
    text = PLAYBOOK.read_text()
    assert "['timeout', (diag_timeout | default(25) | int | string)] + item" in text
