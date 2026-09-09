import pytest

from app.core.config import get_settings
from app.services import ai_secrets


@pytest.fixture()
def isolated_secrets_root(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRETS_ROOT", str(tmp_path))
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def test_write_provider_key_creates_file_with_restrictive_permissions(isolated_secrets_root):
    secret_path = ai_secrets.write_provider_key("anthropic", "sk-ant-test")

    assert secret_path == "ai-providers/anthropic.key"
    written = isolated_secrets_root / "ai-providers" / "anthropic.key"
    assert written.read_text() == "sk-ant-test"
    assert oct(written.stat().st_mode)[-3:] == "600"


def test_write_provider_key_rejects_a_slug_that_escapes_the_directory(isolated_secrets_root):
    with pytest.raises(ValueError):
        ai_secrets.write_provider_key("../../etc/passwd", "sk-whatever")


def test_delete_provider_key_removes_the_file(isolated_secrets_root):
    secret_path = ai_secrets.write_provider_key("openai", "sk-openai-test")
    ai_secrets.delete_provider_key(secret_path)

    assert not (isolated_secrets_root / "ai-providers" / "openai.key").exists()


def test_delete_provider_key_rejects_a_path_outside_the_secrets_root(isolated_secrets_root):
    with pytest.raises(ValueError):
        ai_secrets.delete_provider_key("../outside.txt")
