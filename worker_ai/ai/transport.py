"""Bounded provider retries; retries only explicit throttling/transient server responses."""

import time
from contextlib import contextmanager
from contextvars import ContextVar

import httpx

DEADLINE = ContextVar("agent_deadline", default=None)
BUDGETED_CALL = ContextVar("budgeted_provider_call", default=False)
# Background jobs (journal, import suggestions, Import & Organize) call providers outside
# run_agent, where post() would cap each request at 120 s; a local model can need several
# minutes for one long answer. Background jobs keep their own 1200 s bound (Celery's task_time_limit is higher), so a
# job starts another call only while one more full call still fits in BACKGROUND_TASK_SECONDS
# and otherwise continues in a new task.
BACKGROUND_CALL_SECONDS = 540
BACKGROUND_TASK_SECONDS = 1100


@contextmanager
def deadline(seconds=BACKGROUND_CALL_SECONDS):
    token = DEADLINE.set(time.monotonic() + seconds)
    try:
        yield
    finally:
        DEADLINE.reset(token)


def call_fits(started: float) -> bool:
    """Whether one more background provider call fits in this task (started = time.monotonic())."""
    return time.monotonic() - started + BACKGROUND_CALL_SECONDS <= BACKGROUND_TASK_SECONDS


# A model call needs at least this long to be useful; with less time left, it is
# not started and the run ends with its evidence instead of a timeout.
MIN_CALL_SECONDS = 15


def output_timeout(max_tokens: int) -> float:
    """Read timeout for one provider call, scaled by the output it may produce."""
    return max(60.0, 30.0 + max_tokens / 30.0)


def post(url, **kwargs):
    for attempt in range(1 if BUDGETED_CALL.get() else 2):
        deadline = DEADLINE.get()
        remaining = (deadline - time.monotonic()) if deadline is not None else 120
        if remaining <= 0 or (deadline is not None and remaining < MIN_CALL_SECONDS):
            # Import lazily: the providers package builds adapters that import
            # this transport, while runtime imports transport first.
            from worker_ai.ai.providers.base import ProviderCallNotStarted
            raise ProviderCallNotStarted("Agent time budget exhausted before a provider request was started")
        kwargs["timeout"] = min(float(kwargs.get("timeout", 60)), remaining)
        response = httpx.post(url, **kwargs)
        if response.status_code not in (429, 502, 503, 504) or attempt or BUDGETED_CALL.get():
            return response
        # Never retry an uncertain timeout: the provider may have processed it.
        if remaining < 3:
            return response
        time.sleep(1)
    return response
