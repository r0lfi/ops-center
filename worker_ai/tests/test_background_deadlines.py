"""Background provider calls get a real deadline instead of post()'s 120 s fallback, and jobs continue in a new task."""
import time
import uuid
from datetime import date
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

from worker_ai.ai import journal, transport


def sent_timeout(**kwargs):
    with patch.object(transport.httpx, "post", return_value=NS(status_code=200)) as post:
        transport.post("http://llm.invalid/v1/chat/completions", timeout=600.0, **kwargs)
    return post.call_args.kwargs["timeout"]


def test_background_calls_wait_for_a_slow_local_model():
    assert sent_timeout() == 120  # unchanged outside an agent run or background job
    with transport.deadline():
        assert 530 < sent_timeout() <= transport.BACKGROUND_CALL_SECONDS
    assert transport.DEADLINE.get() is None


def test_another_call_starts_only_while_it_fits_in_the_task():
    now = time.monotonic()
    assert transport.call_fits(now)
    assert not transport.call_fits(now - (transport.BACKGROUND_TASK_SECONDS - transport.BACKGROUND_CALL_SECONDS + 1))
    assert transport.BACKGROUND_TASK_SECONDS < 1200  # worker_ai/celery_app.py task_time_limit


def test_journal_owners_that_do_not_fit_continue_in_a_new_task(monkeypatch):
    nova = NS(id=uuid.uuid4(), slug="nova", provider=object())
    db = MagicMock()
    written = MagicMock(return_value="written, 0 suggestions")
    monkeypatch.setattr(journal, "journal_for", written)
    monkeypatch.setattr(journal, "call_fits", lambda started: False)  # each task still tries one owner
    owners = [uuid.uuid4(), uuid.uuid4()]
    db.execute.return_value.scalars.return_value.all.side_effect = [[nova], owners]
    results = journal.run_journal(db, date(2026, 10, 25))
    assert written.call_count == 1 and results["continue"] == ("2026-10-25", [str(owners[0])])
    from worker_ai import tasks
    with patch.object(tasks, "SessionLocal", MagicMock()), patch("worker_ai.ai.journal.run_journal", return_value=results), \
         patch.object(tasks.nova_journal, "apply_async") as again:
        tasks.nova_journal("2026-10-25")
    again.assert_called_once_with(args=["2026-10-25", [str(owners[0])]], queue="ai")
    # The continuation never retries an owner the run already attempted (even one that failed).
    db.execute.return_value.scalars.return_value.all.side_effect = [[nova], owners]
    monkeypatch.setattr(journal, "call_fits", lambda started: True)
    written.reset_mock()
    results = journal.run_journal(db, date(2026, 10, 25), [str(owners[0])])
    assert [c.args[2] for c in written.call_args_list] == [owners[1]] and "continue" not in results
