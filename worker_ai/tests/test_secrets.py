import importlib

import pytest


def _reload_secrets_with_root(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRETS_ROOT", str(tmp_path))
    import worker_ai.secrets as secrets_module

    return importlib.reload(secrets_module)


def test_read_secret_returns_stripped_contents(tmp_path, monkeypatch):
    secrets_module = _reload_secrets_with_root(tmp_path, monkeypatch)
    (tmp_path / "ai-providers").mkdir()
    (tmp_path / "ai-providers" / "anthropic.key").write_text("sk-test-123\n")

    assert secrets_module.read_secret("ai-providers/anthropic.key") == "sk-test-123"


def test_read_secret_rejects_path_traversal(tmp_path, monkeypatch):
    secrets_module = _reload_secrets_with_root(tmp_path, monkeypatch)
    (tmp_path.parent / "outside.txt").write_text("nope")

    with pytest.raises(ValueError):
        secrets_module.read_secret("../outside.txt")
