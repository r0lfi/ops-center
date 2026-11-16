from worker_ai.ai.providers.anthropic import AnthropicProvider
from worker_ai.ai.providers.base import ToolCall
from worker_ai.ai.providers.ollama import OllamaProvider
from worker_ai.ai.providers.openai import OpenAIProvider


def test_anthropic_tool_result_messages_pairs_by_tool_use_id():
    provider = AnthropicProvider(api_key="unused")
    calls = [ToolCall(id="toolu_1", name="get_disk_usage", arguments={"hostname": "ops-host"})]
    messages = provider.tool_result_messages(calls, ["disk ok"])

    assert len(messages) == 1
    assert messages[0]["role"] == "user"
    assert messages[0]["content"][0]["tool_use_id"] == "toolu_1"
    assert messages[0]["content"][0]["content"] == "disk ok"


def test_openai_tool_result_messages_one_message_per_call():
    provider = OpenAIProvider(api_key="unused")
    calls = [
        ToolCall(id="call_1", name="get_disk_usage", arguments={}),
        ToolCall(id="call_2", name="get_alerts", arguments={}),
    ]
    messages = provider.tool_result_messages(calls, ["a", "b"])

    assert len(messages) == 2
    assert messages[0] == {"role": "tool", "tool_call_id": "call_1", "content": "a"}
    assert messages[1] == {"role": "tool", "tool_call_id": "call_2", "content": "b"}


def test_ollama_tool_result_messages_have_no_call_id_requirement():
    provider = OllamaProvider(base_url="http://ollama:11434")
    calls = [ToolCall(id="call_0", name="get_alerts", arguments={})]
    messages = provider.tool_result_messages(calls, ["no alerts"])

    assert messages == [{"role": "tool", "content": "no alerts"}]


def test_anthropic_normalizes_reported_cache_usage():
    from unittest.mock import MagicMock, patch
    response=MagicMock()
    response.json.return_value={"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn", "usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_1h_input_tokens":100,"ephemeral_5m_input_tokens":200}}}
    with patch("worker_ai.ai.providers.anthropic.post",return_value=response):
        result=AnthropicProvider(api_key="unused").chat(system="test",messages=[],tools=[],model="claude-sonnet-5")
    assert result.usage_reported and result.input_tokens == 600
    assert (result.cache_read_tokens,result.cache_write_tokens,result.cache_write_1h_tokens)==(200,300,100)


