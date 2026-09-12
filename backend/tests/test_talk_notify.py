import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from app.services.talk_watch import notify_once


class Redis:
    def __init__(self):
        self.values = {}

    async def exists(self, key):
        return key in self.values

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    async def eval(self, script, num, key, value):
        if self.values.get(key) == value:
            self.values.pop(key)

    async def aclose(self):
        pass


def test_ha_notifier_deduplicates_parallel_senders():
    async def run():
        redis = Redis()

        async def send(*args):
            await asyncio.sleep(0.01)

        with patch(
            "app.services.talk_watch.get_redis_client", return_value=redis
        ), patch(
            "app.services.talk_watch.send_talk", new=AsyncMock(side_effect=send)
        ) as sent:
            await asyncio.gather(
                notify_once("test", "room", "hello"),
                notify_once("test", "room", "hello"),
            )
            sent.assert_called_once()

    asyncio.run(run())


def test_failed_delivery_can_retry_without_rerunning_agent():
    async def run():
        redis = Redis()
        with patch(
            "app.services.talk_watch.get_redis_client", return_value=redis
        ), patch(
            "app.services.talk_watch.send_talk",
            new=AsyncMock(side_effect=[RuntimeError("offline"), None]),
        ) as sent:
            with pytest.raises(RuntimeError):
                await notify_once("test", "room", "hello")
            await notify_once("test", "room", "hello")
            assert sent.call_count == 2

    asyncio.run(run())


def test_long_answers_are_delivered_in_full():
    async def run():
        redis = Redis()
        message = "x" * 12000
        with patch(
            "app.services.talk_watch.get_redis_client", return_value=redis
        ), patch("app.services.talk_watch.send_talk", new_callable=AsyncMock) as sent:
            await notify_once("long", "room", message)
            assert len(sent.call_args_list) == 3
            assert sum(
                len(c.args[1].split(" ", 1)[1]) for c in sent.call_args_list
            ) == len(message)

    asyncio.run(run())


def test_interactive_delivery_loop_runs_when_proactive_notifications_disabled():
    from types import SimpleNamespace
    from app.services.talk_watch import watch_loop

    async def run():
        with patch(
            "app.services.talk_watch.get_settings",
            return_value=SimpleNamespace(talk_notifications_enabled=False),
        ), patch(
            "app.services.talk_watch.poll_once", new_callable=AsyncMock
        ) as poll, patch(
            "app.services.talk_watch.asyncio.sleep",
            new=AsyncMock(side_effect=asyncio.CancelledError),
        ):
            with pytest.raises(asyncio.CancelledError):
                await watch_loop()
            poll.assert_awaited_once()

    asyncio.run(run())
