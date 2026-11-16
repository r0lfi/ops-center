"""Organized memory end to end against a disposable, migrated PostgreSQL.

Runs only with NOVA_TEST_DATABASE_URL pointing at a database named exactly
ops_nova_test (psycopg URL); never point it at an application database:

    NOVA_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_nova_test?host=/run/pg' \\
      PYTHONPATH=backend:. python -m pytest worker_ai/tests/test_memory_organize_pg.py

The model is a stub; database, locking, routes and worker code are real.
"""
import asyncio
import json
import os
import uuid
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

import pytest

URL = os.environ.get("NOVA_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_nova_test" not in URL, reason="needs NOVA_TEST_DATABASE_URL for ops_nova_test")

PROFILE = """# About me
I live in Springfield with my partner and two children.

# Work
I work as an platform engineer at Sample ASA since October 2026.

# Homelab
My homelab runs three Proxmox nodes with Ceph storage.
Router admin password: aaaaaaaa
"""


def section_of(message):
    """The section the model is asked to organize (the message also holds the existing-memory index)."""
    return message.split("Section to organize:", 1)[-1]


def model_reply(message):
    section_text, memories = section_of(message), []
    if "Springfield" in section_text:
        memories.append({"key": "family.household", "category": "Family & Lifestyle", "scope": "private", "content": "Lives in Springfield with their partner and two children."})
    if "Sample ASA" in section_text:
        memories.append({"key": "career.employer", "category": "Career & Work", "scope": "private", "updates_key": "career.employer",
                         "content": "Platform engineer at Sample ASA since October 2026."})
    if "Proxmox" in section_text:
        memories.append({"key": "homelab.cluster", "category": "Homelab Infrastructure", "scope": "shared", "content": "Three Proxmox nodes with Ceph storage."})
    return json.dumps({"memories": memories})


@pytest.fixture(scope="module")
def env():
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    engine = create_engine(URL)
    async_url = URL.replace("postgresql+psycopg", "postgresql+asyncpg")
    with Session(engine) as db:
        suffix = uuid.uuid4().hex[:8]
        owner = db.execute(text("INSERT INTO users (username, password_hash, role, is_active) VALUES (:u, 'x', 'admin', true) RETURNING id"), {"u": f"owner-{suffix}"}).scalar()
        provider = db.execute(text("INSERT INTO ai_providers (slug, kind, display_name, base_url, default_model, enabled) VALUES (:s, 'openai_compatible', 'Synthetic local', 'http://llm.invalid/v1', 'local', true) RETURNING id"), {"s": f"local-{suffix}"}).scalar()
        nova = db.execute(text("UPDATE ai_agents SET provider_id = :p, enabled = true WHERE slug = 'nova' RETURNING id"), {"p": provider}).scalar()
        coordinator = db.execute(text("SELECT id FROM ai_agents WHERE slug = 'coordinator'")).scalar()
        db.commit()
    yield NS(engine=engine, async_url=async_url, owner=owner, nova=nova, coordinator=coordinator, user=NS(id=owner), Session=Session, AsyncSession=AsyncSession,
             create_async_engine=create_async_engine)
    with Session(engine) as db:
        db.execute(text("DELETE FROM users WHERE id = :o"), {"o": owner})
        db.commit()


def call(env, route, *args):
    async def run():
        engine = env.create_async_engine(env.async_url)
        try:
            async with env.AsyncSession(engine, expire_on_commit=False) as db:  # as app.db.session
                return await route(*args, db, env.user)
        finally:
            await engine.dispose()
    return asyncio.run(run())


def stub_provider():
    from worker_ai.ai.providers.base import ProviderResult
    provider = MagicMock()
    provider.chat.side_effect = lambda **kw: ProviderResult(text=model_reply(kw["messages"][0]["content"]), tool_calls=[], stop_reason="stop",
                                                            assistant_message={}, input_tokens=100, output_tokens=50, usage_reported=True)
    return provider