def test_openai_normalizes_reported_cache_usage_and_standard_tier():
    from unittest.mock import MagicMock, patch
    response=MagicMock()
    response.json.return_value={"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}], "usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":200,"cache_write_tokens":100}}}
    with patch("worker_ai.ai.providers.openai.post",return_value=response) as call:
        result=OpenAIProvider(api_key="unused").chat(system="test",messages=[],tools=[],model="gpt-5.6-luna")
    assert result.usage_reported and result.input_tokens == 1000
    assert (result.cache_read_tokens,result.cache_write_tokens)==(200,100)
    assert call.call_args.kwargs["json"]["service_tier"] == "default"


def _openai_response(message=None, usage=None):
    from unittest.mock import MagicMock
    response = MagicMock()
    response.json.return_value = {"choices": [{"message": message or {"content": "ok"}, "finish_reason": "stop"}],
        "usage": usage or {"prompt_tokens": 1000, "completion_tokens": 100}}
    return response


def test_reasoning_options_are_model_specific_for_tools_and_plain_requests():
    from unittest.mock import patch
    tool = {"name": "get_alerts", "description": "Read alerts", "parameters": {"type": "object"}}
    for model in ("gpt-4o-mini", "gpt-4.1", "gpt-5.6-luna", "gpt-5.6-luna-2026-09-21"):
        for tools in ([], [tool]):
            with patch("worker_ai.ai.providers.openai.post", return_value=_openai_response()) as call:
                OpenAIProvider("unused").chat(system="test", messages=[], tools=tools, model=model, max_tokens=1500)
            payload = call.call_args.kwargs["json"]
            assert payload["max_completion_tokens"] == 1500 and payload["service_tier"] == "default"
            if model.startswith("gpt-5.6-"):
                assert payload["reasoning_effort"] == "none"
            else:
                assert "reasoning_effort" not in payload


def test_openai_invalid_tool_arguments_preserve_usage_and_never_dispatch_partial_tools():
    from unittest.mock import patch
    for arguments in ('{"hostname":', '[]', 'null'):
        response = _openai_response({"content": "", "tool_calls": [
            {"id": "valid", "function": {"name": "get_alerts", "arguments": "{}"}},
            {"id": "invalid", "function": {"name": "get_alerts", "arguments": arguments}},
        ]})
        with patch("worker_ai.ai.providers.openai.post", return_value=response) as call:
            result = OpenAIProvider("unused").chat(system="test", messages=[], tools=[], model="gpt-5.6-luna")
        assert result.error_message and result.stop_reason == "error" and result.tool_calls == []
        assert result.usage_reported and result.input_tokens == 1000 and result.output_tokens == 100
        call.assert_called_once()


def test_missing_cache_metadata_stays_unknown_and_explicit_zero_is_preserved():
    from unittest.mock import patch
    for details, expected in (({}, None), ({"cache_write_tokens": None}, None), ({"cache_write_tokens": 0}, 0)):
        response = _openai_response(usage={"prompt_tokens": 1000, "completion_tokens": 100, "prompt_tokens_details": details})
        with patch("worker_ai.ai.providers.openai.post", return_value=response):
            result = OpenAIProvider("unused").chat(system="test", messages=[], tools=[], model="gpt-5.6-luna")
        assert result.cache_write_tokens is expected and result.usage_reported


def test_anthropic_standard_tier_short_prompt_cache_and_invalid_content_accounting():
    from unittest.mock import MagicMock, patch
    response = MagicMock()
    response.json.return_value = {"content": [{"type": "tool_use", "id": "tool1", "name": "get_alerts", "input": []}],
        "usage": {"input_tokens": 100, "output_tokens": 20, "cache_creation_input_tokens": 200}}
    with patch("worker_ai.ai.providers.anthropic.post", return_value=response) as call:
        result = AnthropicProvider("unused").chat(system="test", messages=[], tools=[], model="claude-sonnet-5")
    assert call.call_args.kwargs["json"]["service_tier"] == "standard_only"
    assert call.call_args.kwargs["json"]["cache_control"] == {"type": "ephemeral"}
    assert result.error_message and not result.tool_calls and result.usage_reported
    assert result.input_tokens == 300 and result.output_tokens == 20
    assert result.cache_write_tokens == 200 and result.cache_write_1h_tokens is None


def test_transport_proves_pre_http_deadline_but_does_not_reclassify_network_timeout():
    import httpx
    from unittest.mock import patch
    import pytest
    from worker_ai.ai.transport import DEADLINE, post
    from worker_ai.ai.providers.base import ProviderCallNotStarted, ProviderError
    token = DEADLINE.set(0)
    try:
        with patch("worker_ai.ai.transport.httpx.post") as call:
            with pytest.raises(ProviderCallNotStarted):
                post("https://provider")
            call.assert_not_called()
    finally:
        DEADLINE.reset(token)
    with patch("worker_ai.ai.providers.openai.post", side_effect=httpx.ReadTimeout("uncertain")) as call:
        with pytest.raises(ProviderError) as caught:
            OpenAIProvider("unused").chat(system="test", messages=[], tools=[], model="gpt-5.6-luna")
        assert not isinstance(caught.value, ProviderCallNotStarted)
        call.assert_called_once()


def test_fresh_worker_import_can_load_transport_before_provider_package():
    import subprocess
    import sys
    result = subprocess.run([sys.executable, "-B", "-c", "from worker_ai.ai.transport import post; from worker_ai.ai.runtime import run_agent"],
        capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 0, result.stderr


def test_openai_terminal_stop_is_not_hidden_by_complete_tool_calls():
    from unittest.mock import patch
    for reason in ("length", "content_filter"):
        response = _openai_response({"content": "Partial finding", "tool_calls": [
            {"id": "complete", "function": {"name": "get_alerts", "arguments": "{}"}},
        ]})
        response.json.return_value["choices"][0]["finish_reason"] = reason
        with patch("worker_ai.ai.providers.openai.post", return_value=response) as call:
            result = OpenAIProvider("unused").chat(system="test", messages=[], tools=[], model="gpt-4.1")
        assert result.stop_reason == reason and result.text == "Partial finding"
        assert result.usage_reported and result.input_tokens == 1000 and result.output_tokens == 100
        call.assert_called_once()


def test_mistral_request_shape_tool_calls_and_cache_usage():
    from unittest.mock import MagicMock, patch
    from worker_ai.ai.providers.mistral import MistralProvider
    response = MagicMock()
    response.json.return_value = {
        "choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "abc123XYZ", "type": "function", "function": {"name": "get_alerts", "arguments": {"host": "a"}}}]}}],
        "usage": {"prompt_tokens": 500, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 100}},
    }
    tools = [{"name": "get_alerts", "description": "d", "parameters": {"type": "object", "properties": {}}}]
    with patch("worker_ai.ai.providers.mistral.post", return_value=response) as call:
        result = MistralProvider(api_key="unused").chat(system="s", messages=[], tools=tools, model="mistral-large-4", max_tokens=99)
    assert call.call_args.args[0] == "https://api.mistral.ai/v1/chat/completions"
    body = call.call_args.kwargs["json"]
    assert body["max_tokens"] == 99 and "max_completion_tokens" not in body and "service_tier" not in body
    assert body["tools"][0]["function"]["name"] == "get_alerts"
    assert result.stop_reason == "tool_use" and result.tool_calls[0].arguments == {"host": "a"}
    assert result.assistant_message["content"] == ""
    assert result.usage_reported and (result.input_tokens, result.cache_read_tokens, result.cache_write_tokens) == (500, 100, 0)
    assert MistralProvider(api_key="unused").tool_result_messages(result.tool_calls, ["ok"]) == [
        {"role": "tool", "tool_call_id": "abc123XYZ", "name": "get_alerts", "content": "ok"}]


def test_mistral_text_chunks_and_model_length_stop():
    from unittest.mock import MagicMock, patch
    from worker_ai.ai.providers.mistral import MistralProvider
    response = MagicMock()
    response.json.return_value = {
        "choices": [{"finish_reason": "model_length", "message": {"content": [
            {"type": "thinking", "thinking": [{"type": "text", "text": "hidden"}]}, {"type": "text", "text": "answer"}]}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }
    with patch("worker_ai.ai.providers.mistral.post", return_value=response):
        result = MistralProvider(api_key="unused").chat(system="s", messages=[], tools=[], model="mistral-small-2603")
    assert result.text == "answer" and result.stop_reason == "length"


def test_factory_builds_mistral_provider():
    from types import SimpleNamespace
    from unittest.mock import patch
    from worker_ai.ai.providers.factory import build_provider
    from worker_ai.ai.providers.mistral import MistralProvider
    row = SimpleNamespace(enabled=True, kind="mistral", slug="mistral", base_url=None, secret_path="ai/mistral")
    with patch("worker_ai.ai.providers.factory.read_secret", return_value="key"):
        assert isinstance(build_provider(row), MistralProvider)


def test_factory_prefers_encrypted_key_from_database_over_node_local_file():
    from types import SimpleNamespace
    from unittest.mock import patch
    from app.core.provider_keys import encrypt_provider_key
    from worker_ai.ai.providers.factory import build_provider
    row = SimpleNamespace(enabled=True, kind="mistral", slug="mistral", base_url=None, secret_path="ai-providers/mistral.key",
                          encrypted_key=encrypt_provider_key(" db-key \n"))
    with patch("worker_ai.ai.providers.factory.read_secret", side_effect=AssertionError("file must not be read")):
        assert build_provider(row)._api_key == "db-key"


def test_factory_reports_missing_key_file_as_provider_error():
    import pytest
    from types import SimpleNamespace
    from unittest.mock import patch
    from worker_ai.ai.providers.base import ProviderError
    from worker_ai.ai.providers.factory import build_provider
    row = SimpleNamespace(enabled=True, kind="openai", slug="openai", base_url=None, secret_path="ai-providers/openai.key", encrypted_key=None)
    with patch("worker_ai.ai.providers.factory.read_secret", side_effect=FileNotFoundError("gone")):
        with pytest.raises(ProviderError, match="not available on this node"):
            build_provider(row)



def test_tool_call_cut_off_at_output_limit_is_reported_as_such():
    from worker_ai.ai.providers.mistral import MistralProvider, _normalize
    data = {"choices": [{"finish_reason": "model_length", "message": {"content": "", "tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "submit_patch", "arguments": '{"diff": "diff --git a/x'}}]}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 8192}}
    result = MistralProvider("k")._result(_normalize(data))
    assert result.stop_reason == "error" and "output limit" in result.error_message and "8192" in result.error_message
