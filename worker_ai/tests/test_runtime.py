from worker_ai.ai.runtime import DISPATCH_TOOL_NAME, _dispatch_schema


def test_dispatch_schema_lists_available_agents_and_names_the_tool():
    schema = _dispatch_schema(["linux", "monitoring"])
    assert schema["name"] == DISPATCH_TOOL_NAME
    assert schema["parameters"]["properties"]["agent"]["enum"] == ["linux", "monitoring"]
    assert "linux" in schema["description"] and "monitoring" in schema["description"]


def test_dispatch_schema_handles_no_available_agents():
    schema = _dispatch_schema([])
    assert schema["parameters"]["properties"]["agent"]["enum"] == []
    assert "none enabled" in schema["description"]
