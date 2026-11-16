"""Self-hosted pricing, client pre-approval and external agent contracts."""
from decimal import Decimal
from types import SimpleNamespace as NS

from app.core.ai_pricing import rates
from app.mcp.catalog import AUTO_APPROVABLE, TOOLS, auto_approved
from app.models.ai import AI_PROVIDER_KINDS


def test_self_hosted_openai_compatible_endpoints_cost_nothing():
    assert "openai_compatible" in AI_PROVIDER_KINDS
    assert rates("openai_compatible", "any-model", "https://llm.example.lan/v1") == (Decimal(0), Decimal(0))
    assert rates("openai_compatible", "any-model", "https://llm.example.lan/v1", ceiling=True) == (Decimal(0), Decimal(0))


def test_pre_approvable_tools_are_existing_low_risk_writes():
    assert AUTO_APPROVABLE <= TOOLS.keys()
    assert all(TOOLS[name]["method"] != "GET" for name in AUTO_APPROVABLE)
    assert all(TOOLS[name]["scope"] == "ops:ai:write" for name in AUTO_APPROVABLE)


def _client(auto, allowed=None):
    return NS(auto_approve_tools=auto, allowed_tools=allowed if allowed is not None else list(TOOLS))


def test_pre_approval_requires_admin_selection_and_never_applies_to_agent_grants():
    ask = TOOLS["ops_ask_ops_ai"]
    external = NS(agent_id=None)
    assert auto_approved(ask, external, _client(["ops_ask_ops_ai"]))
    assert not auto_approved(ask, external, _client([]))
    assert not auto_approved(ask, external, _client(["ops_ask_ops_ai"], allowed=[]))
    assert not auto_approved(ask, NS(agent_id="agent"), _client(["ops_ask_ops_ai"]))
    # Infrastructure writes can never be pre-approved, even if stored.
    restart = TOOLS["ops_restart_container"]
    assert not auto_approved(restart, external, _client(["ops_restart_container"]))


def test_report_route_and_runtime_field_are_in_the_rest_contract():
    from app.main import app
    spec = app.openapi()
    assert "post" in spec["paths"]["/api/ai/agents/{agent_id}/report"]
    create = spec["components"]["schemas"]["AIAgentCreate"]["properties"]["runtime"]
    assert create["enum"] == ["native", "external"] and create["default"] == "native"
    report = spec["components"]["schemas"]["AgentStatusReport"]
    assert report["additionalProperties"] is False
    assert set(report["properties"]["status"]["enum"]) == {"idle", "working", "error"}