def organize(env, profile):
    from app.api.routes import memory_organize as routes
    from worker_ai.ai import organize as worker
    with patch.object(routes, "get_celery_client"):
        job = call(env, routes.start_organize, profile, None, "profile.md")
    provider = stub_provider()
    with patch.object(worker, "build_provider", lambda _: provider), env.Session(env.engine) as db:
        assert worker.run_organize(db, job["id"]) == "done"
    sent = " ".join(c.kwargs["messages"][0]["content"] for c in provider.chat.call_args_list)
    assert "aaaaaaaa" not in sent, "credential lines must never reach the provider"
    return call(env, routes.get_organize, job["id"])


def test_profile_to_saved_memories_that_nova_can_recall(env):
    from sqlalchemy import select
    from app.api.routes import memory_organize as routes
    from app.models.ai_memory import AIMemory, AIMemoryVersion
    from worker_ai.ai.memory import note_context, recall
    with env.Session(env.engine) as db:
        db.add(AIMemory(user_id=env.owner, agent_id=env.nova, key="career.employer", content="Works at Example AS.", category="Career & Work"))
        db.commit()
    job = organize(env, PROFILE)
    proposals = {p["key"]: p for p in job["proposals"]}
    assert sum(s["secrets"] for s in job["sections"]) == 1 and job["status"] == "done"
    assert proposals["career.employer"]["action"] == "update" and proposals["career.employer"]["target"]["content"] == "Works at Example AS."
    assert proposals["family.household"]["action"] == "create" and proposals["family.household"]["scope"] == "nova"
    assert proposals["homelab.cluster"]["scope"] == "nova" and proposals["homelab.cluster"]["suggested_scope"] == "shared"
    items = [{"action": p["action"], "key": p["key"], "content": p["content"], "category": p["category"], "kind": p["kind"],
              "scope": "shared" if p["key"] == "homelab.cluster" else p["scope"], "target_id": (p["target"] or {}).get("id")} for p in job["proposals"]]
    assert call(env, routes.apply_organize, job["id"], routes.OrganizeApply(items=items)) == {"created": 2, "updated": 1, "skipped": 0}
    with env.Session(env.engine) as db:
        notes = {n.key: n for n in db.execute(select(AIMemory).where(AIMemory.user_id == env.owner)).scalars()}
        assert notes["career.employer"].content.startswith("Platform engineer") and notes["career.employer"].agent_id == env.nova
        assert notes["homelab.cluster"].agent_id is None and notes["family.household"].agent_id == env.nova
        [version] = db.execute(select(AIMemoryVersion).where(AIMemoryVersion.user_id == env.owner)).scalars().all()
        assert version.content == "Works at Example AS." and version.changed_by == "import"
        task = str(uuid.uuid4())
        found = recall(db, env.owner, task, "Springfield", env.nova, personal=True, category="family & lifestyle")
        assert [n["key"] for n in found["notes"]] == ["family.household"]
        assert recall(db, env.owner, task, "Springfield", env.coordinator)["notes"] == []
        assert [n["key"] for n in recall(db, env.owner, task, "Proxmox", env.coordinator)["notes"]] == ["homelab.cluster"]
        context = note_context(db, env.owner, env.nova, personal=True)
        assert "Memory index" in context and "Family & Lifestyle (1): family.household" in context
        assert "family.household" not in note_context(db, env.owner, env.coordinator)
    again = organize(env, PROFILE)
    assert {p["action"] for p in again["proposals"]} == {"unchanged"}
    call(env, routes.discard_organize, again["id"])


