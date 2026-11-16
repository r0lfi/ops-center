import httpx
from worker_ai.ai.transport import output_timeout, post

from worker_ai.ai.providers.base import AIProvider, ProviderError, ProviderResult, ToolCall, usage_count

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
            resp = post(
                f"{self._base_url}/v1/messages",
                headers={"x-api-key": self._api_key, "anthropic-version": _API_VERSION, "content-type": "application/json"},
                json={"model": model, "max_tokens": max_tokens, "service_tier": "standard_only",
                    "cache_control": {"type": "ephemeral"},
                    "system": system, "messages": messages,
                    **({"tools": anthropic_tools} if anthropic_tools else {})},
                timeout=output_timeout(max_tokens),
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"Anthropic API call failed: {exc}") from exc

        usage = data.get("usage") if isinstance(data, dict) else None
        usage = usage if isinstance(usage, dict) else {}
        inp, inp_valid = usage_count(usage, "input_tokens")
        out, out_valid = usage_count(usage, "output_tokens")
        cached, read_valid = usage_count(usage, "cache_read_input_tokens")
        writes, write_valid = usage_count(usage, "cache_creation_input_tokens")
        raw_creation = usage.get("cache_creation")
        creation = raw_creation if isinstance(raw_creation, dict) else {}
        hour_writes, ttl_valid = usage_count(creation, "ephemeral_1h_input_tokens", None if writes else 0)
        accounting = dict(input_tokens=inp + cached + writes, output_tokens=out,
            usage_reported=all((inp_valid, out_valid, read_valid, write_valid, ttl_valid,
                isinstance(usage.get("input_tokens"), int) and not isinstance(usage.get("input_tokens"), bool),
                isinstance(usage.get("output_tokens"), int) and not isinstance(usage.get("output_tokens"), bool),
                raw_creation is None or isinstance(raw_creation, dict))),
            cache_read_tokens=cached, cache_write_tokens=writes, cache_write_1h_tokens=hour_writes)
        try:
            content = data["content"]
            if not isinstance(content, list):
                raise ValueError("Invalid content blocks")
            text_parts, tool_calls = [], []
            for block in content:
                if block.get("type") == "text":
                    if not isinstance(block["text"], str):
                        raise ValueError("Invalid text")
                    text_parts.append(block["text"])
                elif block.get("type") == "tool_use":
                    if (not isinstance(block["id"], str) or not block["id"] or not isinstance(block["name"], str)
                            or not block["name"] or not isinstance(block.get("input", {}), dict)):
                        raise ValueError("Invalid tool call")
                    tool_calls.append(ToolCall(id=block["id"], name=block["name"], arguments=block.get("input", {})))
        except (KeyError, TypeError, ValueError, AttributeError):
            return ProviderResult(text="", stop_reason="error", error_message="Anthropic returned an invalid response. No tools were executed; reported usage was retained.", **accounting)
        return ProviderResult(text="\n".join(text_parts).strip(), tool_calls=tool_calls,
            stop_reason=data.get("stop_reason") or "stop",
            assistant_message={"role": "assistant", "content": content}, **accounting)

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
