"""Bounded provider retries; retries only explicit throttling/transient server responses."""

import time
import httpx
from contextvars import ContextVar

DEADLINE = ContextVar("agent_deadline", default=None)


def post(url, **kwargs):
    for attempt in range(2):
        remaining = DEADLINE.get()
        remaining = (remaining - time.monotonic()) if remaining is not None else 120
        if remaining <= 0:
            raise httpx.TimeoutException("Agent time budget exhausted")
        kwargs["timeout"] = min(float(kwargs.get("timeout", 60)), remaining)
        response = httpx.post(url, **kwargs)
        if response.status_code not in (429, 502, 503, 504) or attempt:
            return response
        # Never retry an uncertain timeout: the provider may have processed it.
        if remaining < 3:
            return response
        time.sleep(1)
    return response
