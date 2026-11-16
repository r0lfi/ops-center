from app.models.ai import AIProvider as AIProviderRow
from worker_ai.ai.providers.anthropic import AnthropicProvider
from worker_ai.ai.providers.base import AIProvider, ProviderError
from worker_ai.ai.providers.mistral import MistralProvider
from worker_ai.ai.providers.ollama import OllamaProvider
from worker_ai.ai.providers.openai import OpenAICompatibleProvider, OpenAIProvider
from worker_ai.secrets import read_secret


def _api_key(row: AIProviderRow) -> str:
    """The encrypted database copy works on every node; the key file is a
    fallback for keys saved before it existed (it exists only on the node
    whose API saved it)."""
    encrypted = getattr(row, "encrypted_key", None)
    if encrypted:
        from app.core.provider_keys import ProviderKeyUnreadable, decrypt_provider_key
        try:
            return decrypt_provider_key(encrypted)
        except ProviderKeyUnreadable as exc:
            raise ProviderError(f"provider {row.slug!r}: {exc}") from exc
    try:
        return read_secret(row.secret_path)
    except FileNotFoundError as exc:
        raise ProviderError(f"provider {row.slug!r}: API key is not available on this node; save the key again") from exc


def build_provider(row: AIProviderRow) -> AIProvider:
    """Turns an ai_providers DB row into a live provider instance. Never
    guesses a working configuration - raises ProviderError (which the agent
    runtime turns into a plain "AI provider unavailable" task failure)
    rather than silently falling back to a different provider."""
    if not row.enabled:
        raise ProviderError(f"provider {row.slug!r} is disabled")

    if row.kind == "ollama":
        if not row.base_url:
            raise ProviderError("Ollama provider has no base_url configured")
        from app.core.config import get_settings
        return OllamaProvider(base_url=row.base_url, num_ctx=get_settings().ollama_num_ctx)

    if row.kind == "openai_compatible":
        if not row.base_url:
            raise ProviderError("OpenAI-compatible provider has no base_url configured")
        return OpenAICompatibleProvider(
            base_url=row.base_url, api_key=_api_key(row) if row.secret_path else None
        )

    if not row.secret_path:
        raise ProviderError(f"provider {row.slug!r} has no API key configured yet")
    api_key = _api_key(row)

    if row.kind == "anthropic":
        return AnthropicProvider(api_key=api_key, base_url=row.base_url)
    if row.kind == "openai":
        return OpenAIProvider(api_key=api_key, base_url=row.base_url)
    if row.kind == "mistral":
        return MistralProvider(api_key=api_key, base_url=row.base_url)

    raise ProviderError(f"unknown provider kind {row.kind!r}")
