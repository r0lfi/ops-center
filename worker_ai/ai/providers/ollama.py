import httpx

from worker_ai.ai.providers.base import AIProvider, ProviderError, ProviderResult, ToolCall


class OllamaProvider(AIProvider):
    def __init__(self, base_url: str):
        self._base_url = base_url.rstrip("/")

    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        ollama_tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
            for t in tools
        ]
        wire_messages = [{"role": "system", "content": system}, *messages]
        try:
            resp = httpx.post(
                f"{self._base_url}/api/chat",
                json={
                    "model": model,
                    "messages": wire_messages,
                    "stream": False,
                    **({"tools": ollama_tools} if ollama_tools else {}),
                },
                timeout=120.0,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(f"Ollama API call failed: {exc}") from exc

        message = data.get("message", {})
        raw_calls = message.get("tool_calls") or []
        # Ollama doesn't hand out per-call ids - synthesize stable ones
        # (index-based, sufficient for pairing within a single turn).
        tool_calls = [
            ToolCall(id=f"call_{i}", name=c["function"]["name"], arguments=c["function"].get("arguments", {}))
            for i, c in enumerate(raw_calls)
        ]
        stop_reason = "tool_use" if tool_calls else "stop"

        return ProviderResult(
            text=(message.get("content") or "").strip(),
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            # Ollama reports token counts at the top level of the response
            input_tokens=int(data.get("prompt_eval_count") or 0),
            output_tokens=int(data.get("eval_count") or 0),
            assistant_message={"role": "assistant", "content": message.get("content") or "", "tool_calls": raw_calls or None},
        )

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        return [{"role": "tool", "content": result} for result in results]
