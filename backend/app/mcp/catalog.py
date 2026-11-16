"""A reviewed catalog: new REST routes never become tools automatically."""

import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from fastapi import HTTPException
from app.services.auth import role_at_least

CATALOG = json.loads((Path(__file__).parents[1] / "core/mcp_catalog.json").read_text())
TOOLS = {t["name"]: t for t in CATALOG["tools"]}
SCOPES = sorted({"ops:connect", *(t["scope"] for t in TOOLS.values())})

# The only writes an administrator may pre-approve for one external client.
# They start or stop agent work whose own changes still need a human AIAction
# approval, or report an external agent's state. Never add tools that change
# infrastructure, credentials, access or configuration directly.
AUTO_APPROVABLE = frozenset({"ops_ask_ops_ai", "ops_cancel_task", "ops_report_agent_status"})


def permitted(tool, grant, client, user, scopes):
    return (
        tool["name"] in grant.allowed_tools
        and tool["name"] in client.allowed_tools
        and tool["scope"] in set(scopes) & set(grant.scopes) & set(client.scopes)
        and role_at_least(user.role, tool["minimum_role"])
    )


def auto_approved(tool, grant, client):
    """True when this external client's administrator pre-approved the tool."""
    return (
        not grant.agent_id
        and tool["method"] != "GET"
        and tool["name"] in AUTO_APPROVABLE
        and tool["name"] in (client.auto_approve_tools or [])
        and tool["name"] in client.allowed_tools
    )


def validate(tool, arguments):
    if not isinstance(arguments, dict):
        raise HTTPException(400, "Tool arguments must be an object")
    errors = Draft202012Validator(
        tool["input_schema"], format_checker=FormatChecker()
    ).iter_errors(arguments)
    if next(errors, None):
        # Validation text can contain sensitive arguments; do not echo it.
        raise HTTPException(400, "Arguments do not match the tool schema")
