"""
Parses the OPS_CENTER_PATCH_CHECK:{json} marker emitted by
ansible/playbooks/patch-check.yml into structured patch records. Keep this
in sync with that playbook's output shape.
"""

import re

_RHEL_SEVERITY_MAP = {
    "critical": "critical",
    "important": "important",
    "moderate": "moderate",
    "low": "low",
}


def _split_nvra(nvra: str) -> tuple[str, str | None]:
    """'bash-5.1.8-6.el9.x86_64' -> ('bash', '5.1.8-6.el9')"""
    parts = nvra.rsplit(".", 1)  # strip arch
    base = parts[0] if len(parts) == 2 else nvra
    name_version = base.rsplit("-", 2)
    if len(name_version) == 3:
        name, version, release = name_version
        return name, f"{version}-{release}"
    return base, None


def _parse_rhel_pending(lines: list[str]) -> dict[str, dict]:
    """name -> {installed_version omitted (unknown from check-update alone), fixed_version, repository}"""
    packages: dict[str, dict] = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 3:
            continue
        name_arch, version, repo = parts
        name = name_arch.rsplit(".", 1)[0]
        packages[name] = {"fixed_version": version, "repository": repo}
    return packages


def _parse_rhel_security(lines: list[str]) -> dict[str, dict]:
    """package name -> {advisory_id, severity}"""
    security: dict[str, dict] = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 3:
            continue
        advisory_id, severity_field, nvra = parts
        severity_word = severity_field.split("/")[0].lower()
        severity = _RHEL_SEVERITY_MAP.get(severity_word, "unknown")
        name, version = _split_nvra(nvra)
        security[name] = {"advisory_id": advisory_id, "severity": severity, "fixed_version": version}
    return security


_CVE_PATTERN = re.compile(r"CVE-\d{4}-\d+")


def _parse_rhel_advisory_cves(lines: list[str]) -> dict[str, list[str]]:
    """advisory_id -> [CVE-..., ...], parsed from `dnf updateinfo info security`.

    Format per advisory block:
        Update ID: ALSA-2026:36956
             Bugs: 123 -
                 : 456 -
             CVEs: CVE-2025-71066
                 : CVE-2026-46113
        Description: ...
    "Bugs:"/"CVEs:" continuation lines share the same "    : value" shape,
    so we track which field is currently being continued.
    """
    result: dict[str, list[str]] = {}
    current_advisory: str | None = None
    current_field: str | None = None

    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("Update ID:"):
            current_advisory = line.split(":", 1)[1].strip()
            current_field = None
            result.setdefault(current_advisory, [])
            continue
        if current_advisory is None:
            continue

        if line.startswith("CVEs:"):
            current_field = "cves"
            value = line.split(":", 1)[1].strip()
        elif line.startswith(("Bugs:", "Description:", "Severity:", "Type:", "Updated:")):
            current_field = "bugs" if line.startswith("Bugs:") else None
            value = line.split(":", 1)[1].strip() if ":" in line else ""
        elif line.startswith(":"):
            value = line[1:].strip()
        else:
            current_field = None
            continue

        if current_field == "cves" and _CVE_PATTERN.fullmatch(value):
            result[current_advisory].append(value)

    return result


def _parse_debian_pending(lines: list[str]) -> dict[str, dict]:
    packages: dict[str, dict] = {}
    pattern = re.compile(r"^(?P<name>\S+)/(?P<suite>\S+)\s+(?P<version>\S+)\s+(?P<arch>\S+)")
    for line in lines:
        match = pattern.match(line.strip())
        if not match:
            continue
        packages[match.group("name")] = {
            "fixed_version": match.group("version"),
            "repository": match.group("suite"),
        }
    return packages


def _parse_debian_security(lines: list[str]) -> set[str]:
    pattern = re.compile(r"^(?P<name>\S+)/")
    names = set()
    for line in lines:
        match = pattern.match(line.strip())
        if match:
            names.add(match.group("name"))
    return names


def parse_patch_check(payload: dict) -> tuple[list[dict], bool]:
    """
    Returns (patch_records, reboot_required). Each patch_record has:
    package_name, installed_version, fixed_version, is_security, severity,
    advisory_id, repository.
    """
    family = payload.get("family")
    reboot_required = bool(payload.get("reboot_required", False))
    records: list[dict] = []

    if family == "rhel":
        pending = _parse_rhel_pending(payload.get("pending") or [])
        security = _parse_rhel_security(payload.get("security") or [])
        cves_by_advisory = _parse_rhel_advisory_cves(payload.get("advisory_detail") or [])
        for name, info in pending.items():
            sec = security.get(name)
            advisory_id = sec["advisory_id"] if sec else None
            records.append(
                {
                    "package_name": name,
                    "installed_version": None,
                    "fixed_version": info.get("fixed_version"),
                    "repository": info.get("repository"),
                    "is_security": sec is not None,
                    "severity": sec["severity"] if sec else "unknown",
                    "advisory_id": advisory_id,
                    "cve_ids": cves_by_advisory.get(advisory_id, []) if advisory_id else [],
                }
            )
    elif family == "debian":
        pending = _parse_debian_pending(payload.get("pending") or [])
        security_names = _parse_debian_security(payload.get("security") or [])
        for name, info in pending.items():
            records.append(
                {
                    "package_name": name,
                    "installed_version": None,
                    "fixed_version": info.get("fixed_version"),
                    "repository": info.get("repository"),
                    "is_security": name in security_names,
                    "severity": "unknown",
                    "advisory_id": None,
                    "cve_ids": [],
                }
            )

    return records, reboot_required
