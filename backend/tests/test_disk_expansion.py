"""No real block devices, resizing, SSH or production credentials are used."""
import importlib.util
import json
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[2] / "ansible/playbooks/files/disk_expand.py"
SPEC = importlib.util.spec_from_file_location("disk_expand", PATH)
disk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(disk)
G = disk.GIB


@pytest.fixture
def current():
    return {
        "mount": "/data", "fstype": "xfs", "lv_path": "/dev/vg/data", "lv_uuid": "lv-id",
        "vg_name": "vg", "vg_uuid": "vg-id", "lv_bytes": 100 * G, "extent_bytes": 4 * 1024 ** 2,
        "vg_free_extents": 0, "pv_path": "/dev/sdc", "pv_uuid": "pv-id", "pv_bytes": 100 * G,
        "disk_path": "/dev/sdc", "disk_bytes": 101 * G, "disk_serial": "drive-scsi2",
        "partition": None, "partition_start_bytes": 0, "machine_uuid": "4cbab436-1b2e-4cba-a38e-db77ecf0b8e3",
        "fs_bytes": 99 * G,
    }


@pytest.fixture
def growth_request():
    return {"request_id": "growth_request-12345678", "mount": "/data", "add_gib": 10, "execute": True}


@pytest.mark.parametrize("change", [
    {"mount": "/data;rm"}, {"mount": "/data/../etc"}, {"mount": "/data/"},
    {"add_gib": 0}, {"add_gib": 1025}, {"add_gib": True}, {"add_gib": "10"},
    {"request_id": "../bad-path"}, {"execute": "true"},
])
def test_rejects_unbounded_or_shell_input(growth_request, change):
    with pytest.raises(disk.Refused):
        disk.checked_request({**growth_request, **change})


def test_default_is_fifty_gib_and_preview():
    assert disk.checked_request({"request_id": "growth_request-default"}) == {
        "request_id": "growth_request-default", "mount": "/data", "add_gib": 50}


def test_existing_vg_free_space_avoids_proxmox(current, growth_request):
    current["vg_free_extents"] = 20 * G // current["extent_bytes"]
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    assert plan["lv_target_bytes"] == 110 * G
    assert not plan["needs_proxmox"]
    assert not plan["needs_pv_growth"]
    assert plan["disk_target_bytes"] == current["disk_bytes"]


def test_uses_free_vg_extents_before_backing_growth(current, growth_request):
    current["vg_free_extents"] = 6 * G // current["extent_bytes"]
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    assert plan["lv_target_bytes"] == 110 * G
    assert plan["disk_target_bytes"] == 105 * G


def test_existing_unallocated_disk_tail_avoids_proxmox(current, growth_request):
    current["disk_bytes"] = 120 * G
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    assert plan["needs_pv_growth"]
    assert not plan["needs_proxmox"]
    assert plan["disk_target_bytes"] == 120 * G


def test_plan_rounds_extents_and_includes_gpt_tail(current, growth_request):
    current.update(partition=3, partition_start_bytes=2 * G)
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    assert plan["disk_target_bytes"] == 114 * G
    assert plan["lv_target_extents"] * current["extent_bytes"] == 110 * G


def test_request_journal_reuses_absolute_target(monkeypatch, tmp_path, current, growth_request):
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    monkeypatch.setattr(disk, "inspect_guest", lambda mount: current.copy())
    first = disk.guest_plan(growth_request)
    current["lv_bytes"] += 4 * G  # Interrupted after partial approved progress.
    current["disk_bytes"] = first["disk_target_bytes"]
    retry = disk.guest_plan(growth_request)
    assert retry["lv_target_bytes"] == first["lv_target_bytes"] == 110 * G
    assert retry["disk_target_bytes"] == first["disk_target_bytes"]
    with pytest.raises(disk.Refused, match="different mount or amount"):
        disk.guest_plan({**growth_request, "add_gib": 20})


def test_other_request_cannot_race_active_guest(monkeypatch, tmp_path, current, growth_request):
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    monkeypatch.setattr(disk, "inspect_guest", lambda mount: current.copy())
    disk.guest_plan(growth_request)
    with pytest.raises(disk.Refused, match="unfinished"):
        disk.guest_plan({**growth_request, "request_id": "another-growth_request"})


