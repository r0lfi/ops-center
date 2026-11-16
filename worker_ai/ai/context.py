"""Keep an agent run's model context small and provider-agnostic.

The weekly USD guard (app.services.ai_budget) admits a request only while a
byte-based *upper bound* of its input stays below MAX_INPUT_BOUND. Bytes
over-estimate tokens 3-4x, which is deliberate for cost accounting, so a
run must keep its own history well under that bound instead of growing until
admission refuses it. Two mechanisms do that here:

* cap_tool_output: one tool result never exceeds TOOL_RESULT_CHARS.
* compact_history: once the bound passes COMPACT_AT, older tool results are
  replaced by a short head of their text. The newest round stays intact, so
  the model always sees what it just asked for.
"""
import json

from app.services.ai_budget import MAX_INPUT_BOUND, input_bound

TOOL_RESULT_CHARS = 8000
COMPACT_AT = int(MAX_INPUT_BOUND * 0.55)
_KEPT_HEAD = 500
_MARK = "[trimmed earlier tool result"


def cap_tool_output(text: str, limit: int = TOOL_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return (text[:limit] + f"\n[truncated: {len(text)} characters in total. "
            "Narrow the query (host, time range, search text) for the rest.]")


def _trim(text: str) -> str:
    if not isinstance(text, str) or len(text) <= _KEPT_HEAD + 80 or text.startswith(_MARK):
        return text
    return f"{_MARK}, {len(text)} characters; head follows] " + text[:_KEPT_HEAD]


def _tool_results(message):
    """Yield (container, key) for every tool result string in one message."""
    if message.get("role") == "tool" and isinstance(message.get("content"), str):
        yield message, "content"
    elif message.get("role") == "user" and isinstance(message.get("content"), list):
        for block in message["content"]:
            if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("content"), str):
                yield block, "content"


def compact_history(system: str, messages: list[dict], tools: list[dict], keep_last: int = 1) -> bool:
    """Trim older tool results in place while the request is too large.

    keep_last counts tool-result rounds (one round = the results of one model
    turn). Returns True when anything changed.
    """
    if input_bound(system, messages, tools) <= COMPACT_AT:
        return False
    rounds, previous_was_result = [], False
    for index, message in enumerate(messages):
        is_result = any(True for _ in _tool_results(message))
        if is_result and not previous_was_result:
            rounds.append([])
        if is_result:
            rounds[-1].append(index)
        previous_was_result = is_result
    changed = False
    for round_indexes in rounds[:-keep_last] if keep_last else rounds:
        for index in round_indexes:
            for container, key in _tool_results(messages[index]):
                trimmed = _trim(container[key])
                if trimmed != container[key]:
                    container[key], changed = trimmed, True
        if changed and input_bound(system, messages, tools) <= COMPACT_AT:
            break
    return changed


def call_key(name: str, arguments) -> str:
    return name + ":" + json.dumps(arguments, sort_keys=True, default=str)
