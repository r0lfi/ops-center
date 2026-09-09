"""
Generic OCI Distribution v2 client for image-update checks. Deliberately
NOT special-cased per registry - Docker Hub, GHCR, Quay, Harbor, GitLab,
and lscr.io (all in real use in this deployment, per the Images tab) all
implement the same standard: an unauthenticated request first, a 401 with
a `Www-Authenticate: Bearer realm=...` challenge if auth is needed, then a
token fetch against that realm (anonymous for public images; falls back
to a matching configured Registry's credentials via HTTP basic auth on
the token request for private ones).

Called on-demand only (see backend/app/api/routes/containers.py's
update-status endpoint), with a short in-memory TTL cache - never a
scheduled background poll. Docker Hub rate-limits anonymous pulls per
source IP; polling every image on every host on a timer would burn that
budget for no reason a human actually needs "live" answered.
"""

import time

import httpx

_REQUEST_TIMEOUT = 10.0
_CACHE_TTL_SECONDS = 3600
_cache: dict[str, tuple[float, str | None, str | None]] = {}

_MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
    ]
)


def parse_image_ref(image: str) -> tuple[str, str, str | None]:
    """"nginx:latest" -> ("registry-1.docker.io", "library/nginx", "latest")
    "ghcr.io/home-assistant/home-assistant:2026.3.4" -> ("ghcr.io", "home-assistant/home-assistant", "2026.3.4")
    Tag is None for a digest-pinned reference (name@sha256:...) - nothing to compare against."""
    ref = image
    digest = None
    if "@" in ref:
        ref, _, digest = ref.partition("@")

    tag = None
    last_part = ref.rsplit("/", 1)[-1]
    if ":" in last_part:
        ref, _, tag = ref.rpartition(":")
    if tag is None and digest is None:
        tag = "latest"

    parts = ref.split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        registry_host = parts[0]
        repo = "/".join(parts[1:])
    else:
        registry_host = "registry-1.docker.io"
        repo = ref if "/" in ref else f"library/{ref}"

    return registry_host, repo, tag


async def _get_token(
    client: httpx.AsyncClient, www_authenticate: str, username: str | None, password: str | None
) -> str | None:
    if not www_authenticate.lower().startswith("bearer "):
        return None
    challenge: dict[str, str] = {}
    for kv in www_authenticate[len("Bearer ") :].split(","):
        key, _, value = kv.strip().partition("=")
        challenge[key] = value.strip('"')
    realm = challenge.pop("realm", None)
    if not realm:
        return None

    auth = (username, password) if username and password else None
    resp = await client.get(realm, params=challenge, auth=auth, timeout=_REQUEST_TIMEOUT)
    if resp.status_code != 200:
        return None
    data = resp.json()
    return data.get("token") or data.get("access_token")


async def get_latest_digest(
    image: str, registry_username: str | None = None, registry_password: str | None = None
) -> tuple[str | None, str | None]:
    """Returns (digest, error_detail) - digest is None with a human-readable detail on any
    failure (not found, auth required but no matching credential, network error, unparseable
    reference). Never raises - this hits third-party services outside our control, and a lookup
    failure should surface as "unknown" in the UI, not a 500."""
    registry_host, repo, tag = parse_image_ref(image)
    if tag is None:
        return None, "image is pinned by digest, not a tag - nothing to compare against"

    cache_key = f"{registry_host}/{repo}:{tag}"
    cached = _cache.get(cache_key)
    if cached and (time.monotonic() - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1], cached[2]

    manifest_url = f"https://{registry_host}/v2/{repo}/manifests/{tag}"
    headers = {"Accept": _MANIFEST_ACCEPT}

    digest: str | None = None
    detail: str | None = None
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
            resp = await client.head(manifest_url, headers=headers)
            if resp.status_code == 401:
                token = await _get_token(
                    client, resp.headers.get("www-authenticate", ""), registry_username, registry_password
                )
                if token is None:
                    detail = f"{registry_host} requires authentication and no matching registry credential is configured"
                else:
                    resp = await client.head(manifest_url, headers={**headers, "Authorization": f"Bearer {token}"})

            if detail is None:
                if resp.status_code != 200:
                    detail = f"{registry_host} returned HTTP {resp.status_code} for {repo}:{tag}"
                else:
                    digest = resp.headers.get("docker-content-digest")
                    if not digest:
                        detail = f"{registry_host} did not return a Docker-Content-Digest header"
    except httpx.HTTPError as exc:
        detail = f"could not reach {registry_host}: {exc}"

    _cache[cache_key] = (time.monotonic(), digest, detail)
    return digest, detail