def test_preview_does_not_claim_or_write_targets(monkeypatch, tmp_path, current, growth_request):
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    monkeypatch.setattr(disk, "inspect_guest", lambda mount: current.copy())
    plan = disk.guest_plan({**growth_request, "execute": False})
    assert plan["lv_target_bytes"] == 110 * G
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("key", ["lv_uuid", "vg_uuid", "pv_uuid", "machine_uuid", "disk_serial", "mount"])
def test_changed_device_identity_is_rejected(current, growth_request, key):
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    with pytest.raises(disk.Refused, match="identity"):
        disk.verify_identity(plan, {**current, key: "different"})


def test_no_shrink_after_external_growth(current, growth_request):
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    with pytest.raises(disk.Refused, match="LV grew"):
        disk.verify_identity(plan, {**current, "lv_bytes": 200 * G})


def test_qemu_serial_maps_nonboot_disk_without_device_order(current):
    config = {
        "scsi0": "data:204/vm-204-disk-2.qcow2,size=300G",
        "scsi1": "data:204/vm-204-disk-1.qcow2,size=90G",
        "scsi2": "data:204/vm-204-disk-0.qcow2,size=250G",
    }
    assert disk.select_pve_disk(config, current)[:2] == ("scsi2", "data:204/vm-204-disk-0.qcow2")
    with pytest.raises(disk.Refused, match="exactly one"):
        disk.select_pve_disk({"scsi0": config["scsi0"]}, current)
    with pytest.raises(disk.Refused, match="no serial"):
        disk.select_pve_disk(config, {**current, "disk_serial": ""})


def test_duplicate_explicit_serials_are_ambiguous(current):
    config = {"scsi0": "data:one,serial=drive-scsi2", "scsi1": "data:two,serial=drive-scsi2"}
    with pytest.raises(disk.Refused, match="exactly one"):
        disk.select_pve_disk(config, current)


def test_storage_reserve_applies_to_actual_growth():
    result = disk.capacity_check(200 * G, 1000 * G, 50 * G, 10)
    assert result["reserve_bytes"] == 100 * G
    with pytest.raises(disk.Refused, match="reserve"):
        disk.capacity_check(149 * G, 1000 * G, 50 * G, 10)


def test_wrong_vm_uuid_fails_before_storage_access(monkeypatch, current, growth_request):
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    monkeypatch.setattr(disk, "require_tools", lambda names: None)
    def run(argv, **kwargs):
        if argv[0] == "hostname":
            return "pve-node"
        if argv[:2] == ["qm", "config"]:
            return "smbios1: uuid=11111111-1111-1111-1111-111111111111"
        pytest.fail("Unexpected command after wrong VM UUID: " + repr(argv))
    monkeypatch.setattr(disk, "run", run)
    with pytest.raises(disk.Refused, match="DMI UUID"):
        disk.inspect_pve({"vmid": 204}, plan)


def test_qcow2_uses_api_byte_units_and_real_free_space(monkeypatch, tmp_path):
    image = tmp_path / "vm-204-disk-0.qcow2"
    image.touch()
    monkeypatch.setattr(disk, "require_tools", lambda names: None)
    monkeypatch.setattr(disk, "run", lambda argv, **kwargs: "pve-node" if argv[0] == "hostname" else str(image))
    def command(argv):
        if argv[0] == "qemu-img":
            return {"format": "qcow2", "virtual-size": 100 * G}
        if argv[2].endswith("/status"):
            return {"active": 1, "avail": 200 * G, "total": 1000 * G, "type": "dir"}
        return [{"volid": "data:204/test.qcow2", "format": "qcow2", "vmid": 204, "parent": None}]
    monkeypatch.setattr(disk, "json_command", command)
    class Stats:
        f_bavail = 200 * G
        f_blocks = 1000 * G
        f_frsize = 1
    monkeypatch.setattr(disk.os, "statvfs", lambda path: Stats())
    monkeypatch.setattr(disk, "directory_images_capacity", lambda volumes: ([100 * G], [100 * G]))
    result = disk.pve_storage("data:204/test.qcow2", 204, 50 * G)
    assert result["logical"]["available_bytes"] == 200 * G
    assert result["physical"]["available_bytes"] == 200 * G
    assert result["size_bytes"] == 100 * G


