"""
Vulnerability prioritization. Computed on read (not stored) since it
depends on affected-host criticality, which changes independently of the
vulnerability record itself - recomputing is cheap and always consistent.

Factors, per spec: vendor severity, CVSS, CISA KEV status, EPSS, fix
availability, host criticality, number of affected hosts. ("Internet
exposure" isn't modeled yet - nothing in the schema captures that signal
until blackbox checks are associated with specific servers/services with
an explicit "internet-facing" flag, which is a Blackbox-monitoring UI
feature, not yet built.)
"""

_SEVERITY_BASE = {"critical": 40, "high": 25, "medium": 10, "low": 3, "unknown": 1}
_CRITICALITY_BOOST = {"critical": 20, "high": 12, "medium": 5, "low": 1}

KEV_BOOST = 100  # "CISA KEV vulnerabilities should receive a very large priority increase"

LEVEL_THRESHOLDS = (
    ("emergency", 120),
    ("critical", 70),
    ("high", 40),
    ("medium", 15),
)


def compute_priority(
    *,
    severity: str,
    cvss_score: float | None,
    cisa_kev: bool,
    epss_score: float | None,
    fix_available: bool,
    affected_host_criticalities: list[str],
    affected_host_count: int,
) -> tuple[str, float]:
    score = float(_SEVERITY_BASE.get(severity, 1))
    if cvss_score is not None:
        score += cvss_score * 2
    if cisa_kev:
        score += KEV_BOOST
    if epss_score is not None:
        score += epss_score * 50
    if not fix_available:
        score += 10
    if affected_host_criticalities:
        score += max(_CRITICALITY_BOOST.get(c, 0) for c in affected_host_criticalities)
    score += min(affected_host_count, 10) * 2

    level = "low"
    for name, threshold in LEVEL_THRESHOLDS:
        if score >= threshold:
            level = name
            break

    return level, round(score, 1)
