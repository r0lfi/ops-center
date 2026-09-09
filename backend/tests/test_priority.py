from app.services.priority import compute_priority


def _score(**overrides):
    base = dict(
        severity="medium",
        cvss_score=None,
        cisa_kev=False,
        epss_score=None,
        fix_available=True,
        affected_host_criticalities=[],
        affected_host_count=0,
    )
    base.update(overrides)
    return compute_priority(**base)


def test_low_severity_no_signals_is_low():
    level, score = _score(severity="low", fix_available=True)
    assert level == "low"


def test_cisa_kev_jumps_a_merely_medium_cve_to_critical_or_above():
    # Spec requirement: KEV should receive a "very large priority increase" -
    # even a merely "medium" severity CVE that's in CISA's Known Exploited
    # Vulnerabilities catalog must not stay at a low/medium priority level.
    without_kev_level, without_kev_score = _score(severity="medium", cisa_kev=False)
    with_kev_level, with_kev_score = _score(severity="medium", cisa_kev=True)
    assert without_kev_level in ("low", "medium")
    assert with_kev_level in ("critical", "emergency")
    assert with_kev_score - without_kev_score >= 100


def test_worst_case_signals_combine_to_emergency():
    level, _ = _score(
        severity="critical",
        cvss_score=9.8,
        cisa_kev=True,
        epss_score=0.9,
        fix_available=False,
        affected_host_criticalities=["critical"],
        affected_host_count=50,
    )
    assert level == "emergency"


def test_critical_severity_with_high_cvss_and_no_fix_outranks_high():
    high_level, high_score = _score(severity="high", cvss_score=7.5)
    critical_level, critical_score = _score(severity="critical", cvss_score=9.8, fix_available=False)
    assert critical_score > high_score


def test_higher_host_criticality_increases_score():
    _, low_crit_score = _score(affected_host_criticalities=["low"])
    _, high_crit_score = _score(affected_host_criticalities=["critical"])
    assert high_crit_score > low_crit_score


def test_affected_host_count_contribution_is_capped():
    _, score_at_cap = _score(affected_host_count=10)
    _, score_over_cap = _score(affected_host_count=1000)
    assert score_at_cap == score_over_cap


def test_fix_available_reduces_score_relative_to_no_fix():
    _, with_fix = _score(severity="high", fix_available=True)
    _, without_fix = _score(severity="high", fix_available=False)
    assert without_fix > with_fix


def test_unknown_severity_does_not_crash_and_stays_low():
    level, score = _score(severity="totally-made-up")
    assert level == "low"
    assert score > 0
