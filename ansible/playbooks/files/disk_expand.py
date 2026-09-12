#!/usr/bin/env python3
"""Bounded grow-only disk workflow. Run as root via disk-expand.yml, never shell input.

All commands use argv. Request journals contain absolute targets and device UUIDs,
not credentials. An interrupted request must resume with its original request ID.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

GIB = 1024 ** 3
STATE_ROOT = Path("/var/lib/ops-center/disk-expansion")
REQUEST_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$")
MOUNT_RE = re.compile(r"^/(?:[a-zA-Z0-9._-]+(?:/[a-zA-Z0-9._-]+)*)?$")
DISK_RE = re.compile(r"^(?:scsi|virtio|sata)\d+$")


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def run(argv, timeout=60):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    require(result.returncode == 0,
            "Command failed: " + argv[0] + ": " + result.stderr.strip()[:800])
    return result.stdout.strip()


def json_command(argv):
    return json.loads(run(argv))


def number(value):
    return int(float(str(value).strip().lstrip("<")))


def report(tool, columns):
    result = json_command([tool, "--reportformat", "json", "--units", "b", "--nosuffix", "-o", columns])
    return result["report"][0][{"lvs": "lv", "vgs": "vg", "pvs": "pv"}[tool]]


def checked_request(request):
    require(isinstance(request.get("request_id"), str) and REQUEST_RE.fullmatch(request["request_id"]),
            "A stable request ID of 8-80 safe characters is required")
    mount = request.get("mount", "/data")
    require(isinstance(mount, str) and MOUNT_RE.fullmatch(mount) and
            ".." not in mount.split("/") and "." not in mount.split("/"),
            "Mount must be an exact, absolute mounted path without traversal or shell syntax")
    amount = request.get("add_gib", 50)
    require(type(amount) is int and 1 <= amount <= 1024, "add_gib must be an integer between 1 and 1024")
    require(type(request.get("execute", False)) is bool, "execute must be a boolean")
    return {"request_id": request["request_id"], "mount": mount, "add_gib": amount}


def atomic_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".state-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        directory_fd = os.open(str(path.parent), os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_state(name):
    path = STATE_ROOT / name
    return json.loads(path.read_text()) if path.exists() else None


def journal_path(role, request_id):
    return role + "-" + request_id + ".json"


def claim_guest(plan):
    active = read_state("active-guest.json")
    require(not active or active.get("request_id") == plan["request_id"],
            "Another disk request is unfinished; resume its original request ID before starting another")
    atomic_json(STATE_ROOT / "active-guest.json", {"request_id": plan["request_id"]})
    atomic_json(STATE_ROOT / journal_path("guest", plan["request_id"]), plan)


def require_tools(names):
    missing = [name for name in names if not shutil.which(name)]
    require(not missing, "Required tools must be installed before approval: " + ", ".join(missing))


def flatten_blocks(items):
    result = []
    for item in items:
        result.append(item)
        result.extend(flatten_blocks(item.get("children", [])))
    return result


def inspect_guest(mount):
    require_tools(["findmnt", "lvs", "vgs", "pvs", "lsblk", "blockdev", "lvextend", "pvresize"])
    mounts = json_command(["findmnt", "--json", "--target", mount, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS"])["filesystems"]
    require(len(mounts) == 1 and mounts[0]["target"] == mount, "Path must be an exact mount point")
    fs = mounts[0]
    require(fs["fstype"] in ("ext4", "xfs"), "Only mounted ext4 and XFS filesystems are supported")
    require("rw" in fs["options"].split(","), "Filesystem must be mounted read/write")
    require_tools(["resize2fs" if fs["fstype"] == "ext4" else "xfs_growfs"])
    source = os.path.realpath(fs["source"])
    lvs = report("lvs", "lv_path,lv_uuid,vg_name,lv_size,segtype,lv_attr,pool_lv,origin")
    matches = [lv for lv in lvs if os.path.realpath(lv["lv_path"].strip()) == source]
    require(len(matches) == 1, "Mount source must map to one ordinary LVM logical volume")
    lv = matches[0]
    require(lv["segtype"].strip() == "linear" and not lv["pool_lv"].strip() and
            not lv["origin"].strip() and lv["lv_attr"].strip().startswith("-"),
            "Thin, snapshot, RAID, cached, mirrored and encrypted logical volumes are unsupported")
    vg_name = lv["vg_name"].strip()
    require(not any(row["vg_name"].strip() == vg_name and
                    (row["origin"].strip() or row["pool_lv"].strip() or row["segtype"].strip() != "linear")
                    for row in lvs), "VG contains snapshots or non-linear volumes")
    vgs = [vg for vg in report("vgs", "vg_name,vg_uuid,vg_size,vg_free,vg_extent_size,vg_free_count")
           if vg["vg_name"].strip() == vg_name]
    pvs = [pv for pv in report("pvs", "pv_name,pv_uuid,vg_name,pv_size")
           if pv["vg_name"].strip() == vg_name]
    require(len(vgs) == 1 and len(pvs) == 1, "Only a VG with exactly one physical volume is supported")
    vg, pv = vgs[0], pvs[0]
    pv_path = os.path.realpath(pv["pv_name"].strip())
    blocks = flatten_blocks(json_command(["lsblk", "--json", "--bytes", "--paths", "--output",
                                          "NAME,TYPE,SIZE,PKNAME,SERIAL,PTTYPE"])["blockdevices"])
    matches = [b for b in blocks if os.path.realpath(b["name"]) == pv_path]
    require(len(matches) == 1, "PV must map unambiguously to a single block device")
    block = matches[0]
    require(block["type"] in ("part", "disk"), "PV must be a plain disk or partition; encrypted/RAID/multipath stacks are unsupported")
    disk = block
    partition = None
    partition_start = 0
    if block["type"] == "part":
        parent = block.get("pkname")
        parent = parent if parent and parent.startswith("/") else "/dev/" + str(parent)
        disks = [b for b in blocks if os.path.realpath(b["name"]) == os.path.realpath(parent)]
        require(len(disks) == 1 and disks[0]["type"] == "disk", "PV parent must be a plain disk")
        disk = disks[0]
        require_tools(["sfdisk", "growpart"])
        table = json_command(["sfdisk", "--json", disk["name"]])["partitiontable"]
        require(table["label"] == "gpt" and table.get("unit") == "sectors",
                "Only GPT partitions are supported")
        parts = table["partitions"]
        current = [p for p in parts if os.path.realpath(p["node"]) == pv_path]
        require(len(current) == 1 and current[0]["type"].upper() == "E6D6D379-F507-44C2-A23C-238F2A3DF928",
                "PV partition must have the Linux LVM GPT type")
        selected = current[0]
        ranges = sorted((int(p["start"]), int(p["start"]) + int(p["size"])) for p in parts)
        require(all(start > 0 and end > start for start, end in ranges) and
                all(ranges[i][1] <= ranges[i + 1][0] for i in range(len(ranges) - 1)),
                "Invalid or overlapping GPT partitions")
        require(all(p["start"] <= selected["start"] for p in parts),
                "LVM PV must be the last partition on its disk")
        partition = int((Path("/sys/class/block") / Path(pv_path).name / "partition").read_text())
        partition_start = int(selected["start"]) * int(table.get("sectorsize", 512))
    disk_path = os.path.realpath(disk["name"])
    require(re.fullmatch(r"/dev/(?:sd[a-z]+|vd[a-z]+|nvme\d+n\d+)", disk_path),
            "Unsupported disk path")
    fs_stats = os.statvfs(mount)
    return {
        "mount": mount, "fstype": fs["fstype"], "lv_path": lv["lv_path"].strip(),
        "lv_uuid": lv["lv_uuid"].strip(), "vg_name": vg_name, "vg_uuid": vg["vg_uuid"].strip(),
        "lv_bytes": number(lv["lv_size"]), "extent_bytes": number(vg["vg_extent_size"]),
        "vg_free_extents": number(vg["vg_free_count"]), "pv_path": pv_path,
        "pv_uuid": pv["pv_uuid"].strip(), "pv_bytes": number(pv["pv_size"]),
        "disk_path": disk_path, "disk_bytes": number(disk["size"]),
        "disk_serial": (disk.get("serial") or "").strip(), "partition": partition,
        "machine_uuid": (Path("/sys/class/dmi/id/product_uuid").read_text().strip().lower()
                         if Path("/sys/class/dmi/id/product_uuid").exists() else ""),
        "partition_start_bytes": partition_start, "fs_bytes": fs_stats.f_blocks * fs_stats.f_frsize,
    }


IDENTITY_KEYS = ("mount", "fstype", "lv_uuid", "vg_uuid", "pv_uuid", "disk_serial", "partition", "machine_uuid")


def verify_identity(plan, current):
    require(all(plan[key] == current[key] for key in IDENTITY_KEYS),
            "Mount/device identity changed since planning; refusing to resize")
    require(current["lv_bytes"] <= plan["lv_target_bytes"], "LV grew beyond this request target; manual review required")
    require(current["disk_bytes"] <= plan["disk_target_bytes"], "Disk grew beyond this request target; manual review required")


def verify_filesystem_capacity(plan, current, completed=False):
    growth = plan["lv_target_bytes"] - plan["lv_bytes"]
    # LVM gains the exact requested extent count. Filesystem metadata may consume
    # some of it, but success must not hide a partial filesystem resize.
    minimum = plan["fs_bytes"] + (growth * 95 + 99) // 100
    require(minimum <= current["fs_bytes"] <= plan["lv_target_bytes"],
            "Filesystem did not gain at least 95% of the planned LV growth")
    if completed:
        require(current["fs_bytes"] >= plan["verified_fs_bytes"],
                "Completed filesystem capacity is smaller than its verified result")


def calculate_plan(request, current):
    wanted = request["add_gib"] * GIB
    extent = current["extent_bytes"]
    require(extent > 0 and current["lv_bytes"] % extent == 0, "Invalid LVM extent geometry")
    add_extents = (wanted + extent - 1) // extent
    missing = max(0, add_extents - current["vg_free_extents"]) * extent
    # Leave one GiB for PV alignment/metadata when additional backing capacity is needed.
    pv_needed = current["pv_bytes"] + missing + (GIB if missing else 0)
    disk_needed = pv_needed + current["partition_start_bytes"] + (2 * 1024 ** 2 if current["partition"] else 0)
    disk_target = max(current["disk_bytes"], ((disk_needed + GIB - 1) // GIB) * GIB) if missing else current["disk_bytes"]
    return {
        **current, **request, "version": 1,
        "lv_target_extents": current["lv_bytes"] // extent + add_extents,
        "lv_target_bytes": current["lv_bytes"] + add_extents * extent,
        "disk_target_bytes": disk_target,
        "needs_pv_growth": bool(missing),
        "needs_proxmox": disk_target > current["disk_bytes"],
        "completed": False,
    }


def guest_plan(request):
    normalized = checked_request(request)
    current = inspect_guest(normalized["mount"])
    existing = read_state(journal_path("guest", normalized["request_id"]))
    if existing:
        require(all(existing[k] == normalized[k] for k in normalized),
                "Request ID already belongs to a different mount or amount")
        verify_identity(existing, current)
        return existing
    plan = calculate_plan(normalized, current)
    if request.get("execute"):
        claim_guest(plan)
    return plan


def guest_apply(request):
    normalized = checked_request(request)
    require(request.get("execute") is True, "Explicit approved execute flag required")
    plan = read_state(journal_path("guest", normalized["request_id"]))
    require(plan and all(plan[k] == normalized[k] for k in normalized), "Missing or mismatched immutable guest plan")
    current = inspect_guest(plan["mount"])
    verify_identity(plan, current)
    if plan["completed"]:
        require(current["lv_bytes"] == plan["lv_target_bytes"], "Completed target no longer matches")
        verify_filesystem_capacity(plan, current, completed=True)
        return {**plan, "changed": False, "verified_fs_bytes": current["fs_bytes"]}
    claim_guest(plan)
    if plan["needs_pv_growth"]:
        if current["disk_bytes"] < plan["disk_target_bytes"]:
            rescan = Path("/sys/class/block") / Path(current["disk_path"]).name / "device/rescan"
            require(rescan.exists(), "Online disk rescan unavailable; restart/rescan manually and resume this request")
            rescan.write_text("1\n")
            for _ in range(15):
                if number(run(["blockdev", "--getsize64", current["disk_path"]])) >= plan["disk_target_bytes"]:
                    break
                time.sleep(1)
        require(number(run(["blockdev", "--getsize64", current["disk_path"]])) == plan["disk_target_bytes"],
                "Guest disk does not match the approved absolute Proxmox target")
        if plan["partition"]:
            preview = subprocess.run(["growpart", "--dry-run", current["disk_path"], str(plan["partition"])],
                                     text=True, capture_output=True, timeout=30)
            require(preview.returncode in (0, 1), "Partition growth preflight failed")
            if preview.returncode == 0:
                run(["growpart", current["disk_path"], str(plan["partition"])])
            else:
                require("NOCHANGE:" in preview.stdout + preview.stderr, "Partition growth is not safely available")
        run(["pvresize", current["pv_path"]])
        current = inspect_guest(plan["mount"])
        verify_identity(plan, current)
    remaining = (plan["lv_target_bytes"] - current["lv_bytes"]) // current["extent_bytes"]
    require(current["vg_free_extents"] >= remaining, "VG lacks the remaining extents; no LV resize performed")
    if remaining:
        run(["lvextend", "--yes", "--extents", str(plan["lv_target_extents"]), current["lv_path"]])
    # Running the filesystem grow command again is safe after an interrupted job.
    if plan["fstype"] == "ext4":
        run(["resize2fs", current["lv_path"]], timeout=300)
    else:
        run(["xfs_growfs", "-d", plan["mount"]], timeout=300)
    verified = inspect_guest(plan["mount"])
    verify_identity(plan, verified)
    require(verified["lv_bytes"] == plan["lv_target_bytes"], "Final LV size does not match the plan")
    verify_filesystem_capacity(plan, verified)
    plan.update(completed=True, verified_fs_bytes=verified["fs_bytes"], changed=True)
    atomic_json(STATE_ROOT / journal_path("guest", plan["request_id"]), plan)
    atomic_json(STATE_ROOT / "active-guest.json", {})
    return plan


def parse_qm_config(text):
    config = {}
    for line in text.splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            config[key] = value
    return config


def select_pve_disk(config, guest):
    serial = guest["disk_serial"]
    require(serial, "Guest disk has no serial; automatic Proxmox mapping is unavailable")
    matches = []
    for key, value in config.items():
        if not DISK_RE.fullmatch(key):
            continue
        opts = dict(part.split("=", 1) for part in value.split(",")[1:] if "=" in part)
        actual_serial = opts.get("serial", "drive-" + key)
        if serial == actual_serial:
            matches.append((key, value.split(",")[0], opts))
    require(len(matches) == 1, "Disk serial must match exactly one Proxmox disk; no device-order guessing is allowed")
    key, volume, opts = matches[0]
    require(opts.get("media", "disk") == "disk" and not opts.get("file"),
            "CD-ROM and overridden file configurations are unsupported")
    require(":" in volume and not volume.startswith("/"), "Only managed Proxmox volumes are supported")
    return key, volume, opts


def capacity_check(available, total, growth, reserve_gib):
    reserve = max(reserve_gib * GIB, (total + 9) // 10)
    require(growth >= 0 and available >= growth + reserve,
            "Proxmox storage lacks requested growth plus reserve (10 GiB minimum and 10% capacity)")
    return {"available_bytes": available, "total_bytes": total, "growth_bytes": growth, "reserve_bytes": reserve}


def provisioned_capacity_check(available, total, growth, image_sizes, image_allocated, reserve_gib=10):
    """Reserve every already provisioned byte, not just blocks allocated today."""
    require(len(image_sizes) == len(image_allocated) and image_sizes,
            "Complete image capacity enumeration is required")
    require(all(type(n) is int and n >= 0 for n in image_sizes + image_allocated),
            "Invalid provisioned/allocated image sizes")
    outstanding = sum(max(0, size - used) for size, used in zip(image_sizes, image_allocated))
    reserve = max(reserve_gib * GIB, (total + 9) // 10)
    require(available >= growth + outstanding + reserve,
            "Proxmox provisioned capacity lacks growth plus reserve: actual free %.2f GiB, "
            "already provisioned but unallocated %.2f GiB, requested growth %.2f GiB, reserve %.2f GiB"
            % (available / GIB, outstanding / GIB, growth / GIB, reserve / GIB))
    result = capacity_check(available, total, growth + outstanding, reserve_gib)
    return {**result, "requested_growth_bytes": growth,
            "provisioned_image_bytes": sum(image_sizes), "allocated_image_bytes": sum(image_allocated),
            "unallocated_commitment_bytes": outstanding}


def directory_images_capacity(volumes):
    images = [v for v in volumes if v.get("content") == "images"]
    require(images and len(images) <= 200, "Complete image enumeration requires 1-200 images")
    sizes, allocated, seen_files = [], [], set()
    for image in images:
        require(image.get("format") in ("raw", "qcow2") and not image.get("parent"),
                "Storage contains unsupported or linked disk images")
        path = run(["pvesm", "path", image["volid"]])
        require(path.startswith("/") and "\\n" not in path and os.path.isfile(path) and not os.path.islink(path),
                "Every provisioned image must be a regular file")
        info = json_command(["qemu-img", "info", "--force-share", "--output=json", path])
        require(info.get("format") == image["format"] and not info.get("backing-filename")
                and not info.get("snapshots") and not info.get("data-file")
                and not info.get("format-specific", {}).get("data", {}).get("data-file"),
                "Storage contains image snapshots, backing chains or external data files")
        require(type(info.get("virtual-size")) is int and info["virtual-size"] == number(image["size"]),
                "Image enumeration is inconsistent with current virtual sizes")
        stat = os.stat(path)
        identity = (stat.st_dev, stat.st_ino)
        require(identity not in seen_files and stat.st_nlink == 1,
                "Duplicate or hardlinked images require manual capacity review")
        seen_files.add(identity)
        sizes.append(info["virtual-size"])
        allocated.append(stat.st_blocks * 512)
    return sizes, allocated


def pve_storage(volume, vmid, growth, reserve_gib=10):
    storage = volume.split(":", 1)[0]
    require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", storage), "Invalid storage name")
    node = run(["hostname", "--short"])
    require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", node), "Invalid Proxmox node name")
    storage_endpoint = "/nodes/" + node + "/storage/" + storage
    status = json_command(["pvesh", "get", storage_endpoint + "/status", "--output-format", "json"])
    require(status.get("active") == 1, "Proxmox storage is not active")
    require(status.get("shared", 0) == 0, "Shared storage needs a cluster-wide resize lock and is unsupported")
    volumes = json_command(["pvesh", "get", storage_endpoint + "/content", "--output-format", "json"])
    matches = [v for v in volumes if v.get("volid") == volume]
    require(len(matches) == 1 and matches[0].get("format") in ("raw", "qcow2") and not matches[0].get("parent"),
            "Only a uniquely identified raw/qcow2 VM disk without a backing parent is supported")
    path = run(["pvesm", "path", volume])
    require(path.startswith("/") and "\n" not in path, "Invalid storage path")
    check = capacity_check(number(status["avail"]), number(status["total"]), growth, reserve_gib)
    if status["type"] == "dir":
        require(os.path.isfile(path) and not os.path.islink(path), "Directory storage must contain a regular raw/qcow2 image")
        require_tools(["qemu-img"])
        info = json_command(["qemu-img", "info", "--force-share", "--output=json", path])
        require(info.get("format") == matches[0]["format"] and not info.get("backing-filename") and not info.get("snapshots")
                and not info.get("data-file") and not info.get("format-specific", {}).get("data", {}).get("data-file"),
                "Backing chains, external data files and image snapshots are unsupported")
        stats = os.statvfs(path)
        physical = capacity_check(stats.f_bavail * stats.f_frsize, stats.f_blocks * stats.f_frsize, growth, reserve_gib)
        sizes, allocated = directory_images_capacity(volumes)
        provisioned = provisioned_capacity_check(stats.f_bavail * stats.f_frsize, stats.f_blocks * stats.f_frsize,
                                                growth, sizes, allocated, reserve_gib)
        size = int(info["virtual-size"])
    elif status["type"] == "lvmthin":
        require(matches[0]["format"] == "raw", "Thin LVM storage must expose a raw volume")
        require_tools(["lvs"])
        volumes_lvm = report("lvs", "lv_path,vg_name,lv_name,lv_size,pool_lv,origin,segtype,data_percent,metadata_percent")
        devices = [lv for lv in volumes_lvm if lv["lv_path"].strip() and
                   os.path.realpath(lv["lv_path"].strip()) == os.path.realpath(path)]
        require(len(devices) == 1, "Thin volume cannot be mapped uniquely")
        disk = devices[0]
        require(disk["segtype"].strip() == "thin" and not disk["origin"].strip(), "Thin snapshots are unsupported")
        pools = [lv for lv in volumes_lvm if lv["vg_name"].strip() == disk["vg_name"].strip()
                 and lv["lv_name"].strip() == disk["pool_lv"].strip()]
        require(len(pools) == 1 and pools[0]["segtype"].strip() == "thin-pool", "Cannot identify thin-pool capacity")
        pool = pools[0]
        require(not any(lv["vg_name"].strip() == disk["vg_name"].strip() and
                        lv["pool_lv"].strip() == disk["pool_lv"].strip() and lv["origin"].strip()
                        for lv in volumes_lvm), "Thin pool contains snapshots; capacity accounting needs manual review")
        data_used = float(pool["data_percent"])
        metadata_used = float(pool["metadata_percent"])
        require(0 <= data_used < 90 and 0 <= metadata_used < 80, "Thin-pool data or metadata is too full")
        total = number(pool["lv_size"])
        used = int(total * data_used / 100)
        physical = capacity_check(total - used, total, growth, reserve_gib)
        children = [lv for lv in volumes_lvm if lv["vg_name"].strip() == disk["vg_name"].strip()
                    and lv["pool_lv"].strip() == disk["pool_lv"].strip()]
        require(children and all(lv["segtype"].strip() == "thin" for lv in children),
                "Cannot enumerate all provisioned thin volumes")
        # Pool allocation is shared across its volumes. Aggregate before subtracting.
        provisioned = provisioned_capacity_check(total - used, total, growth,
                                                [sum(number(lv["lv_size"]) for lv in children)],
                                                [used], reserve_gib)
        size = number(disk["lv_size"])
    else:
        raise Refused("Unsupported Proxmox storage type; only raw/qcow2 directory and LVM-thin storage are supported")
    return {"storage": storage, "volume": volume, "size_bytes": size, "logical": check, "physical": physical, "provisioned": provisioned}


def inspect_pve(request, guest):
    vmid = request.get("vmid")
    require(type(vmid) is int and 100 <= vmid <= 999999999, "A verified integer Proxmox VM ID is required")
    require_tools(["qm", "pvesm", "pvesh", "hostname"])
    node = run(["hostname", "--short"])
    require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", node), "Invalid Proxmox node name")
    config = parse_qm_config(run(["qm", "config", str(vmid), "--current"]))
    smbios = dict(part.split("=", 1) for part in config.get("smbios1", "").split(",") if "=" in part)
    require(guest.get("machine_uuid") and smbios.get("uuid") and
            str(uuid.UUID(guest["machine_uuid"])) == str(uuid.UUID(smbios["uuid"])),
            "Guest DMI UUID does not match this Proxmox VM; refusing ambiguous VM mapping")
    require("lock" not in config and not config.get("template"), "VM is locked or is a template")
    require(run(["qm", "status", str(vmid)]) == "status: running", "VM must be running for online guest growth")
    snapshots = json_command(["pvesh", "get", "/nodes/" + node + "/qemu/" + str(vmid) + "/snapshot", "--output-format", "json"])
    require(all(item.get("name") == "current" for item in snapshots), "VM snapshots are unsupported")
    pending = json_command(["pvesh", "get", "/nodes/" + node + "/qemu/" + str(vmid) + "/pending", "--output-format", "json"])
    require(not any("pending" in item or item.get("delete") for item in pending),
            "VM has pending configuration changes")
    key, volume, opts = select_pve_disk(config, guest)
    capacity = pve_storage(volume, vmid, 0)
    require(capacity["size_bytes"] <= guest["disk_target_bytes"], "Proxmox disk exceeds the approved target")
    return {"vmid": vmid, "node": node, "disk": key, "volume": volume, "serial": guest["disk_serial"],
            "capacity": capacity, "target_bytes": guest["disk_target_bytes"]}


def pve_plan(request):
    guest = request.get("guest_plan", {})
    checked_request(guest)
    require(guest.get("needs_proxmox") is True and type(guest.get("disk_target_bytes")) is int,
            "Guest plan does not require Proxmox growth")
    require(guest["disk_target_bytes"] > guest["disk_bytes"] and
            guest["disk_target_bytes"] - guest["disk_bytes"] <= (guest["add_gib"] + 2) * GIB,
            "Disk growth exceeds the requested size and bounded alignment allowance")
    current = inspect_pve(request, guest)
    previous = read_state(journal_path("pve", guest["request_id"]))
    if previous:
        require(previous["guest_plan"] == guest and previous["vmid"] == current["vmid"] and
                previous["disk"] == current["disk"] and previous["volume"] == current["volume"],
                "Proxmox request ID or mapping changed")
        return previous
    require(current["capacity"]["size_bytes"] == guest["disk_bytes"],
            "Guest/PVE disk sizes differ before planning; refusing to guess the backing disk")
    growth = current["target_bytes"] - current["capacity"]["size_bytes"]
    capacity = pve_storage(current["volume"], current["vmid"], growth)
    plan = {**current, "capacity": capacity, "guest_plan": guest, "completed": False}
    if request.get("execute") is True:
        atomic_json(STATE_ROOT / journal_path("pve", guest["request_id"]), plan)
    return plan


def pve_apply(request):
    require(request.get("execute") is True, "Explicit approved execute flag required")
    guest = request.get("guest_plan", {})
    checked_request(guest)
    plan = read_state(journal_path("pve", guest["request_id"]))
    require(plan and plan["guest_plan"] == guest and request.get("vmid") == plan["vmid"],
            "Missing or mismatched immutable Proxmox plan")
    current = inspect_pve(request, guest)
    require(all(current[k] == plan[k] for k in ("vmid", "node", "disk", "volume", "serial", "target_bytes")),
            "Proxmox mapping changed")
    growth = plan["target_bytes"] - current["capacity"]["size_bytes"]
    if growth:
        pve_storage(plan["volume"], plan["vmid"], growth)
        # Absolute GiB target: never +N, so retry cannot enlarge the disk twice.
        require(plan["target_bytes"] % GIB == 0, "Proxmox target must be whole GiB")
        run(["qm", "resize", str(plan["vmid"]), plan["disk"], str(plan["target_bytes"] // GIB) + "G"], timeout=180)
    verified = pve_storage(plan["volume"], plan["vmid"], 0)
    require(verified["size_bytes"] == plan["target_bytes"], "Proxmox resize did not reach the planned size")
    plan.update(completed=True, changed=bool(growth), capacity=verified)
    atomic_json(STATE_ROOT / journal_path("pve", guest["request_id"]), plan)
    return plan


def main():
    require(os.geteuid() == 0, "This helper must run as root")
    require(len(sys.argv) == 2 and sys.argv[1] in
            ("guest-plan", "guest-apply", "pve-plan", "pve-apply"), "Unsupported operation")
    request = json.load(sys.stdin)
    require(isinstance(request, dict), "JSON object required")
    STATE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_ROOT, 0o700)
    with (STATE_ROOT / "workflow.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        handlers = {"guest-plan": guest_plan, "guest-apply": guest_apply,
                    "pve-plan": pve_plan, "pve-apply": pve_apply}
        print(json.dumps(handlers[sys.argv[1]](request), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refused, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
