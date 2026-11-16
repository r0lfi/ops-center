"""Mistral AI (La Plateforme) chat completions with function calling.

The API follows the OpenAI chat shape at https://api.mistral.ai/v1, with a
few differences handled here: max_tokens (not max_completion_tokens), no
service_tier, tool arguments that may arrive as an object, message content
that may arrive as a list of chunks, and "model_length" as a length stop.
Cache reads are reported as prompt_tokens_details.cached_tokens; Mistral
does not charge separately for cache writes.
"""
import json

import httpx
from worker_ai.ai.transport import output_timeout, post

from worker_ai.ai.providers.base import ProviderError, ProviderResult, ToolCall
from worker_ai.ai.providers.openai import OpenAIProvider

DEFAULT_BASE_URL = "https://api.mistral.ai"


def _text(content):
    if isinstance(content, list):
        if not all(isinstance(chunk, dict) for chunk in content):
            raise ValueError("Invalid content chunks")
        # Only text chunks are answer text; thinking/reference chunks are not.
        return "".join(chunk.get("text") or "" for chunk in content if chunk.get("type") == "text")
    return content


def _normalize(data):
    """Rewrite a Mistral reply into the shape OpenAIProvider._result reads."""
    try:
        choice = data["choices"][0]
        message = choice["message"]
        message["content"] = _text(message.get("content"))
        for call in message.get("tool_calls") or []:
            arguments = call["function"].get("arguments")
            if isinstance(arguments, dict):
                call["function"]["arguments"] = json.dumps(arguments)
        if choice.get("finish_reason") == "model_length":
            choice["finish_reason"] = "length"
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        pass  # _result reports the invalid response and keeps reported usage
    return data


class MistralProvider(OpenAIProvider):
    label = "Mistral AI"

    def __init__(self, api_key: str, base_url: str | None = None):
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")

    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        mistral_tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
            for t in tools
        ]
        try:
            resp = post(
                f"{self._base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json",
                         "Accept": "application/json"},
                json={
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": [{"role": "system", "content": system}, *messages],
                    "stream": False,
                    **({"tools": mistral_tools} if mistral_tools else {}),
                },
                # Generation runs at roughly 40-50 tokens/s, so a full 4096-token answer needs
                # well over a minute; the agent deadline still bounds every call (transport.post).
                timeout=output_timeout(max_tokens),
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"Mistral API call failed: {exc}") from exc
        result = self._result(_normalize(data))
        if result.assistant_message is not None and result.assistant_message.get("content") is None:
            # Mistral rejects a null assistant content when the history is replayed.
            result.assistant_message["content"] = ""
        return result

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        return [
            {"role": "tool", "tool_call_id": call.id, "name": call.name, "content": result}
            for call, result in zip(tool_calls, results)
        ]
