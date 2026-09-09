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
Anthropic/OpenAI/Ollama by changing one DB row, not code.
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


class ProviderError(RuntimeError):
    """Raised for any provider-side failure (network, auth, bad response) -
    callers must show 'AI provider unavailable', never guess at a reply."""


class AIProvider:
    def chat(
        self, *, system: str, messages: list[dict], tools: list[dict], model: str, max_tokens: int = 4096
    ) -> ProviderResult:
        raise NotImplementedError

    def tool_result_messages(self, tool_calls: list[ToolCall], results: list[str]) -> list[dict]:
        raise NotImplementedError
