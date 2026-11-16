"""Ask Ops AI page context: identifiers only, visible in the question, never a credential."""
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes.ai import ASK_CONTEXT_MARK, _context_block
from app.schemas.ai import AskContext, AskWithContextRequest


def test_context_is_appended_as_a_marked_block():
    ctx = AskContext(page="AI Traffic Monitor", path="/ai-traffic/live?status=blocked",
                     items=[{"label": "View", "value": "Live Traffic"}])
    block = _context_block(ctx)
    assert block.startswith(ASK_CONTEXT_MARK)
    assert "Page: AI Traffic Monitor (/ai-traffic/live?status=blocked)" in block and "- View: Live Traffic" in block
    assert _context_block(None) == ""


def test_context_that_looks_like_a_secret_is_refused():
    ctx = AskContext(page="Logs", path="/logs", items=[{"label": "Search", "value": "password=hunter2hunter2"}])
    with pytest.raises(HTTPException) as err:
        _context_block(ctx)
    assert err.value.status_code == 422


def test_context_is_bounded():
    with pytest.raises(ValidationError):
        AskContext(page="x", path="/x", items=[{"label": "a", "value": "b"}] * 13)
    with pytest.raises(ValidationError):
        AskContext(page="x", path="no-leading-slash")
    assert AskWithContextRequest(message="hi").context is None
