"""Nova phase 4: one-way imports from synthetic memory lists and ChatGPT exports."""
import asyncio
import io
import json
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.api.routes import nova_import as routes
from app.core.memory_rules import KEY_RE
from app.services.nova_import import ImportRejected, conversation_rows, memory_list_rows, parse_memory_list, read_export

OWNER, AGENT = uuid.uuid4(), uuid.uuid4()
LIMITS = {"max_json_bytes": 1024 * 1024, "max_ratio": 200}

MEMORY_LIST = """# What ChatGPT remembers

- Prefers short answers in Norwegian.
- Runs before work,
  usually around 06:30.
- Prefers short answers in Norwegian.
- api_key = synthetic-example-only
1. Works with homelab automation.
- ok
"""


def test_memory_list_bullets_continuations_secrets_and_duplicates():
    parsed = parse_memory_list(MEMORY_LIST)
    assert parsed["items"] == ["Prefers short answers in Norwegian.", "Runs before work, usually around 06:30.", "Works with homelab automation."]
    assert (parsed["filtered_secrets"], parsed["duplicates"], parsed["skipped_short"]) == (1, 1, 1)


def test_memory_list_without_bullets_uses_paragraphs():
    assert parse_memory_list("Likes tea.\nGreen, mostly.\n\nHas a cat.")["items"] == ["Likes tea. Green, mostly.", "Has a cat."]


@pytest.mark.parametrize("source,prefix", [("chatgpt", "chatgpt."), ("claude", "claudeai."), ("gemini", "gemini."), ("other", "imported.")])
def test_memory_list_rows_use_the_source_prefix_and_unique_valid_keys(source, prefix):
    rows = memory_list_rows(OWNER, AGENT, source, parse_memory_list(MEMORY_LIST)["items"])
    assert len(rows) == 3 and len({r["key"] for r in rows}) == 3
    assert all(r["key"].startswith(prefix) and KEY_RE.fullmatch(r["key"]) and r["source"] == "import" and r["agent_id"] == AGENT for r in rows)


def node(node_id, parent, role, text, children=()):
    message = None if role is None else {"author": {"role": role}, "content": {"content_type": "text", "parts": text}, "create_time": 1}
    return node_id, {"id": node_id, "parent": parent, "children": list(children), "message": message}


def conversation(cid, title, nodes, current):
    return {"conversation_id": cid, "title": title, "create_time": 1761379200, "mapping": dict(nodes), "current_node": current}


SYNTHETIC = [
    conversation("c1", "Coffee", [
        node("root", None, None, None, ["u1"]),
        node("u1", "root", "user", ["I drink my coffee black."], ["a-old", "a1"]),
        node("a-old", "u1", "assistant", ["Discarded branch."]),
        node("a1", "u1", "assistant", ["Noted.", {"image": "ignored"}], ["u2"]),
        node("u2", "a1", "user", ["password: aaaaaaaa", "Thanks!"]),
    ], "u2"),
    conversation("c2", "Empty", [node("root", None, None, None)], "root"),
    "not a conversation",
]


def export_zip(files: dict[str, bytes], compression=zipfile.ZIP_DEFLATED) -> io.BytesIO:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    buffer.seek(0)
    return buffer


def test_export_reads_only_expected_files_and_flattens_the_visible_branch():
    upload = export_zip({"conversations.json": json.dumps(SYNTHETIC).encode(), "user.json": b'{"email": "owner@example.invalid"}',
                         "chat.html": b"<html/>", "dalle/image.png": b"x"})
    export = read_export(upload, **LIMITS)
    assert export["has_user_json"] and export["ignored_files"] == 2
    parsed = conversation_rows(OWNER, AGENT, export["conversations"])
    assert parsed["skipped_empty"] == 2 and parsed["filtered_secret_lines"] == 1
    [row] = parsed["rows"]
    assert row["external_id"] == "c1" and row["title"] == "Coffee" and row["started_at"].year == 2025
    assert row["transcript"] == "Owner: I drink my coffee black.\n\nChatGPT: Noted.\n\nOwner: Thanks!"
    assert "Discarded" not in row["transcript"] and "aaaaaaaa" not in row["transcript"]
    assert conversation_rows(OWNER, AGENT, export["conversations"])["rows"][0]["content_hash"] == row["content_hash"]


@pytest.mark.parametrize("upload,message", [
    (io.BytesIO(b"this is not a zip"), "not a readable zip"),
    (export_zip({"user.json": b"{}"}), "No conversations.json"),
    (export_zip({"../conversations.json": b"[]"}), "No conversations.json"),
    (export_zip({"a/conversations.json": b"[]", "b/conversations.json": b"[]"}), "more than one"),
    (export_zip({"conversations.json": b"{not json"}), "not valid JSON"),
    (export_zip({"conversations.json": b'{"a": 1}'}), "list of conversations"),
    (export_zip({"conversations.json": b"[" + b" " * (2 * 1024 * 1024) + b"]"}, zipfile.ZIP_STORED), "larger than the 1 MB limit"),
    (export_zip({"conversations.json": b"[" + b" " * (900 * 1024) + b"]"}), "compressed suspiciously"),
])
def test_export_rejects_broken_oversized_bombs_and_traversal(upload, message):
    with pytest.raises(ImportRejected, match=message):
        read_export(upload, **LIMITS)


