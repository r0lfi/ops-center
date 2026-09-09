import json

import httpx

from worker_ai.ai.providers.base import AIProvider, ProviderError, ProviderResult, ToolCall


class OpenAIProvider(AIProvider):
    def __init__(self, api_key: str, base_url: str | None = None):
        self._api_key = api_key
        self._base_url = (base_url or "https://api.openai.com").rstrip("/")

    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        openai_tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
            for t in tools
        ]
        wire_messages = [{"role": "system", "content": system}, *messages]
        try:
            resp = httpx.post(
                f"{self._base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    # Newer models (e.g. gpt-5.6-luna) reject the older
                    # `max_tokens` outright with a 400 "unsupported_parameter"
                    # - `max_completion_tokens` is OpenAI's current name for
                    # this across the Chat Completions API.
                    "max_completion_tokens": max_tokens,
                    "messages": wire_messages,
                    **({"tools": openai_tools} if openai_tools else {}),
                    # A reasoning model (e.g. gpt-5.6-luna) otherwise rejects
                    # function tools on /v1/chat/completions outright ("use
                    # /v1/responses or set reasoning_effort to 'none'") -
                    # only sent when there are tools to avoid changing
                    # behavior for a plain, tool-less call.
                    **({"reasoning_effort": "none"} if openai_tools else {}),
                },
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"OpenAI API call failed: {exc}") from exc

        choice = data["choices"][0]
        message = choice["message"]
        raw_calls = message.get("tool_calls") or []
        tool_calls = [
            ToolCall(id=c["id"], name=c["function"]["name"], arguments=json.loads(c["function"]["arguments"] or "{}"))
            for c in raw_calls
        ]
        # Pass finish_reason through as-is (e.g. "length") instead of
        # collapsing everything non-tool-call to "stop" - see the same fix
        # in anthropic.py for why that distinction matters.
        stop_reason = "tool_use" if tool_calls else (choice.get("finish_reason") or "stop")

        usage = data.get("usage") or {}
        return ProviderResult(
            text=(message.get("content") or "").strip(),
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
            assistant_message={
                "role": "assistant",
                "content": message.get("content"),
                "tool_calls": raw_calls or None,
            },
        )

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        return [
            {"role": "tool", "tool_call_id": call.id, "content": result}
            for call, result in zip(tool_calls, results)
        ]
