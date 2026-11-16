"""
Provider-agnostic chat/tool-calling contract.

Message history is kept in one generic shape regardless of which provider
is in use:

    {"role": "user" | "assistant" | "tool", "content": str,
     "tool_call_id": str | None, "name": str | None}

Each provider's chat() translates this generic history into its own wire
format and translates the reply back into a ProviderResult; each
provider's tool_result_messages() builds the generic messages to append
after tools have actually run. This is what lets an agent switch between
Anthropic/OpenAI/Mistral/Ollama by changing one DB row, not code.
"""
from dataclasses import dataclass, field


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class ProviderResult:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "stop"  # "tool_use" | "stop" | "error"
    assistant_message: dict | None = None
    # Token usage for this one round trip, as reported by the provider
    # (0 when it reports nothing) - recorded per call by runtime.py.
    input_tokens: int = 0
    output_tokens: int = 0
    usage_reported: bool = False
    cache_read_tokens: int = 0
    cache_write_tokens: int | None = 0
    cache_write_1h_tokens: int | None = 0
    # Usage remains available even when model content cannot be used safely.
    error_message: str | None = None


class ProviderError(RuntimeError):
    """Raised for any provider-side failure (network, auth, bad response) -
    callers must show 'AI provider unavailable', never guess at a reply."""


class ProviderCallNotStarted(ProviderError):
    """The transport proved that no HTTP request was attempted."""


def usage_count(usage: dict, key: str, default: int | None = 0) -> tuple[int | None, bool]:
    """Keep absent optional metadata distinct from reported counts."""
    if key not in usage or usage[key] is None:
        return default, True
    value = usage[key]
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value, True
    return default, False


class AIProvider:
    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        raise NotImplementedError

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        raise NotImplementedError
