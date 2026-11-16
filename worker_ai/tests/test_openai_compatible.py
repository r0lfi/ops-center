"""Self-hosted OpenAI-compatible endpoints (e.g. a local llama.cpp-style server)."""
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

import pytest

from worker_ai.ai.providers.base import ProviderError
from worker_ai.ai.providers.factory import build_provider
from worker_ai.ai.providers.openai import OpenAICompatibleProvider


def _response(message=None, usage=None):
    response = MagicMock()
    response.json.return_value = {"choices": [{"message": message or {"content": "ok"}, "finish_reason": "stop"}],
                                  "usage": usage or {"prompt_tokens": 900, "completion_tokens": 50}}
    return response


def test_request_uses_portable_subset_and_versioned_base_url():
    tools = [{"name": "list_hosts", "description": "d", "parameters": {"type": "object", "properties": {}}}]
    with patch("worker_ai.ai.providers.openai.post", return_value=_response()) as call:
        result = OpenAICompatibleProvider(base_url="https://llm.example.lan/v1/").chat(
            system="s", messages=[{"role": "user", "content": "hi"}], tools=tools, model="local-model", max_tokens=2048)
    assert call.call_args.args[0] == "https://llm.example.lan/v1/chat/completions"
    body = call.call_args.kwargs["json"]
    assert body["max_tokens"] == 2048 and body["stream"] is False
    assert "service_tier" not in body and "max_completion_tokens" not in body and "reasoning_effort" not in body
    assert body["tools"][0]["function"]["name"] == "list_hosts"
    assert "Authorization" not in call.call_args.kwargs["headers"]
    assert call.call_args.kwargs["timeout"] == OpenAICompatibleProvider.TIMEOUT_SECONDS
    assert result.text == "ok" and result.input_tokens == 900 and result.output_tokens == 50


def test_optional_key_is_sent_as_bearer():
    with patch("worker_ai.ai.providers.openai.post", return_value=_response()) as call:
        OpenAICompatibleProvider(base_url="https://llm.example.lan/v1", api_key="k").chat(
            system="s", messages=[], tools=[], model="m")
    assert call.call_args.kwargs["headers"]["Authorization"] == "Bearer k"


def test_tool_calls_are_parsed_like_openai():
    message = {"content": "", "tool_calls": [{"id": "c1", "type": "function",
                                              "function": {"name": "list_hosts", "arguments": "{}"}}]}
    with patch("worker_ai.ai.providers.openai.post", return_value=_response(message)):
        result = OpenAICompatibleProvider(base_url="https://llm.example.lan/v1").chat(
            system="s", messages=[], tools=[], model="m")
    assert result.stop_reason == "tool_use" and result.tool_calls[0].name == "list_hosts"


def test_factory_needs_base_url_but_no_key():
    row = NS(enabled=True, kind="openai_compatible", base_url="https://llm.example.lan/v1", secret_path=None, slug="local")
    assert isinstance(build_provider(row), OpenAICompatibleProvider)
    with pytest.raises(ProviderError):
        build_provider(NS(enabled=True, kind="openai_compatible", base_url=None, secret_path=None, slug="local"))


def test_external_agents_are_never_executed_by_the_worker():
    from worker_ai.ai.runtime import run_agent
    agent = NS(runtime="external", name="external coder", slug="ext-coder")
    result = run_agent(db=None, agent=agent, input_message="do it")
    assert result.partial and result.stop_reason == "external agent"
