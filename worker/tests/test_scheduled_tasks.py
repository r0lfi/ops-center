import time
from datetime import datetime

from worker import scheduled_tasks
from worker.scheduled_tasks import _cron_matches_this_minute


def test_cron_matches_the_exact_minute():
    # Monday 15:00
    now = datetime(2026, 8, 31, 15, 0, 0)  # 2026-08-31 is a Monday
    assert _cron_matches_this_minute("0 15 * * 1", now)


def test_cron_does_not_match_a_different_minute():
    now = datetime(2026, 8, 31, 15, 1, 0)
    assert not _cron_matches_this_minute("0 15 * * 1", now)


def test_cron_does_not_match_a_different_day():
    # Tuesday, same time
    now = datetime(2026, 9, 1, 15, 0, 0)
    assert not _cron_matches_this_minute("0 15 * * 1", now)


def test_cron_matches_regardless_of_seconds_within_the_minute():
    now = datetime(2026, 8, 31, 15, 0, 47)
    assert _cron_matches_this_minute("0 15 * * 1", now)


class _Result:
    def __init__(self, rowcount):
        self.rowcount = rowcount


class _FakeDb:
    def __init__(self, counts):
        self.counts = list(counts)
        self.commits = 0

    def execute(self, statement, params):
        return _Result(self.counts.pop(0))

    def commit(self):
        self.commits += 1


def test_prune_stops_after_a_short_batch(monkeypatch):
    monkeypatch.setattr("worker.scheduled_tasks.time.sleep", lambda _: None)
    full = scheduled_tasks._PRUNE_BATCH_ROWS
    db = _FakeDb([full, full, 7])
    removed = scheduled_tasks._prune_in_batches(db, "stmt", {}, time.monotonic() + 60)
    assert removed == full * 2 + 7
    assert db.commits == 3  # Every batch commits, so no transaction grows large.


def test_prune_stops_at_the_deadline(monkeypatch):
    db = _FakeDb([scheduled_tasks._PRUNE_BATCH_ROWS])
    assert scheduled_tasks._prune_in_batches(db, "stmt", {}, time.monotonic() - 1) == 0
    assert db.commits == 0
