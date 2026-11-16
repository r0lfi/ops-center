"""Nova routines: schedule and content rules, due times, quiet hours and the Talk room."""
import uuid
from datetime import datetime, time, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch

import pytest

from app.core import nova_routines as rules

OWNER, OTHER = uuid.uuid4(), uuid.uuid4()


@pytest.fixture(autouse=True)
def oslo():
    settings = NS(tz="Europe/Berlin",
                  talk_agent_routes=[NS(room_token="novaroom", agent_slug="nova"), NS(room_token="otherroom", agent_slug="nova")],
                  talk_memory_bindings=[NS(room_token="novaroom", user_id=OWNER), NS(room_token="opsroom", user_id=OWNER),
                                        NS(room_token="otherroom", user_id=OTHER)])
    with patch.object(rules, "get_settings", return_value=settings):
        yield settings


def test_schedules_are_five_field_crons_at_most_every_half_hour():
    assert rules.schedule_problem("0 7 * * *") is None and rules.schedule_problem("30 18 * * 0") is None
    assert rules.schedule_problem("*/30 * * * *") is None
    assert rules.schedule_problem("*/10 * * * *") == "Routines run at most every 30 minutes."
    for bad in ("0 7 * *", "0 0 7 * * *", "every morning", "61 7 * * *", None):
        assert rules.schedule_problem(bad).startswith("Use a five-field cron")


def test_routines_never_hold_credentials():
    assert rules.routine_problem("Morning brief", "0 7 * * *", "Summarize my day.") is None
    assert rules.routine_problem("x", "0 7 * * *", "Log in with password: aaaaaaaa") == \
        "Routines cannot contain credentials such as passwords, tokens or private keys."
    assert rules.routine_problem(" ", "0 7 * * *", "fine") and rules.routine_problem("x", "0 7 * * *", "y" * 2001)


def test_due_times_follow_the_local_timezone():
    # 07:00 in Oslo is 06:00 UTC in winter (CET) and 05:00 UTC in summer (CEST).
    winter = datetime(2026, 12, 1, 6, 0, 30, tzinfo=timezone.utc)
    assert rules.latest_due("0 7 * * *", winter) == datetime(2026, 12, 1, 6, 0, tzinfo=timezone.utc)
    assert rules.latest_due("0 7 * * *", datetime(2026, 12, 1, 5, 59, 59, tzinfo=timezone.utc)) == datetime(2026, 11, 30, 6, 0, tzinfo=timezone.utc)
    assert rules.next_due("0 7 * * *", datetime(2026, 7, 1, 4, 0, tzinfo=timezone.utc)) == datetime(2026, 7, 1, 5, 0, tzinfo=timezone.utc)
    assert rules.local_day_start(winter) == datetime(2026, 11, 30, 23, 0, tzinfo=timezone.utc)


def test_quiet_hours_may_span_midnight():
    at = lambda h, m=0: datetime(2026, 12, 1, h, m, tzinfo=timezone.utc)  # noqa: E731 - Oslo is UTC+1 in December
    night = (time(22, 0), time(7, 0))
    assert rules.in_quiet_hours(at(21, 30), *night) and rules.in_quiet_hours(at(2), *night)  # 22:30 and 03:00 local
    assert not rules.in_quiet_hours(at(6), *night) and not rules.in_quiet_hours(at(20, 59), *night)  # 07:00 and 21:59 local
    assert rules.in_quiet_hours(at(12), time(12, 0), time(14, 0)) is True  # 13:00 local
    assert not rules.in_quiet_hours(at(12), time(9, 0), time(9, 0))


def test_talk_room_is_the_one_routed_to_nova_and_bound_to_the_owner():
    assert rules.talk_room(OWNER, "nova") == "novaroom"
    assert rules.talk_room(OTHER, "nova") == "otherroom"
    assert rules.talk_room(uuid.uuid4(), "nova") is None and rules.talk_room(OWNER, "coordinator") is None


def test_routine_runs_never_delegate():
    from app.models.ai import PERSONAL_AGENT_TOOLS, ROUTINE_TOOLS
    assert "dispatch_to_agent" in PERSONAL_AGENT_TOOLS and set(ROUTINE_TOOLS) == {"web_search", "web_fetch"}
