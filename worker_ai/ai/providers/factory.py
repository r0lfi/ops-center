from app.models.ai import AIProvider as AIProviderRow
from worker_ai.ai.providers.anthropic import AnthropicProvider
from worker_ai.ai.providers.base import AIProvider, ProviderError
from worker_ai.ai.providers.ollama import OllamaProvider
from worker_ai.ai.providers.openai import OpenAIProvider
from worker_ai.secrets import read_secret


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
        return OllamaProvider(base_url=row.base_url)

    if not row.secret_path:
        raise ProviderError(f"provider {row.slug!r} has no API key configured yet")
    api_key = read_secret(row.secret_path)

    if row.kind == "anthropic":
        return AnthropicProvider(api_key=api_key, base_url=row.base_url)
    if row.kind == "openai":
        return OpenAIProvider(api_key=api_key, base_url=row.base_url)

    raise ProviderError(f"unknown provider kind {row.kind!r}")
