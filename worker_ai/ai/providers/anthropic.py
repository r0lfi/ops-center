import httpx

from worker_ai.ai.providers.base import AIProvider, ProviderError, ProviderResult, ToolCall

_API_VERSION = "2023-06-01"


class AnthropicProvider(AIProvider):
    def __init__(self, api_key: str, base_url: str | None = None):
        self._api_key = api_key
        self._base_url = (base_url or "https://api.anthropic.com").rstrip("/")

    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        anthropic_tools = [
            {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools
        ]
        try:
            resp = httpx.post(
                f"{self._base_url}/v1/messages",
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": _API_VERSION,
                    "content-type": "application/json",
                },
                json={
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": system,
                    "messages": messages,
                    **({"tools": anthropic_tools} if anthropic_tools else {}),
                },
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"Anthropic API call failed: {exc}") from exc

        content = data.get("content", [])
        text_parts = [b["text"] for b in content if b.get("type") == "text"]
        tool_calls = [
            ToolCall(id=b["id"], name=b["name"], arguments=b.get("input", {}))
            for b in content
            if b.get("type") == "tool_use"
        ]
        # Pass the real value through (e.g. "max_tokens", "end_turn") instead
        # of collapsing everything non-"tool_use" to "stop" - runtime.py only
        # branches on "tool_use" today, but a truncated response is a very
        # different situation from a clean finish and callers should be able
        # to tell them apart (see runtime.py's empty-text handling).
        stop_reason = data.get("stop_reason") or "stop"

        usage = data.get("usage") or {}
        return ProviderResult(
            text="\n".join(text_parts).strip(),
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            # Anthropic requires echoing the exact content-block list back
            # as history for tool_use/tool_result pairing to line up.
            assistant_message={"role": "assistant", "content": content},
        )

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        return [
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": call.id, "content": result}
                    for call, result in zip(tool_calls, results)
                ],
            }
        ]
