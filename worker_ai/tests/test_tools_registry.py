from worker_ai.ai.tools import TOOL_REGISTRY, TOOL_SCHEMAS, schemas_for
from worker_ai.ai.tools.exec_tools import TOOL_APPROVAL_LEVEL


def test_every_registered_tool_has_a_schema():
    # Not equality: write/execute tools are schema-only (see
    # test_write_tools_are_schema_only_not_directly_callable below).
    assert set(TOOL_REGISTRY.keys()) <= set(TOOL_SCHEMAS.keys())


def test_every_schema_name_matches_its_key():
    for key, schema in TOOL_SCHEMAS.items():
        assert schema["name"] == key


def test_write_tools_are_schema_only_not_directly_callable():
    # restart_service/run_ansible_job/reboot_host must never be callable
    # via TOOL_REGISTRY - runtime.py special-cases them (via
    # TOOL_APPROVAL_LEVEL) into a pending-approval request instead of
    # ever executing anything from an agent's own tool-call.
    for tool_name in TOOL_APPROVAL_LEVEL:
        assert tool_name in TOOL_SCHEMAS
        assert tool_name not in TOOL_REGISTRY


def test_schemas_for_filters_and_preserves_order():
    names = ["get_disk_usage", "get_server_metrics", "not_a_real_tool"]
    result = schemas_for(names)
    assert [s["name"] for s in result] == ["get_disk_usage", "get_server_metrics"]


def test_schemas_for_empty_list():
    assert schemas_for([]) == []
