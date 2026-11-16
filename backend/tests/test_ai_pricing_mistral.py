from decimal import Decimal

import pytest

from app.core.ai_pricing import UnknownPrice, rates, reported_cost
from app.models.ai import AI_PROVIDER_KINDS
from app.services.nova_sources import CLOUD_KINDS


def test_mistral_is_a_known_cloud_kind():
    assert "mistral" in AI_PROVIDER_KINDS and "mistral" in CLOUD_KINDS


def test_reviewed_mistral_models_are_priced_without_cache_write_ceiling():
    assert rates("mistral", "mistral-large-4") == (Decimal("0.70"), Decimal("2.10"))
    assert rates("mistral", "mistral-large-4", "https://api.mistral.ai/", ceiling=True) == (Decimal("0.70"), Decimal("2.10"))
    assert rates("mistral", "mistral-small-2603") == (Decimal("0.15"), Decimal("0.60"))


@pytest.mark.parametrize("model,base_url", [
    ("mistral-large-latest", None),  # alias target can change
    ("mistral-small-2603-x", None),
    ("mistral-large-4", "https://proxy.example.lan"),
])
def test_unreviewed_mistral_models_and_endpoints_fail_closed(model, base_url):
    with pytest.raises(UnknownPrice):
        rates("mistral", model, base_url)


def test_mistral_cached_input_costs_a_tenth():
    inp, out = rates("mistral", "mistral-large-4")
    # 1M input of which 500k cached, no output: 500k*0.70 + 500k*0.07
    assert reported_cost("mistral", "mistral-large-4", 1_000_000, 0, inp, out, cache_read=500_000) == Decimal("0.385")