@pytest.mark.parametrize("unsupported", [
    {"backing-filename": "/old/base.qcow2"}, {"snapshots": [{"id": "1"}]},
    {"format-specific": {"data": {"data-file": "/another/storage.raw"}}},
])
def test_qcow2_backing_chains_and_snapshots_are_rejected(monkeypatch, tmp_path, unsupported):
    image = tmp_path / "disk.qcow2"
    image.touch()
    monkeypatch.setattr(disk, "require_tools", lambda names: None)
    monkeypatch.setattr(disk, "run", lambda argv, **kwargs: "pve-node" if argv[0] == "hostname" else str(image))
    def command(argv):
        if argv[0] == "qemu-img":
            return {"format": "qcow2", "virtual-size": 100 * G, **unsupported}
        if argv[2].endswith("/status"):
            return {"active": 1, "avail": 200 * G, "total": 1000 * G, "type": "dir"}
        return [{"volid": "data:204/disk.qcow2", "format": "qcow2"}]
    monkeypatch.setattr(disk, "json_command", command)
    with pytest.raises(disk.Refused, match="Backing chains"):
        disk.pve_storage("data:204/disk.qcow2", 204, 10 * G)


def test_guest_apply_resumes_filesystem_without_readding_growth(monkeypatch, tmp_path, current, growth_request):
    current["vg_free_extents"] = 20 * G // current["extent_bytes"]
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    monkeypatch.setattr(disk, "inspect_guest", lambda mount: current.copy())
    plan = disk.guest_plan(growth_request)
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        if argv[0] == "lvextend":
            assert argv == ["lvextend", "--yes", "--extents", str(plan["lv_target_extents"]), "/dev/vg/data"]
            current["lv_bytes"] = plan["lv_target_bytes"]
        if argv[0] == "xfs_growfs":
            current["fs_bytes"] = 109 * G
        return ""
    monkeypatch.setattr(disk, "run", run)
    first = disk.guest_apply(growth_request)
    assert first["completed"] and first["changed"]
    second = disk.guest_apply(growth_request)
    assert not second["changed"]
    assert len([c for c in calls if c[0] == "lvextend"]) == 1
    assert disk.read_state("active-guest.json") == {}


