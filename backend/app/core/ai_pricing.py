"""Reviewed standard text pricing, USD/MTok, verified 2026-09-21.

Sources: https://developers.openai.com/api/docs/pricing
https://developers.openai.com/api/docs/models/gpt-5.6-luna
https://platform.claude.com/docs/en/about-claude/pricing
https://docs.mistral.ai/inference/pricing (Mistral, verified 2026-11-12;
"-latest" aliases are not priced because their target can change)
Exact aliases or dated snapshots only: unknown variants and custom endpoints
fail closed. Mistral cached input costs 0.1x and cache writes cost nothing extra. Self-hosted kinds (ollama, openai_compatible) cost nothing. Reservations include worst-case cache writes; settlement uses reported cache
read/write counts. Costs are estimates at reviewed list prices, not invoices.
"""
import re
from decimal import Decimal, ROUND_CEILING

PRICES = {
    "openai": {
        "gpt-5.6-luna": ("0.20", "1.20"),
        "gpt-5.6-terra": ("2", "12"),
        "gpt-5.6-sol": ("5", "30"),  # pre-promotion ceiling; temporary discounts not relied on
        "gpt-4o-mini": ("0.15", "0.60"), "gpt-4o": ("2.5", "10"),
        "gpt-4.1": ("2", "8"), "gpt-4.1-mini": ("0.40", "1.60"),
        "gpt-4.1-nano": ("0.10", "0.40"),
    },
    "anthropic": {
        "claude-sonnet-5": ("2", "10"),
        "claude-sonnet-4-20250514": ("3", "15"), "claude-sonnet-4-0": ("3", "15"),
        "claude-sonnet-4-5": ("3", "15"), "claude-sonnet-4-6": ("3", "15"),
        "claude-3-5-sonnet-20241022": ("3", "15"),
        "claude-3-7-sonnet-20250219": ("3", "15"),
        "claude-haiku-4-5": ("1", "5"), "claude-3-5-haiku-20241022": ("0.8", "4"),
        "claude-opus-4-20250514": ("15", "75"), "claude-opus-4-1": ("15", "75"),
        "claude-opus-4-5": ("5", "25"), "claude-opus-4-6": ("5", "25"),
    },
    "mistral": {
        "mistral-large-4": ("0.70", "2.10"),
        "mistral-small-2603": ("0.15", "0.60"),
    },
}


class UnknownPrice(ValueError):
    pass


def rates(kind, model, base_url=None, *, ceiling=False):
    if kind in ("ollama", "openai_compatible"):
        return Decimal(0), Decimal(0)
    endpoint = {"openai": "https://api.openai.com", "anthropic": "https://api.anthropic.com",
                "mistral": "https://api.mistral.ai"}.get(kind)
    if endpoint is None or (base_url and base_url.rstrip("/") != endpoint):
        raise UnknownPrice("Paid custom provider endpoint has no reviewed USD pricing")
    table = PRICES.get(kind, {})
    name = model
    if name not in table and kind != "mistral":
        pattern = r"-\d{4}-\d{2}-\d{2}$" if kind == "openai" else r"-\d{8}$"
        name = re.sub(pattern, "", model)
    if name not in table:
        raise UnknownPrice(f"No reviewed USD pricing for {kind}/{model}; provider call blocked")
    inp, out = map(Decimal, table[name])
    # Claude's 1h cache writes can cost 2x; OpenAI 5.6 cache writes 1.25x.
    if ceiling:
        inp *= Decimal("2") if kind == "anthropic" else Decimal("1.25") if name.startswith("gpt-5.6-") else Decimal(1)
    return inp, out


def token_cost(input_tokens, output_tokens, input_rate, output_rate):
    if input_tokens < 0 or output_tokens < 0:
        raise ValueError("Token counts cannot be negative")
    return ((Decimal(input_tokens) * input_rate + Decimal(output_tokens) * output_rate) / Decimal(1000000)).quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)


def reported_cost(kind, model, input_tokens, output_tokens, input_rate, output_rate,
                  cache_read=0, cache_write=0, cache_write_1h=0):
    # Missing cache write/TTL metadata is unknown, not a fabricated token
    # count. Price only that uncertainty at the reviewed ceiling and retain
    # NULL in the reservation for an honest accounting trail.
    values = (input_tokens, output_tokens, cache_read, cache_write, cache_write_1h)
    if any(value is not None and value < 0 for value in values):
        raise ValueError("Invalid provider cache usage breakdown")
    if cache_read > input_tokens:
        raise ValueError("Invalid provider cache usage breakdown")
    read_factor = Decimal("0.1") if kind in ("anthropic", "mistral") or model.startswith("gpt-5.6-") else Decimal("0.25") if model.startswith("gpt-4.1") else Decimal("0.5")
    if cache_write is None:
        if kind != "openai" or not model.startswith("gpt-5.6-") or cache_write_1h not in (None, 0):
            raise ValueError("Unreviewed missing cache write pricing")
        weighted_input = Decimal(input_tokens - cache_read) * Decimal("1.25") + Decimal(cache_read) * read_factor
    else:
        if cache_read + cache_write > input_tokens or (cache_write_1h is not None and cache_write_1h > cache_write):
            raise ValueError("Invalid provider cache usage breakdown")
        hour_writes = cache_write if cache_write_1h is None else cache_write_1h
        weighted_input = (Decimal(input_tokens - cache_read - cache_write) + Decimal(cache_read) * read_factor
                          + Decimal(cache_write - hour_writes) * Decimal("1.25") + Decimal(hour_writes) * 2)
    return token_cost(weighted_input, output_tokens, input_rate, output_rate)