def upload_of(data: bytes, name="memory.txt"):
    return SimpleNamespace(file=io.BytesIO(data), filename=name, read=AsyncMock(return_value=data))


def test_upload_limits_and_export_source_are_enforced():
    user, agent = SimpleNamespace(id=OWNER), SimpleNamespace(id=AGENT)
    with patch.object(routes, "get_settings", return_value=SimpleNamespace(nova_import_max_mb=1, nova_import_max_json_mb=1, nova_import_max_ratio=200)):
        for data, kind, source, status in [(b"x" * (1024 * 1024 + 1), "chatgpt_export", "chatgpt", 413),
                                           (b"x" * 10, "chatgpt_export", "gemini", 422)]:
            with pytest.raises(HTTPException) as error:
                asyncio.run(routes._parse(upload_of(data), kind, source, user, agent))
            assert error.value.status_code == status
    with patch.object(routes, "MAX_LIST_BYTES", 5), patch.object(routes, "get_settings", return_value=SimpleNamespace(nova_import_max_mb=1)):
        with pytest.raises(HTTPException) as error:
            asyncio.run(routes._parse(upload_of(b"- long list"), "memory_list", "chatgpt", user, agent))
        assert error.value.status_code == 413


def test_apply_refuses_without_memory_and_updates_only_changed_conversations():
    db = AsyncMock()
    db.execute.return_value = MagicMock(scalar_one_or_none=lambda: SimpleNamespace(id=AGENT), all=lambda: [("c1", "old-hash")])
    db.get.return_value = SimpleNamespace(enabled=False)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.apply_import("chatgpt_export", "chatgpt", upload_of(b""), db, SimpleNamespace(id=OWNER)))
    assert error.value.status_code == 409
    db.get.return_value = None
    parsed = {"kind": "chatgpt_export", "rows": [{"user_id": OWNER, "agent_id": AGENT, "source": "chatgpt", "external_id": "c1", "title": "t",
              "started_at": None, "transcript": "x", "content_hash": "new-hash"}], "filtered_secret_lines": 0, "skipped_empty": 0, "ignored_files": 0, "has_user_json": False}
    with patch.object(routes, "_parse", AsyncMock(return_value=parsed)):
        summary = asyncio.run(routes.apply_import("chatgpt_export", "chatgpt", upload_of(b""), db, SimpleNamespace(id=OWNER)))
    assert (summary["new"], summary["updated"], summary["unchanged"]) == (0, 1, 0)
    upsert = str(db.execute.call_args_list[-1].args[0].compile(dialect=postgresql.dialect()))
    assert "ON CONFLICT ON CONSTRAINT uq_ai_imported_conversation DO UPDATE" in upsert
    assert "WHERE ai_imported_conversations.content_hash != excluded.content_hash" in upsert and "analyzed_at" in upsert


def test_suggest_requires_confirmation_and_delete_is_owner_and_prefix_scoped():
    db = AsyncMock()
    db.execute.return_value = MagicMock(scalar_one_or_none=lambda: SimpleNamespace(id=AGENT), rowcount=2)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.suggest_from_imports(routes.SuggestRequest(confirm=False), db, SimpleNamespace(id=OWNER)))
    assert error.value.status_code == 422
    db.execute.reset_mock()
    asyncio.run(routes.delete_imports("chatgpt", db, SimpleNamespace(id=OWNER)))
    statements = [str(c.args[0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})) for c in db.execute.call_args_list[1:]]
    assert all(str(OWNER) in s for s in statements) and "source = 'chatgpt'" in statements[0]
    assert "LIKE 'chatgpt.' || '%%'" in statements[1] and "LIKE 'chatgpt.' || '%%'" in statements[2]


def test_only_one_export_is_parsed_at_a_time():
    async def run():
        await routes._EXPORT_PARSE.acquire()
        try:
            with patch.object(routes, "get_settings", return_value=SimpleNamespace(nova_import_max_mb=1, nova_import_max_json_mb=1, nova_import_max_ratio=200)):
                await routes._parse(upload_of(b"PK"), "chatgpt_export", "chatgpt", SimpleNamespace(id=OWNER), SimpleNamespace(id=AGENT))
        finally:
            routes._EXPORT_PARSE.release()
    with pytest.raises(HTTPException) as error:
        asyncio.run(run())
    assert error.value.status_code == 429


def test_conversation_count_is_bounded():
    with patch("app.services.nova_import.MAX_CONVERSATIONS", 2):
        with pytest.raises(ImportRejected, match="more than 2 conversations"):
            read_export(export_zip({"conversations.json": json.dumps([{}, {}, {}]).encode()}), **LIMITS)