def test_save_all_is_all_or_nothing(env):
    from fastapi import HTTPException
    from sqlalchemy import func, select
    from app.api.routes import memory_organize as routes
    from app.models.ai_memory import AIMemory
    job = organize(env, "# Hobbies\nI sail on weekends in the Springfield area.")
    with env.Session(env.engine) as db:
        before = db.scalar(select(func.count()).select_from(AIMemory).where(AIMemory.user_id == env.owner))
    items = [routes.OrganizeItem(action="create", key="hobby.sailing", content="Sails on weekends.", scope="nova"),
             routes.OrganizeItem(action="create", key="hobby.secret", content="password: aaaaaaaa", scope="nova"),
             routes.OrganizeItem(action="create", key="hobby.sailing", content="Duplicate key.", scope="nova")]
    with pytest.raises(HTTPException) as error:
        call(env, routes.apply_organize, job["id"], routes.OrganizeApply(items=items))
    assert error.value.status_code == 422 and [e["index"] for e in error.value.detail["errors"]] == [1, 2]
    with env.Session(env.engine) as db:
        assert db.scalar(select(func.count()).select_from(AIMemory).where(AIMemory.user_id == env.owner)) == before
    call(env, routes.discard_organize, job["id"])


def test_edit_merge_delete_and_undo(env):
    from fastapi import HTTPException
    from app.api.routes import ai_memory as routes
    call(env, routes.save_memory, routes.MemoryWrite(agent_id=env.nova, key="pref.coffee", content="Black coffee.", category="Lifestyle"))
    call(env, routes.save_memory, routes.MemoryWrite(agent_id=env.nova, key="pref.tea", content="Green tea in the evening."))
    call(env, routes.save_memory, routes.MemoryWrite(key="pref.coffee", content="Shared coffee note."))
    notes = {(n["key"], n["agent_id"]): n for n in call(env, routes.list_memory)["items"]}
    coffee, tea = notes[("pref.coffee", env.nova)], notes[("pref.tea", env.nova)]
    with pytest.raises(HTTPException) as error:
        call(env, routes.edit_memory, coffee["id"], routes.MemoryEdit(agent_id=None))
    assert error.value.status_code == 409
    edited = call(env, routes.edit_memory, coffee["id"], routes.MemoryEdit(content="Black coffee, no sugar.", kind="fact"))
    assert edited["category"] == "Lifestyle" and edited["content"] == "Black coffee, no sugar."
    merged = call(env, routes.merge_memories, routes.MemoryMerge(ids=[coffee["id"], tea["id"]], key="pref.drinks",
                                                                 content="Black coffee in the morning, green tea in the evening.",
                                                                 category="Lifestyle", agent_id=env.nova))
    history = call(env, routes.memory_history, None, True, 50)["items"]
    assert {(v["key"], v["change"]) for v in history} >= {("pref.coffee", "merge"), ("pref.tea", "merge")}
    call(env, routes.delete_memory, merged["id"])
    deleted = next(v for v in call(env, routes.memory_history, None, True, 50)["items"] if v["key"] == "pref.drinks")
    restored = call(env, routes.restore_version, deleted["id"])
    assert restored["key"] == "pref.drinks" and restored["agent_id"] == env.nova
    tea_version = next(v for v in history if v["key"] == "pref.tea")
    assert call(env, routes.restore_version, tea_version["id"])["content"] == "Green tea in the evening."
    assert call(env, routes.memory_duplicates)["pairs"] is not None


def test_conversation_update_suggestion_keeps_history(env):
    from sqlalchemy import select
    from app.api.routes import ai_memory as routes
    from app.models.ai import AITask
    from app.models.ai_memory import AIMemory
    from worker_ai.ai.memory import suggest
    with env.Session(env.engine) as db:
        db.add(AIMemory(user_id=env.owner, agent_id=env.nova, key="career.title", content="Senior engineer.", category="Career & Work"))
        task = AITask(agent_id=env.nova, source="web", owner_user_id=env.owner, input_message="I got promoted", status="completed")
        db.add(task)
        db.commit()
        result = suggest(db, env.owner, str(task.id), "career.title", "Principal engineer since 2026-10.", agent_id=env.nova, replaces_key="career.title")
        assert result["suggested"] and result["updates"] == "career.title"
    pending = [s for s in call(env, routes.list_suggestions, "pending", 200)["items"] if s["key"] == "career.title"]
    assert pending[0]["target"]["content"] == "Senior engineer."
    call(env, routes.accept_suggestion, pending[0]["id"], routes.SuggestionDecision(keep_history=True))
    with env.Session(env.engine) as db:
        notes = {n.key: n for n in db.execute(select(AIMemory).where(AIMemory.user_id == env.owner, AIMemory.key.like("career.title%"))).scalars()}
        assert notes["career.title"].content == "Principal engineer since 2026-10." and notes["career.title"].category == "Career & Work"
        [history_key] = [k for k in notes if ".history." in k]
        assert notes[history_key].content == "Senior engineer." and notes[history_key].kind == "history"


