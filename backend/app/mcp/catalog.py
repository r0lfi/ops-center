"""A reviewed catalog: new REST routes never become tools automatically."""

import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from fastapi import HTTPException
from app.services.auth import role_at_least

CATALOG = json.loads((Path(__file__).parents[1] / "core/mcp_catalog.json").read_text())
TOOLS = {t["name"]: t for t in CATALOG["tools"]}
SCOPES = sorted({"ops:connect", *(t["scope"] for t in TOOLS.values())})


def permitted(tool, grant, client, user, scopes):
    return (
        tool["name"] in grant.allowed_tools
        and tool["name"] in client.allowed_tools
        and tool["scope"] in set(scopes) & set(grant.scopes) & set(client.scopes)
        and role_at_least(user.role, tool["minimum_role"])
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
