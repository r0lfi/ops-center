import pytest

from app.core.provider_keys import ProviderKeyUnreadable, decrypt_provider_key, encrypt_provider_key


def test_provider_key_round_trip_strips_and_does_not_store_plaintext():
    token = encrypt_provider_key("  secret-value\n")
    assert "secret-value" not in token
    assert decrypt_provider_key(token) == "secret-value"


def test_tampered_or_foreign_token_is_reported_as_unreadable():
    with pytest.raises(ProviderKeyUnreadable):
        decrypt_provider_key(encrypt_provider_key("x")[:-4] + "AAAA")
