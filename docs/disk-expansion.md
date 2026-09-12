# Managed disk expansion

`ansible/playbooks/disk-expand.yml` grows one existing mounted LVM filesystem in one job.
The same job can validate and grow its Proxmox backing disk, rescan the guest,
grow the last GPT partition when present, resize the PV, extend the LV, and grow
XFS or ext4. Existing free VG extents are used before more backing capacity is
requested. Existing unallocated space at the end of the guest disk is also used.

The default request is **+50 GiB**. An explicit **+10 GiB** grows the LV by 10 GiB,
rounded up to a complete LVM extent. The backing disk may receive up to 2 GiB of
additional alignment/metadata allowance. This allowance is free capacity in the
VG, not extra filesystem space. Filesystem tools reserve some metadata space,
so reported usable filesystem capacity differs slightly from LV capacity.
Success requires at least 95% of the planned LV increment to appear in the
filesystem's total capacity; a partial filesystem growth fails the job. Completed
retries also check that the filesystem still has its previously verified capacity.

## Inputs and approval boundary

Submit the playbook as one approved action with a single guest target. Do not
turn its internal commands into individually approved shell jobs. The action
approval must bind the exact target guest, mount, requested GiB, Proxmox
host/VM mapping and stable request ID; the worker must obtain credentials from
its managed inventory. The playbook does not create credentials or bypass the
application's approval gate.

| Variable | Meaning |
| --- | --- |
| `disk_target_host` | Exact managed guest inventory hostname; exactly one guest is allowed. |
| `disk_mount` | Exact existing mount point, default `/data`. |
| `disk_add_gib` | Integer 1–1024, default 50. Never a shell expression. |
| `disk_request_id` | Stable action UUID, reused for all retries of this approved request. |
| `disk_execute` | Boolean, default false. Only an approved action sets true. |
| `disk_proxmox_host` | Existing managed inventory host, required only when backing disk growth is necessary. |
| `disk_proxmox_vmid` | Verified integer VM ID on that Proxmox node, required with backing disk growth. |

The inventory includes both the guest and the delegated Proxmox host. The play
targets only `disk_target_host`; Proxmox operations are delegated explicitly.
Administrative manual runs originate on the canonical jumphost. Existing Ops
Center worker jobs use the established worker path.

Example **preview** variables (use actual managed host names and verified VM ID):

```yaml
disk_target_host: app-vm
disk_mount: /data
disk_add_gib: 10
disk_request_id: 7fa10131-b4e9-41f1-99f7-49ed4fa03c31
disk_execute: false
disk_proxmox_host: pve-node
disk_proxmox_vmid: 204
```

Preview reports exact absolute targets and physical storage checks without
resizing or reserving capacity. Revalidation occurs during execution. Ansible
`--check` also forces preview, even when `disk_execute` is true. Temporary
root-only helper files are created and removed; the directory for request
journals can be created during preview, but preview does not create an active
request or a resize journal.

## Safety and supported layouts

- A mounted read/write XFS or ext4 filesystem on an ordinary linear LVM LV.
- Exactly one PV in the VG; a plain whole disk or the last Linux LVM GPT
  partition. Thin guest LVs, snapshots, RAID, encryption, multipath and
  ambiguous layouts fail before resizing.
- For backing growth, the guest DMI UUID must match the Proxmox VM SMBIOS
  UUID. The guest disk serial must uniquely match its configured Proxmox disk
  serial (including the default `drive-scsiN` / `drive-virtioN` value).
  Disk sizes must agree before the initial plan. Disk letters and boot order
  are never used to guess the VM disk.
- The VM must be running with no snapshots, lock or pending configuration.
- Proxmox directory storage supports a regular raw or qcow2 image with no
  backing chain or image snapshots. Storage status and the actual filesystem
  free space must both cover the complete potential allocation. Every disk image
  on that storage is enumerated (maximum 200); unsupported, linked, duplicate,
  hardlinked or inconsistent images refuse the operation. Its already provisioned
  but unallocated bytes count against capacity, including other VMs.
- Proxmox LVM-thin storage checks the actual thin-pool data capacity and
  metadata use. All virtual sizes in the thin pool count against capacity, not
  just the target VM. Pools with snapshots or metadata at 80% are refused.
- After the planned allocation, at least **10 GiB and 10% of total physical
  storage capacity** must remain free (whichever is greater). Capacity is
  checked again immediately before resize. The result reports actual free bytes,
  provisioned image bytes and unallocated commitments separately. An already
  overcommitted thin pool or qcow2 store can therefore be refused even when
  df reports some free space. Helpers on the same Proxmox node serialize the
  recheck and resize, and the next job accounts for the preceding virtual growth.
  This cannot reserve capacity
  against unrelated hypervisor/storage activity; such a failure stops the job.
- Unsupported stores (including ZFS/Ceph/network/shared stores) fail closed.
- Required existing guest tools: Python 3, util-linux (`findmnt`, `lsblk`,
  `blockdev`), LVM2, and the applicable filesystem growth utility. Partition
  layouts also need `sfdisk` and `growpart`. Proxmox uses its local
  `qm`, `pvesh`, `pvesm` and `qemu-img` tools. Missing prerequisites fail;
  this workflow does not silently install packages or reboot a host.
- No disk is shrunk, reformatted, deleted, detached or replaced. No new VM,
  filesystem or storage pool is provisioned.

## Interrupted requests and retries

Root-only journals under `/var/lib/ops-center/disk-expansion` record the
original device UUIDs and **absolute** LV extent/disk GiB targets before disk
mutation. A host lock serializes helper execution, and an unfinished guest
request prevents a different request from interleaving its resize.

After inspecting a failed or interrupted job, an administrator can resume the playbook with the **original request ID and inputs**. The AI action executor does not automatically rerun a failed job. The
workflow revalidates identities and finishes remaining stages; it never repeats
a relative `+10G` or `+50G` command. A completed request returns its existing
result without another expansion. A genuinely new expansion needs a new
approved action and request ID.

Growth cannot be safely rolled back by shrinking. If a later stage fails,
earlier expansion remains in place and the job reports failure. Restore missing
prerequisites/capacity and resume the original request. If the device layout has
changed or the original request cannot be resumed, an operator must inspect the
journals and current devices before releasing the active request. Never delete
journals to blindly retry a relative expansion.

The final `OPS_CENTER_QUERY_RESULT` includes mode, original sizes, targets,
UUIDs, capacity checks, completion state and verified filesystem capacity.
No passwords or API credentials enter the helper input, output or journals.

## Verification

```bash
PYTHONPATH=backend:. python -m pytest backend/tests/test_disk_expansion.py worker_ai/tests/test_disk_ops.py -q
```

These tests use mocks and temporary journal directories. They do not create
test disks, resize devices, contact hosts or require production credentials.
The helper's guest and Proxmox discovery functions can additionally be checked
read-only against an existing VM; a successful preview is not a disk growth
test and must not be reported as a completed expansion.
