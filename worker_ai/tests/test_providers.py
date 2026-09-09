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