def test_pve_apply_uses_absolute_target_and_rechecks_capacity(monkeypatch, tmp_path, current, growth_request):
    guest = disk.calculate_plan(disk.checked_request(growth_request), current)
    state = {
        "vmid": 204, "node": "pve-node", "disk": "scsi2", "volume": "data:204/disk.qcow2",
        "serial": current["disk_serial"], "target_bytes": guest["disk_target_bytes"],
        "guest_plan": guest, "completed": False,
    }
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    disk.atomic_json(tmp_path / disk.journal_path("pve", growth_request["request_id"]), state)
    size = current["disk_bytes"]
    calls = []
    def inspect(req, plan):
        return {**state, "capacity": {"size_bytes": size}}
    def capacity(volume, vmid, growth, **kwargs):
        calls.append(("capacity", growth))
        return {"size_bytes": size}
    def run(argv, **kwargs):
        nonlocal size
        calls.append(argv)
        assert argv == ["qm", "resize", "204", "scsi2", str(guest["disk_target_bytes"] // G) + "G"]
        size = guest["disk_target_bytes"]
        return ""
    monkeypatch.setattr(disk, "inspect_pve", inspect)
    monkeypatch.setattr(disk, "pve_storage", capacity)
    monkeypatch.setattr(disk, "run", run)
    first = disk.pve_apply({"execute": True, "guest_plan": guest, "vmid": 204})
    second = disk.pve_apply({"execute": True, "guest_plan": guest, "vmid": 204})
    assert first["changed"] and not second["changed"]
    assert len([call for call in calls if isinstance(call, list) and call[0] == "qm"]) == 1
    assert calls[0] == ("capacity", guest["disk_target_bytes"] - current["disk_bytes"])


def test_missing_approval_never_runs_mutation(monkeypatch, growth_request):
    monkeypatch.setattr(disk, "run", lambda *args, **kwargs: pytest.fail("Mutation attempted"))
    with pytest.raises(disk.Refused, match="execute"):
        disk.guest_apply({**growth_request, "execute": False})
    with pytest.raises(disk.Refused, match="execute"):
        disk.pve_apply({"guest_plan": growth_request, "execute": False})


@pytest.mark.parametrize("execute,check_mode,completed,expected", [
    (False, False, False, ["guest-plan", "pve-plan"]),
    (True, True, False, ["guest-plan", "pve-plan"]),
    (True, False, False, ["guest-plan", "pve-plan", "pve-apply", "guest-apply"]),
    (True, False, True, ["guest-plan", "guest-apply"]),
    (False, False, "fail-capacity", ["guest-plan", "pve-plan"]),
])
def test_ansible_one_job_orchestration_uses_only_mock_helpers(tmp_path, execute, check_mode, completed, expected):
    """Exercise real Ansible templating/delegation without real helper commands."""
    import os
    import shutil
    import subprocess
    import sys

    binary = os.environ.get("OPS_TEST_ANSIBLE_PLAYBOOK") or shutil.which("ansible-playbook")
    if not binary:
        pytest.skip("Install ansible-core or set OPS_TEST_ANSIBLE_PLAYBOOK for orchestration tests")
    playdir = tmp_path / "playbooks"
    (playdir / "files").mkdir(parents=True)
    shutil.copyfile(PATH.parent.parent / "disk-expand.yml", playdir / "disk-expand.yml")
    calls = tmp_path / "calls.jsonl"
    failure = completed == "fail-capacity"
    completed = completed is True
    stub = (
        "import json,sys\n"
        "request=json.load(sys.stdin)\n"
        "mode=sys.argv[1]\n"
        "with open(" + repr(str(calls)) + ",'a') as output:\n"
        " output.write(json.dumps({'mode':mode,'request':request})+'\\n')\n"
        "if mode == 'guest-plan':\n"
        " assert type(request['add_gib']) is int\n"
        " assert type(request['execute']) is bool\n"
        " print(json.dumps({'needs_proxmox':True,'completed':" + repr(completed) + "}))\n"
        "else:\n"
        " print(json.dumps({'changed':True,'completed':True}))\n"
    )
    if failure:
        stub = stub.replace("if mode == 'guest-plan':", "if mode == 'pve-plan':\n print(json.dumps({'error':'Storage lacks provisioned capacity reserve'}),file=sys.stderr)\n sys.exit(1)\nif mode == 'guest-plan':")
    (playdir / "files/disk_expand.py").write_text(stub)
    inventory = {
        "all": {"hosts": {
            name: {"ansible_connection": "local", "ansible_become": False,
                   "ansible_python_interpreter": sys.executable}
            for name in ("test-guest", "test-pve")
        }}
    }
    inv = tmp_path / "inventory.json"
    inv.write_text(json.dumps(inventory))
    cfg = tmp_path / "ansible.cfg"
    cfg.write_text("[defaults]\nretry_files_enabled=False\nhost_key_checking=True\n"
                   "local_tmp=" + str(tmp_path / "ansible-local") + "\n"
                   "remote_tmp=" + str(tmp_path / "ansible-remote") + "\n")
    variables = {
        "disk_target_host": "test-guest", "disk_request_id": "test-orchestration-123",
        "disk_add_gib": 10, "disk_mount": "/data", "disk_execute": execute,
        "disk_proxmox_host": "test-pve", "disk_proxmox_vmid": 204,
    }
    argv = [str(binary), str(playdir / "disk-expand.yml"), "-i", str(inv), "-e", json.dumps(variables)]
    if check_mode:
        argv.append("--check")
    result = subprocess.run(argv, text=True, capture_output=True, timeout=90,
                            env={**os.environ, "ANSIBLE_CONFIG": str(cfg)})
    if failure:
        assert result.returncode != 0
        assert "Storage lacks provisioned capacity reserve" in result.stdout
        assert "Emit structured failure" in result.stdout
    else:
        assert result.returncode == 0, result.stdout + result.stderr
    rows = [json.loads(line) for line in calls.read_text().splitlines()]
    assert [row["mode"] for row in rows] == expected
    assert rows[0]["request"]["execute"] is (execute and not check_mode)
    assert "OPS_CENTER_QUERY_RESULT:" in result.stdout


def test_aggregate_commitment_rejects_second_competing_thin_expansion():
    first = disk.provisioned_capacity_check(200 * G, 1000 * G, 50 * G, [100 * G], [90 * G])
    assert first["unallocated_commitment_bytes"] == 10 * G
    # First virtual resize has not allocated data yet; df still shows the same free bytes.
    # Counting its new virtual target prevents a second job spending those bytes again.
    with pytest.raises(disk.Refused, match="reserve"):
        disk.provisioned_capacity_check(200 * G, 1000 * G, 50 * G, [150 * G], [90 * G])


def test_aggregate_capacity_refuses_existing_overcommit():
    with pytest.raises(disk.Refused, match="reserve"):
        disk.provisioned_capacity_check(500 * G, 1000 * G, G, [1500 * G], [400 * G])
    with pytest.raises(disk.Refused, match="enumeration"):
        disk.provisioned_capacity_check(500 * G, 1000 * G, G, [], [])


def test_directory_enumeration_rejects_inconsistent_virtual_size(monkeypatch, tmp_path):
    image = tmp_path / "disk.qcow2"
    image.touch()
    monkeypatch.setattr(disk, "run", lambda argv: str(image))
    monkeypatch.setattr(disk, "json_command", lambda argv: {"format": "qcow2", "virtual-size": 101 * G})
    volumes = [{"content": "images", "format": "qcow2", "volid": "data:204/disk.qcow2", "size": 100 * G}]
    with pytest.raises(disk.Refused, match="inconsistent"):
        disk.directory_images_capacity(volumes)


def test_directory_enumeration_counts_other_vms_and_rejects_unsupported_images(monkeypatch, tmp_path):
    images = []
    for vmid in (204, 205):
        path = tmp_path / (str(vmid) + ".qcow2")
        path.write_bytes(b"x" * 4096)
        images.append({"content": "images", "format": "qcow2", "volid": str(path), "size": 100 * G})
    monkeypatch.setattr(disk, "run", lambda argv: argv[-1])
    monkeypatch.setattr(disk, "json_command", lambda argv: {"format": "qcow2", "virtual-size": 100 * G})
    sizes, allocated = disk.directory_images_capacity(images)
    assert sizes == [100 * G, 100 * G]
    assert len(allocated) == 2 and all(n > 0 for n in allocated)
    with pytest.raises(disk.Refused, match="unsupported"):
        disk.directory_images_capacity(images + [{"content": "images", "format": "vmdk"}])


def test_partial_filesystem_growth_cannot_report_completed(current, growth_request):
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    with pytest.raises(disk.Refused, match="95%"):
        disk.verify_filesystem_capacity(plan, {**current, "lv_bytes": plan["lv_target_bytes"],
                                              "fs_bytes": current["fs_bytes"] + G})
    disk.verify_filesystem_capacity(plan, {**current, "lv_bytes": plan["lv_target_bytes"],
                                         "fs_bytes": current["fs_bytes"] + 10 * G})


def test_completed_retry_rejects_filesystem_capacity_regression(monkeypatch, tmp_path, current, growth_request):
    plan = disk.calculate_plan(disk.checked_request(growth_request), current)
    plan.update(completed=True, verified_fs_bytes=current["fs_bytes"] + 10 * G)
    monkeypatch.setattr(disk, "STATE_ROOT", tmp_path)
    disk.atomic_json(tmp_path / disk.journal_path("guest", growth_request["request_id"]), plan)
    now = {**current, "lv_bytes": plan["lv_target_bytes"], "disk_bytes": plan["disk_target_bytes"],
           "fs_bytes": plan["verified_fs_bytes"] - G // 4}
    monkeypatch.setattr(disk, "inspect_guest", lambda mount: now)
    with pytest.raises(disk.Refused, match="smaller"):
        disk.guest_apply(growth_request)
