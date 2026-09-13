"""Contract checks keep MCP exposure explicit when REST APIs evolve."""

import json
from jsonschema import Draft202012Validator
from app.mcp.catalog import CATALOG, TOOLS
from app.main import app


def resolve(value, spec):
    if isinstance(value, dict):
        if "$ref" in value:
            target = spec
            for part in value["$ref"].removeprefix("#/").split("/"):
                target = target[part]
            return resolve(target, spec)
        return {k: resolve(v, spec) for k, v in value.items()}
    return [resolve(v, spec) for v in value] if isinstance(value, list) else value


def test_every_rest_operation_is_reviewed_or_explicitly_excluded():
    exposed = {t["method"] + " " + t["path"] for t in TOOLS.values()}
    excluded = set(CATALOG["excluded"])
    actual = {
        method.upper() + " " + path
        for path, ops in app.openapi()["paths"].items()
        if not path.startswith("/api/mcp/")
        for method in ops
        if method in ("get", "post", "put", "patch", "delete")
    }
    assert not (exposed & excluded)
    assert (
        exposed | excluded == actual
    ), "Review new/changed routes before updating the static MCP catalog"


def test_tool_schemas_match_rest_contracts_and_reject_unknown_arguments():
    spec = app.openapi()
    for tool in TOOLS.values():
        schema = tool["input_schema"]
        Draft202012Validator.check_schema(schema)
        assert schema["additionalProperties"] is False
        op = spec["paths"][tool["path"]][tool["method"].lower()]
        for loc in ("path", "query"):
            expected = {
                p["name"]: resolve(p["schema"], spec)
                for p in op.get("parameters", [])
                if p["in"] == loc
            }
            actual = schema["properties"].get(loc, {}).get("properties", {})
            assert actual == expected, tool["name"]
        if "requestBody" in op:
            assert schema["properties"]["body"] == resolve(
                op["requestBody"]["content"]["application/json"]["schema"], spec
            )
        if tool["method"] != "GET":
            assert "idempotency_key" in schema["required"]
            assert tool["minimum_role"] in ("operator", "admin")
