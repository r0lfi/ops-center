"""Bounded public arguments for the single approved disk expansion workflow."""
import re

HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$")
MOUNT = re.compile(r"^/(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?$")
PUBLIC_KEYS = {"hostname", "mount", "add_gib", "proxmox_host", "vmid"}

def validate_disk_arguments(arguments):
    if not isinstance(arguments, dict) or set(arguments) - PUBLIC_KEYS:
        raise ValueError("Only hostname, mount, add_gib, proxmox_host and vmid are accepted")
    result = {"hostname": arguments.get("hostname"), "mount": arguments.get("mount", "/data"),
              "add_gib": arguments.get("add_gib", 50)}
    if not isinstance(result["hostname"], str) or not HOST.fullmatch(result["hostname"]):
        raise ValueError("An exact managed guest hostname is required")
    mount = result["mount"]
    if not isinstance(mount, str) or not MOUNT.fullmatch(mount) or any(p in (".", "..") for p in mount.split("/")):
        raise ValueError("An exact absolute mount point is required")
    if type(result["add_gib"]) is not int or not 1 <= result["add_gib"] <= 1024:
        raise ValueError("add_gib must be an integer from 1 to 1024")
    if arguments.get("proxmox_host") is not None or arguments.get("vmid") is not None:
        host, vmid = arguments.get("proxmox_host"), arguments.get("vmid")
        if not isinstance(host, str) or not HOST.fullmatch(host) or host == result["hostname"]:
            raise ValueError("A separate exact managed Proxmox hostname is required")
        if type(vmid) is not int or not 100 <= vmid <= 999999999:
            raise ValueError("A verified Proxmox VM ID is required")
        result.update(proxmox_host=host, vmid=vmid)
    return result

def disk_hostnames(arguments):
    return [arguments["hostname"]] + ([arguments["proxmox_host"]] if arguments.get("proxmox_host") else [])
