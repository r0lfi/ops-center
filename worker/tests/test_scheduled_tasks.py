from datetime import datetime

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
