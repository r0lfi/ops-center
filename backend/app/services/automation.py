"""
Builds the *only* extra_vars a given playbook is allowed to receive from the
browser. This is the enforcement point for "never allow arbitrary Ansible
command-line arguments from the web" - every field not whitelisted here for
a given playbook is silently dropped, never passed through.
"""

from app.schemas.job import AutomationRunRequest

_ALLOWED_EXTRA_VARS: dict[str, tuple[str, ...]] = {
    "patch-security.yml": ("batch_size",),
    "patch-all.yml": ("batch_size",),
    "reboot.yml": ("batch_size", "required_services"),
    "service-check.yml": ("services",),
}


def build_extra_vars(playbook: str, request: AutomationRunRequest) -> dict:
    allowed = _ALLOWED_EXTRA_VARS.get(playbook, ())
    candidates = {
        "batch_size": request.batch_size,
        "services": request.services,
        "required_services": request.required_services,
    }
    return {key: candidates[key] for key in allowed if candidates.get(key) is not None}
