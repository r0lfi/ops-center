"""CVE search treats the user's text as literal text, never as a LIKE pattern."""

from app.api.routes.security import escape_like


def test_wildcards_are_escaped():
    assert escape_like("100%") == "100\\%"
    assert escape_like("a_b") == "a\\_b"
    assert escape_like("a\\b") == "a\\\\b"


def test_a_cve_id_is_unchanged():
    assert escape_like("CVE-2026-0001") == "CVE-2026-0001"
