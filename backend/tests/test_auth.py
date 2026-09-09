from app.services.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    role_at_least,
    verify_password,
)


def test_password_hash_roundtrip():
    hashed = hash_password("a-real-password-123")
    assert hashed != "a-real-password-123"
    assert verify_password("a-real-password-123", hashed)


def test_password_hash_rejects_wrong_password():
    hashed = hash_password("a-real-password-123")
    assert not verify_password("wrong-password", hashed)


def test_role_at_least_ordering():
    assert role_at_least("admin", "viewer")
    assert role_at_least("admin", "operator")
    assert role_at_least("admin", "admin")
    assert role_at_least("operator", "viewer")
    assert not role_at_least("operator", "admin")
    assert not role_at_least("viewer", "operator")


def test_role_at_least_unknown_role_denied():
    # An unrecognized role (e.g. a stale token after a role enum change)
    # must never satisfy any minimum - fail closed, not open.
    assert not role_at_least("bogus", "viewer")


def test_access_token_roundtrip():
    token = create_access_token("user-id-123", "alice", "operator")
    payload = decode_access_token(token)
    assert payload is not None
    assert payload["sub"] == "user-id-123"
    assert payload["username"] == "alice"
    assert payload["role"] == "operator"
    assert "exp" in payload


def test_decode_rejects_garbage_token():
    assert decode_access_token("not-a-real-token") is None


def test_decode_rejects_tampered_token():
    # Flips the *second-to-last* character, not the last one: HS256's
    # signature is 32 raw bytes, which base64url-encodes with a 2-byte
    # remainder in its final group - the group's last character has 2
    # padding bits that decode to nothing, so a token whose real last
    # character happens to be "A" (~1/16 of the time) can flip to "B"
    # there without changing a single actual signature byte, making the
    # "tampered" token verify as valid and this test flake. One character
    # earlier is always fully meaningful, so it can't have that problem.
    token = create_access_token("user-id-123", "alice", "viewer")
    tampered = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    assert decode_access_token(tampered) is None
