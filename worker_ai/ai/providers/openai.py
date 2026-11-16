import json

import httpx
from worker_ai.ai.transport import output_timeout, post

from worker_ai.ai.providers.base import AIProvider, ProviderError, ProviderResult, ToolCall, usage_count


class OpenAIProvider(AIProvider):
    label = "OpenAI"

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
        # Only reviewed 5.6 reasoning models accept this setting. Sending it
        # to GPT-4.x prevents otherwise valid, less expensive tool requests.
        reasoning_model = any(model == name or model.startswith(name + "-") for name in
                              ("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"))
        try:
            resp = post(
                f"{self._base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "service_tier": "default",
                    "max_completion_tokens": max_tokens,
                    "messages": wire_messages,
                    **({"tools": openai_tools} if openai_tools else {}),
                    **({"reasoning_effort": "none"} if reasoning_model else {}),
                },
                timeout=output_timeout(max_tokens),
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"OpenAI API call failed: {exc}") from exc
        return self._result(data, reasoning_model)

    def _result(self, data, reasoning_model: bool = False) -> ProviderResult:
        # Capture the provider's accounting before interpreting model content.
        usage = data.get("usage") if isinstance(data, dict) else None
        usage = usage if isinstance(usage, dict) else {}
        raw_details = usage.get("prompt_tokens_details")
        details = raw_details if isinstance(raw_details, dict) else {}
        inp, inp_valid = usage_count(usage, "prompt_tokens")
        out, out_valid = usage_count(usage, "completion_tokens")
        cached, read_valid = usage_count(details, "cached_tokens")
        writes, write_valid = usage_count(details, "cache_write_tokens", None if reasoning_model else 0)
        accounting = dict(input_tokens=inp, output_tokens=out,
            usage_reported=all((inp_valid, out_valid, read_valid, write_valid,
                isinstance(usage.get("prompt_tokens"), int) and not isinstance(usage.get("prompt_tokens"), bool),
                isinstance(usage.get("completion_tokens"), int) and not isinstance(usage.get("completion_tokens"), bool),
                raw_details is None or isinstance(raw_details, dict))),
            cache_read_tokens=cached, cache_write_tokens=writes)
        try:
            choice = data["choices"][0]
            message = choice["message"]
            text = message.get("content") or ""
            if not isinstance(text, str):
                raise ValueError("Invalid text")
            raw_calls = message.get("tool_calls") or []
            if not isinstance(raw_calls, list):
                raise ValueError("Invalid tool calls")
            tool_calls = []
            for call in raw_calls:
                arguments = json.loads(call["function"]["arguments"] or "{}")
                if (not isinstance(arguments, dict) or not isinstance(call["id"], str) or not call["id"]
                        or not isinstance(call["function"]["name"], str) or not call["function"]["name"]):
                    raise ValueError("Invalid tool call")
                tool_calls.append(ToolCall(id=call["id"], name=call["function"]["name"], arguments=arguments))
        except (KeyError, IndexError, TypeError, ValueError, AttributeError):
            finish = (choice.get("finish_reason") if isinstance(locals().get("choice"), dict) else None)
            if finish == "length":
                # Cut off mid tool call: the arguments are incomplete JSON. Say so, instead of "invalid".
                return ProviderResult(text="", stop_reason="error", error_message=f"{self.label} reached the output limit while writing a tool call ({out} tokens). No tools were executed; split the work into smaller calls.", **accounting)
            return ProviderResult(text="", stop_reason="error", error_message=f"{self.label} returned an invalid response. No tools were executed; reported usage was retained.", **accounting)
        stop_reason = choice.get("finish_reason") or "stop"
        # A provider stop takes precedence over any complete calls that came
        # before a truncated or filtered response. Do not start another round.
        if tool_calls and stop_reason not in ("length", "content_filter"):
            stop_reason = "tool_use"
        return ProviderResult(
            text=text.strip(), tool_calls=tool_calls,
            stop_reason=stop_reason,
            assistant_message={"role": "assistant", "content": message.get("content"), "tool_calls": raw_calls or None},
            **accounting,
        )

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        return [
            {"role": "tool", "tool_call_id": call.id, "content": result}
            for call, result in zip(tool_calls, results)
        ]


class OpenAICompatibleProvider(OpenAIProvider):
    """A self-hosted server speaking the OpenAI chat API (llama.cpp-style).

    base_url is the API root including its version path, e.g.
    https://llm.example.lan/v1; the key is optional. Only the portable subset
    of the request is sent (no service_tier, max_tokens instead of
    max_completion_tokens). Local servers are slow, so the per-request
    timeout is long; the agent deadline (transport.DEADLINE) still caps it.
    """

    label = "OpenAI-compatible endpoint"
    TIMEOUT_SECONDS = 600.0

    def __init__(self, base_url: str, api_key: str | None = None):
        self._api_key = api_key or None
        self._base_url = base_url.rstrip("/")

    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        compat_tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
            for t in tools
        ]
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        try:
            resp = post(
                f"{self._base_url}/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": [{"role": "system", "content": system}, *messages],
                    "stream": False,
                    **({"tools": compat_tools} if compat_tools else {}),
                },
                timeout=self.TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"OpenAI-compatible API call failed: {exc}") from exc
        return self._result(data)
