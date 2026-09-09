"""
App Catalog: fetches and parses a Portainer-spec-v2 template list (a
Portainer-compatible URL is admin-configurable - see
AppCatalogSettings/DEFAULT_TEMPLATE_URL) and renders a chosen template into
a docker-compose YAML string. That YAML is this module's entire output -
everything after it (POST /docker-hosts/{hostname}/stacks) is the existing,
completely unmodified Phase 2 stack-deploy path. This module never touches
docker.sock or SSH.

Real-world template lists are inconsistent about their exact envelope
(`{"version":"2","templates":[...]}` vs a bare `[...]` array) and about
`type` (int `1`/`2`/`3` vs the string forms `"container"`/`"swarm"`/
`"compose"`) - verified live against three different real lists before
writing this parser, not assumed from documentation. `type: 2` (Swarm) is
filtered out entirely; this app only ever runs plain `docker compose`.

Fetched on-demand only, short in-memory TTL cache - same convention
registry_client.py already established (never a scheduled background poll,
and here also avoids hammering someone's GitHub raw/API rate limit on every
page load).
"""

import re
import time

import httpx
import yaml

_REQUEST_TIMEOUT = 15.0
_CACHE_TTL_SECONDS = 600
_cache: dict[str, tuple[float, list[dict]]] = {}

_TYPE_MAP = {"container": 1, "swarm": 2, "compose": 3}
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str | None) -> str | None:
    # Template lists are untrusted external content (admin-configurable
    # URL, not vetted by us) - `note` in particular is documented by
    # Portainer as raw HTML. Stripped here, at the point it enters the
    # system, rather than trusting the frontend to never render it raw.
    return _HTML_TAG_RE.sub("", text).strip() if text else text


def _normalize_type(raw_type) -> int | None:
    if isinstance(raw_type, str):
        raw_type = int(raw_type) if raw_type.isdigit() else _TYPE_MAP.get(raw_type.lower())
    return raw_type if raw_type in (1, 2, 3) else None


def _normalize_volume(raw) -> dict:
    if isinstance(raw, str):
        return {"container": raw, "bind": None}
    return {"container": raw.get("container", ""), "bind": raw.get("bind")}


def _normalize_env_field(raw: dict) -> dict:
    return {
        "name": raw.get("name", ""),
        "label": raw.get("label") or raw.get("name", ""),
        "description": raw.get("description"),
        "default": raw.get("default") or raw.get("set"),
        "select": [
            {"text": o.get("text", o.get("value", "")), "value": o.get("value", "")}
            for o in raw.get("select", [])
        ]
        or None,
    }


def _normalize_template(raw: dict) -> dict | None:
    tpl_type = _normalize_type(raw.get("type"))
    if tpl_type not in (1, 3):
        return None
    if tpl_type == 1 and not raw.get("image"):
        return None
    if tpl_type == 3 and not (raw.get("repository") or {}).get("stackfile"):
        return None

    return {
        "type": tpl_type,
        "title": raw.get("title", "untitled"),
        "description": _strip_html(raw.get("description", "")) or "",
        "categories": raw.get("categories") or [],
        "logo": raw.get("logo"),
        "note": _strip_html(raw.get("note")),
        "platform": raw.get("platform"),
        "image": raw.get("image"),
        "command": raw.get("command"),
        "interactive": bool(raw.get("interactive")),
        "restart_policy": raw.get("restart_policy"),
        "ports": raw.get("ports") or [],
        "volumes": [_normalize_volume(v) for v in (raw.get("volumes") or [])],
        "repository": raw.get("repository"),
        "env": [_normalize_env_field(e) for e in (raw.get("env") or [])],
    }


async def fetch_templates(url: str) -> list[dict]:
    cached = _cache.get(url)
    if cached and (time.monotonic() - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1]

    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()

    raw_templates = data if isinstance(data, list) else data.get("templates", [])
    templates = [t for t in (_normalize_template(r) for r in raw_templates) if t is not None]
    _cache[url] = (time.monotonic(), templates)
    return templates


def _slugify(title: str) -> str:
    slug = _SLUG_RE.sub("-", title.lower()).strip("-")
    if not slug or not slug[0].isalnum():
        slug = f"app-{slug}" if slug else "app"
    return slug[:63]


def _parse_github_owner_repo(url: str) -> tuple[str, str] | None:
    match = re.match(r"^https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", url.strip())
    return (match.group(1), match.group(2)) if match else None


async def _fetch_stackfile(repository: dict) -> str:
    url = repository.get("url", "")
    stackfile = repository.get("stackfile", "")
    owner_repo = _parse_github_owner_repo(url)
    if owner_repo is None:
        raise ValueError(f"unsupported template repository host (only github.com is supported): {url}")
    owner, repo = owner_repo

    api_url = f"https://api.github.com/repos/{owner}/{repo}/contents/{stackfile}"
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
        resp = await client.get(api_url, headers={"Accept": "application/vnd.github.raw+json"})
        resp.raise_for_status()
        return resp.text


def _resolved_env_values(template: dict, env_values: dict[str, str]) -> dict[str, str]:
    resolved = {}
    for field in template["env"]:
        name = field["name"]
        resolved[name] = env_values.get(name) or field.get("default") or ""
    return resolved


def _render_container_template(template: dict, env_values: dict[str, str]) -> str:
    name = _slugify(template["title"])
    resolved_env = _resolved_env_values(template, env_values)

    service: dict = {"image": template["image"], "container_name": name}
    if template.get("ports"):
        service["ports"] = list(template["ports"])
    if template.get("volumes"):
        service["volumes"] = [
            f"{v['bind']}:{v['container']}" if v["bind"] else v["container"] for v in template["volumes"]
        ]
    if resolved_env:
        service["environment"] = resolved_env
    if template.get("command"):
        service["command"] = template["command"]
    if template.get("interactive"):
        service["stdin_open"] = True
        service["tty"] = True
    service["restart"] = template.get("restart_policy") or "unless-stopped"

    compose_yaml = yaml.safe_dump({"services": {name: service}}, sort_keys=False, default_flow_style=False)
    return compose_yaml, name


async def _render_compose_template(template: dict, env_values: dict[str, str]) -> tuple[str, str]:
    resolved_env = _resolved_env_values(template, env_values)
    stackfile = await _fetch_stackfile(template["repository"])
    # Plain docker-compose ${VAR} interpolation, resolved here (rather than
    # left for `docker compose` itself, which has no .env file to read in
    # this app's deploy path) - verified live that real templates use
    # exactly this syntax, nothing more exotic. Any ${VAR} not covered by
    # the template's own declared env list is left as-is, visible in the
    # editable preview for a human to catch before deploying.
    for var_name, value in resolved_env.items():
        stackfile = stackfile.replace(f"${{{var_name}}}", value)
    return stackfile, _slugify(template["title"])


async def render_template(template: dict, env_values: dict[str, str]) -> tuple[str, str]:
    """Returns (compose_yaml, suggested_stack_name)."""
    if template["type"] == 1:
        return _render_container_template(template, env_values)
    return await _render_compose_template(template, env_values)
