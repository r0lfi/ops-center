"""
web_fetch / web_search - read-only reach outside the fleet for the General
Agent's longer investigations (release notes, CVE write-ups, vendor docs).

web_search uses DuckDuckGo's HTML endpoint because it needs no API key;
it's best-effort scraping and says so in its result when it comes back
empty rather than pretending the web had nothing. Neither tool can write
anything anywhere - it's GET only, capped in size, and the agent still
has to run any actual command through the approval-gated
run_shell_command.
"""
import html
import re
from urllib.parse import parse_qs, quote_plus, urlparse

import httpx

_MAX_CHARS = 12000
_UA = "OpsCenter-AI/1.0 (+homelab; read-only)"

FETCH_SCHEMA = {
    "name": "web_fetch",
    "description": (
        "Fetches one http(s) URL and returns its readable text (HTML stripped, capped at ~12k "
        "characters) - for reading documentation, release notes or advisories. GET only."
    ),
    "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
}

SEARCH_SCHEMA = {
    "name": "web_search",
    "description": (
        "Web search (DuckDuckGo) returning titles, URLs and snippets. Best-effort - if it "
        "returns no results, say the search found nothing rather than inventing sources. "
        "Follow up with web_fetch to read a result."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "description": "Max results, default 5", "default": 5},
        },
        "required": ["query"],
    },
}

_TAG_RE = re.compile(r"<[^>]+>")
_DROP_RE = re.compile(r"<(script|style|noscript|svg)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n{3,}")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_RESULT_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'(?:<a[^>]+class="result__snippet"[^>]*>(.*?)</a>|<td[^>]+class="result__snippet"[^>]*>(.*?)</td>)?',
    re.IGNORECASE | re.DOTALL,
)


def _strip_html(raw: str) -> str:
    text = _DROP_RE.sub(" ", raw)
    text = re.sub(r"</(p|div|br|li|h[1-6]|tr|section|article)>", "\n", text, flags=re.IGNORECASE)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    return _NL_RE.sub("\n\n", text).strip()


def web_fetch(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return {"available": False, "error": "only http(s) URLs can be fetched"}
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": _UA}) as client:
            resp = client.get(url)
    except httpx.HTTPError as exc:
        return {"available": False, "error": f"fetch failed: {exc}"}

    content_type = resp.headers.get("content-type", "")
    if not any(t in content_type for t in ("text/", "json", "xml")):
        return {"available": False, "error": f"not a text document ({content_type or 'unknown content type'})"}

    body = resp.text
    title_match = _TITLE_RE.search(body)
    text = _strip_html(body) if "html" in content_type else body
    truncated = len(text) > _MAX_CHARS
    return {
        "available": True,
        "url": str(resp.url),
        "status": resp.status_code,
        "title": html.unescape(title_match.group(1)).strip() if title_match else None,
        "truncated": truncated,
        "text": text[:_MAX_CHARS],
    }


def _unwrap_ddg(href: str) -> str:
    # DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded>
    if "duckduckgo.com/l/" in href:
        target = parse_qs(urlparse(href).query).get("uddg")
        if target:
            return target[0]
    return href if href.startswith("http") else f"https:{href}"


def web_search(query: str, limit: int = 5) -> dict:
    limit = max(1, min(int(limit), 10))
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": _UA}) as client:
            resp = client.get(f"https://html.duckduckgo.com/html/?q={quote_plus(query)}")
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        return {"available": False, "error": f"search failed: {exc}"}

    results = []
    for match in _RESULT_RE.finditer(resp.text):
        href, title, snippet_a, snippet_td = match.groups()
        results.append(
            {
                "title": _strip_html(title),
                "url": _unwrap_ddg(html.unescape(href)),
                "snippet": _strip_html(snippet_a or snippet_td or ""),
            }
        )
        if len(results) >= limit:
            break
    return {
        "available": True,
        "query": query,
        "results": results,
        "note": None if results else "no results parsed - the search may be blocked or the page layout changed",
    }
