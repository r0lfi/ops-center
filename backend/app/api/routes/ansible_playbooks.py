"""
View/edit the ansible/playbooks/ files this app actually runs, from the
web UI - existing files only (ALLOWED_PLAYBOOKS), never a new one added
through here. This is a deliberate, informed exception to "no arbitrary
code execution": these playbooks already run with root/sudo on every
managed host, so editing one is real-world-equivalent to that access.
Admin-only, audit-logged (the existing AuditLogMiddleware covers PUT
here the same as everywhere else - the full new content is logged). See
docs/security.md.

ops-api's write access is scoped to exactly this directory (compose.yml
mounts only ./ansible/playbooks, not the rest of ansible/ - no
ansible.cfg, roles, or collections reachable), and ops-worker mounts the
same host directory read-only, so an edit here takes effect on the next
run with no image rebuild - no separate "deploy" step for a playbook
change.
"""

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
import yaml

from app.api.deps import require_role
from app.models.job import ALLOWED_PLAYBOOKS
from app.schemas.ansible_playbook import AnsiblePlaybookRead, AnsiblePlaybookUpdate

router = APIRouter()

PLAYBOOKS_DIR = Path(os.environ.get("ANSIBLE_PLAYBOOKS_DIR", "/app/ansible/playbooks"))


def _safe_path(name: str) -> Path:
    if name not in ALLOWED_PLAYBOOKS:
        raise HTTPException(status_code=404, detail="not a recognized playbook")
    path = (PLAYBOOKS_DIR / name).resolve()
    if path.parent != PLAYBOOKS_DIR.resolve():
        raise HTTPException(status_code=404, detail="not a recognized playbook")
    return path


@router.get("/ansible/playbooks", response_model=list[str])
async def list_playbooks() -> list[str]:
    return sorted(name for name in ALLOWED_PLAYBOOKS if (PLAYBOOKS_DIR / name).exists())


@router.get("/ansible/playbooks/{name}", response_model=AnsiblePlaybookRead)
async def get_playbook(name: str) -> AnsiblePlaybookRead:
    path = _safe_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="playbook file not found on disk")
    return AnsiblePlaybookRead(name=name, content=path.read_text())


@router.put(
    "/ansible/playbooks/{name}",
    response_model=AnsiblePlaybookRead,
    dependencies=[Depends(require_role("admin"))],
)
async def update_playbook(name: str, payload: AnsiblePlaybookUpdate) -> AnsiblePlaybookRead:
    path = _safe_path(name)
    try:
        yaml.safe_load(payload.content)
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=422, detail=f"invalid YAML: {exc}") from exc

    path.write_text(payload.content)
    return AnsiblePlaybookRead(name=name, content=payload.content)