def test_a_failed_section_is_reported_and_retried_alone(env):
    from app.api.routes import memory_organize as routes
    from worker_ai.ai import organize as worker
    from worker_ai.ai.providers import ProviderError
    profile = "# Life\nI live in Springfield.\n\n" + "filler " * 1300 + "\n\n# Lab\nThree Proxmox nodes with Ceph storage."
    with patch.object(routes, "get_celery_client"):
        job = call(env, routes.start_organize, profile, None, "")
    assert len(job["sections"]) == 3  # life, a filler chunk, filler rest + lab
    provider, flaky = stub_provider(), {"fail": True}
    reply = provider.chat.side_effect
    def chat(**kw):
        if "Proxmox" in section_of(kw["messages"][0]["content"]) and flaky.pop("fail", False):
            raise ProviderError("synthetic provider outage")
        return reply(**kw)
    provider.chat.side_effect = chat
    with patch.object(worker, "build_provider", lambda _: provider), env.Session(env.engine) as db:
        assert worker.run_organize(db, job["id"]) == "partial"
    partial = call(env, routes.get_organize, job["id"])
    assert [s["status"] for s in partial["sections"]] == ["done", "done", "failed"] and "outage" in partial["sections"][2]["error"]
    assert [p["key"] for p in partial["proposals"]] == ["family.household"]
    with patch.object(routes, "get_celery_client") as celery:
        call(env, routes.retry_organize, job["id"])
    celery.return_value.send_task.assert_called_once()
    with patch.object(worker, "build_provider", lambda _: provider), env.Session(env.engine) as db:
        assert worker.run_organize(db, job["id"]) == "done"
    assert provider.chat.call_count == 4  # done sections were not analyzed (or paid for) twice
    assert {p["key"] for p in call(env, routes.get_organize, job["id"])["proposals"]} == {"family.household", "homelab.cluster"}
    call(env, routes.discard_organize, job["id"])


def test_a_long_job_continues_in_a_new_task_instead_of_hitting_the_time_limit(env):
    from app.api.routes import memory_organize as routes
    from worker_ai import tasks
    from worker_ai.ai import organize as worker
    with patch.object(routes, "get_celery_client"):
        job = call(env, routes.start_organize, "# Life\nI live in Springfield.\n\n" + "filler " * 1300 + "\n\n# Lab\nProxmox.", None, "long.md")
    assert len(job["sections"]) == 3
    provider = stub_provider()
    fits = iter([False])  # the first task has room for its one guaranteed call only
    with patch.object(worker, "build_provider", lambda _: provider), patch.object(worker, "call_fits", lambda started: next(fits, True)), \
         patch.object(tasks, "SessionLocal", lambda: env.Session(env.engine)), patch.object(tasks.organize_memory, "apply_async") as again:
        assert tasks.organize_memory(str(job["id"])) == "continue"
        again.assert_called_once_with(args=[str(job["id"])], queue="ai")
        state = call(env, routes.get_organize, job["id"])
        assert state["status"] == "running" and [s["status"] for s in state["sections"]].count("done") == 1
        assert tasks.organize_memory(str(job["id"])) == "done"
    assert provider.chat.call_count == len(state["sections"])  # no section was analyzed twice
    call(env, routes.discard_organize, job["id"])


