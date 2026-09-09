from worker.patch_parser import parse_patch_check


def test_rhel_pending_without_security_is_not_flagged():
    payload = {
        "family": "rhel",
        "reboot_required": False,
        "pending": ["bash.x86_64      5.1.8-9.el9    appstream"],
        "security": [],
        "advisory_detail": [],
    }
    records, reboot_required = parse_patch_check(payload)
    assert reboot_required is False
    assert len(records) == 1
    record = records[0]
    assert record["package_name"] == "bash"
    assert record["fixed_version"] == "5.1.8-9.el9"
    assert record["repository"] == "appstream"
    assert record["is_security"] is False
    assert record["severity"] == "unknown"
    assert record["cve_ids"] == []


def test_rhel_security_advisory_attaches_severity_and_cves():
    payload = {
        "family": "rhel",
        "reboot_required": True,
        "pending": ["kernel.x86_64      5.14.0-427.el9    baseos"],
        "security": ["ALSA-2026:36956 Important/Sec. kernel-5.14.0-427.el9.x86_64"],
        "advisory_detail": [
            "Update ID: ALSA-2026:36956",
            "    Bugs: 123 -",
            "    CVEs: CVE-2025-71066",
            "        : CVE-2026-46113",
            "Description: kernel security update",
        ],
    }
    records, reboot_required = parse_patch_check(payload)
    assert reboot_required is True
    assert len(records) == 1
    record = records[0]
    assert record["package_name"] == "kernel"
    assert record["is_security"] is True
    assert record["severity"] == "important"
    assert record["advisory_id"] == "ALSA-2026:36956"
    assert record["cve_ids"] == ["CVE-2025-71066", "CVE-2026-46113"]


def test_debian_pending_flags_security_by_suite():
    payload = {
        "family": "debian",
        "reboot_required": False,
        "pending": ["openssl/jammy-security 3.0.2-0ubuntu1.15 amd64"],
        "security": ["openssl/jammy-security 3.0.2-0ubuntu1.15 amd64"],
    }
    records, _ = parse_patch_check(payload)
    assert len(records) == 1
    record = records[0]
    assert record["package_name"] == "openssl"
    assert record["fixed_version"] == "3.0.2-0ubuntu1.15"
    assert record["is_security"] is True


def test_unknown_family_returns_no_records():
    records, reboot_required = parse_patch_check({"family": "unknown-distro"})
    assert records == []
    assert reboot_required is False
