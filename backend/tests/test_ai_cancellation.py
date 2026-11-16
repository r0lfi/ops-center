import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.api.routes.ai import cancel_task, get_task


def fake_db(task):
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = task
    db.execute.return_value = result
    return db


@pytest.mark.parametrize("status", ["queued", "running"])
def test_cancel_queued_and_running_task(status):
    task = SimpleNamespace(status=status)
    db = fake_db(task)
    assert asyncio.run(cancel_task("id", db)) is task
    assert task.status == "cancelled"
    assert task.completed_at.tzinfo is not None
    db.commit.assert_awaited_once()


def test_cancel_is_idempotent():
    task = SimpleNamespace(status="cancelled")
    db = fake_db(task)
    assert asyncio.run(cancel_task("id", db)) is task
    db.commit.assert_not_awaited()


@pytest.mark.parametrize("task,code", [(None,404),(SimpleNamespace(status="completed"),409)])
def test_cannot_cancel_missing_or_finished_task(task,code):
    with pytest.raises(HTTPException) as error:
        asyncio.run(cancel_task("id", fake_db(task)))
    assert error.value.status_code == code


@pytest.mark.parametrize("source", ["collaboration", "incident"])
def test_private_task_detail_and_stop_require_owner(source):
    task = SimpleNamespace(source=source, owner_user_id="owner", status="running")
    other = SimpleNamespace(id="other")
    db = fake_db(task)
    db.get.return_value = task
    for endpoint in (cancel_task, get_task):
        with pytest.raises(HTTPException) as error:
            asyncio.run(endpoint("id", db, other))
        assert error.value.status_code == 404
    assert asyncio.run(get_task("id", db, SimpleNamespace(id="owner"))) is task
    db.commit.assert_not_awaited()
