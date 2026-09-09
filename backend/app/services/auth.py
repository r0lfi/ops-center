from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.core.config import get_settings
from app.models.user import ROLES

_hasher = PasswordHasher()  # argon2id by default

# Admin > operator > viewer, for "at least this role" checks.
_ROLE_RANK = {role: i for i, role in enumerate(ROLES[::-1])}


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def role_at_least(role: str, minimum: str) -> bool:
    return _ROLE_RANK.get(role, -1) >= _ROLE_RANK.get(minimum, 999)


def create_access_token(user_id: str, username: str, role: str) -> str:
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": user_id, "username": username, "role": role, "exp": expire}
    return jwt.encode(payload, settings.api_secret_key, algorithm="HS256")


def decode_access_token(token: str) -> dict | None:
    settings = get_settings()
    try:
        return jwt.decode(token, settings.api_secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