def test_a_failing_section_is_not_retried_by_continuations(env):
    """Each continuation finishes at least one pending section, so a slow failing section cannot loop."""
    from app.api.routes import memory_organize as routes
    from worker_ai import tasks
    from worker_ai.ai import organize as worker
    from worker_ai.ai.providers import ProviderError
    with patch.object(routes, "get_celery_client"):
        job = call(env, routes.start_organize, "# Life\nI live in Springfield.\n\n" + "filler " * 1300 + "\n\n# Lab\nProxmox.", None, "slow.md")
    provider = MagicMock()
    provider.chat.side_effect = ProviderError("OpenAI-compatible API call failed: The read operation timed out")
    with patch.object(worker, "build_provider", lambda _: provider), patch.object(worker, "call_fits", lambda started: False), \
         patch.object(tasks, "SessionLocal", lambda: env.Session(env.engine)), patch.object(tasks.organize_memory, "apply_async"):
        outcomes = [tasks.organize_memory(str(job["id"])) for _ in range(5)]
    assert outcomes[:3] == ["continue", "continue", "failed"] and set(outcomes[3:]) == {"failed"}  # nothing left to try
    assert provider.chat.call_count == 3
    with patch.object(routes, "get_celery_client"):
        retried = call(env, routes.retry_organize, job["id"])
    assert {s["status"] for s in retried["sections"]} == {"pending"}
    call(env, routes.discard_organize, job["id"])


def test_accept_all_saves_each_suggestion_and_reports_the_ones_it_cannot(env):
    from sqlalchemy import select
    from app.api.routes import ai_memory as routes
    from app.models.ai_memory import AIMemory, AIMemorySuggestion, AIMemoryVersion
    with env.Session(env.engine) as db:
        old = AIMemory(user_id=env.owner, agent_id=env.nova, key="home.city", content="Lives in Berlin.")
        db.add(old)
        db.flush()
        rows = [AIMemorySuggestion(user_id=env.owner, agent_id=env.nova, key="hobby.bulk", content="Plays chess.", source="import", status="pending", content_hash=uuid.uuid4().hex),
                AIMemorySuggestion(user_id=env.owner, agent_id=env.nova, key="home.city", content="Lives in Springfield.", source="journal", status="pending", content_hash=uuid.uuid4().hex,
                                   target_memory_id=old.id),
                AIMemorySuggestion(user_id=env.owner, agent_id=env.nova, key="bad key!", content="Invalid key.", source="import", status="pending", content_hash=uuid.uuid4().hex),
                AIMemorySuggestion(user_id=env.owner, agent_id=env.nova, key="hobby.later", content="Arrived after the page loaded.", source="journal", status="pending", content_hash=uuid.uuid4().hex)]
        db.add_all(rows)
        db.commit()
        ids, later, bad, old_id = [r.id for r in rows[:3]], rows[3].id, rows[2].id, old.id
    result = call(env, routes.accept_all_suggestions, routes.AcceptAll(ids=ids))
    assert result["accepted"] == 2 and [(f["id"], f["key"]) for f in result["failed"]] == [(bad, "bad key!")]
    with env.Session(env.engine) as db:
        assert db.scalar(select(AIMemory.content).where(AIMemory.user_id == env.owner, AIMemory.key == "hobby.bulk")) == "Plays chess."
        assert db.get(AIMemory, old_id).content == "Lives in Springfield."
        assert db.scalar(select(AIMemoryVersion.content).where(AIMemoryVersion.memory_id == old_id)) == "Lives in Berlin."
        assert db.get(AIMemorySuggestion, bad).status == "pending" and db.get(AIMemorySuggestion, later).status == "pending"
    assert call(env, routes.accept_all_suggestions, routes.AcceptAll(ids=ids))["accepted"] == 0  # already decided ones are skipped
