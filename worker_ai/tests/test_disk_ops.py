import uuid
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch
import pytest
from app.core.disk_expansion import validate_disk_arguments
from worker_ai.disk_ops import prepare_disk_arguments, validate_disk_scope, host_binding, execute_expand_disk
from worker_ai.ai.tools.exec_tools import TOOL_APPROVAL_LEVEL, TOOL_RISK, EXPAND_DISK_SCHEMA
from worker_ai.ai.tools import TOOL_REGISTRY, TOOL_SCHEMAS

def host(name):
    return NS(hostname=name,id=uuid.uuid4(),ip_address="192.0.2.1",ssh_port=22,ssh_user="ansible",
              credential_id=uuid.uuid4(),environment="production")

def test_disk_tool_is_high_risk_schema_only_and_default_increment_is_bounded():
    assert "expand_disk" not in TOOL_REGISTRY
    assert TOOL_SCHEMAS["expand_disk"] == EXPAND_DISK_SCHEMA
    assert TOOL_APPROVAL_LEVEL["expand_disk"] == 3 and TOOL_RISK["expand_disk"] == "high"
    assert validate_disk_arguments({"hostname":"guest"}) == {"hostname":"guest","mount":"/data","add_gib":50}

@pytest.mark.parametrize("override", [
    {"add_gib":True},{"add_gib":"10"},{"add_gib":0},{"add_gib":-10},{"add_gib":1025},
    {"hostname":"all:*"},{"hostname":"guest;id"},{"mount":"/data/../etc"},{"mount":"/data/"},
    {"mount":"/data;id"},{"proxmox_host":"pve"},{"vmid":204},{"proxmox_host":"guest","vmid":204},
    {"proxmox_host":"pve","vmid":True},{"disk_execute":True},{"_action_id":str(uuid.uuid4())},
])
def test_untrusted_arguments_cannot_expand_scope(override):
    with pytest.raises(ValueError):
        validate_disk_arguments({"hostname":"guest",**override})

def test_preparation_checks_both_hosts_and_pins_managed_identity():
    guest,pve=host("guest"),host("pve")
    db=Mock()
    db.execute.return_value.scalar_one_or_none.side_effect=[guest,pve]
    with patch("worker_ai.ai.runtime._check_host_allowed",return_value=None) as allowed:
        result=prepare_disk_arguments(db,NS(),{"hostname":"guest","proxmox_host":"pve","vmid":204,"add_gib":10})
    assert [c.args[2] for c in allowed.call_args_list] == ["guest","pve"]
    assert result["_disk_hosts"] == {"guest":host_binding(guest),"pve":host_binding(pve)}

def test_proxmox_scope_denial_prevents_an_action():
    db=Mock()
    db.execute.return_value.scalar_one_or_none.return_value=host("guest")
    with patch("worker_ai.ai.runtime._check_host_allowed",side_effect=[None,"PVE not permitted"]):
        with pytest.raises(ValueError,match="PVE not permitted"):
            prepare_disk_arguments(db,NS(),{"hostname":"guest","proxmox_host":"pve","vmid":204})

def test_managed_identity_is_rechecked_after_approval():
    guest=host("guest")
    args={"hostname":"guest","mount":"/data","add_gib":50,"_disk_hosts":{"guest":host_binding(guest)}}
    guest.ip_address="192.0.2.99"
    db=Mock();db.execute.return_value.scalar_one_or_none.return_value=guest
    with patch("worker_ai.ai.runtime._check_host_allowed",return_value=None):
        with pytest.raises(ValueError,match="identity changed"):
            validate_disk_scope(db,NS(),args)

@pytest.mark.parametrize("status,completed,ok",[("successful",True,True),("successful",False,False),("failed",True,False)])
def test_existing_job_is_not_requeued_and_success_requires_filesystem_verification(status,completed,ok):
    guest=host("guest");request=str(uuid.uuid4())
    args={"hostname":"guest","mount":"/data","add_gib":50,"_action_id":request,
          "_disk_hosts":{"guest":host_binding(guest)}}
    job=NS(status=status,playbook="disk-expand.yml",
        extra_vars={"disk_target_host":"guest","disk_mount":"/data","disk_add_gib":50,
                    "disk_request_id":request,"disk_execute":True},
        result_payload={"disk_expansion":{"completed":completed}})
    db=Mock();db.execute.return_value.scalar_one_or_none.return_value=guest;db.get.return_value=job
    with patch("worker_ai.disk_ops.SessionLocal") as session, patch("worker_ai.disk_ops.get_celery_client") as celery:
        session.return_value.__enter__.return_value=db
        result=execute_expand_disk(args)
    assert result["available"] is ok and result["job_id"]==request
    celery.assert_not_called()
    db.add.assert_not_called()
