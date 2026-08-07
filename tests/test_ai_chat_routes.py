"""Tests for the AI chat routes (api.ai_routes).

The suite was rewritten after the LM Studio-specific MCP integration was
refactored into a native MCP server: it now covers the current provider
payload building, response extraction, auto-search fallback, and the
native tool-calling loop.
"""
import asyncio
import json
import sys
from pathlib import Path

import pytest
import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from api.printer_memory_routes import PrinterMemory  # noqa: E402


client = TestClient(app)


class DummyResponse:
    def __init__(self, payload, *, status_code=200, method='POST', url='http://example.test', text=''):
        self._payload = payload
        self.status_code = status_code
        self.request = httpx.Request(method, url)
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('request failed', request=self.request, response=self)

    def json(self):
        return self._payload


class FakeAsyncClient:
    def __init__(self, *, post_handler=None, get_handler=None):
        self._post_handler = post_handler
        self._get_handler = get_handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, json=None):
        if self._post_handler is None:
            raise AssertionError('Unexpected POST request')
        return self._post_handler(url, headers or {}, json)

    async def get(self, url, headers=None):
        if self._get_handler is None:
            raise AssertionError('Unexpected GET request')
        return self._get_handler(url, headers or {})


# ── SYSTEM_PROMPT guardrails ────────────────────────────────────────────


def test_system_prompt_includes_config_and_macro_guardrails():
    assert 'Prefer minimal targeted edits. Preserve unrelated settings, comments, and file structure' in ai_routes.SYSTEM_PROMPT
    assert 'For config edits, return only changed, new, or deleted content in fenced cfg code blocks' in ai_routes.SYSTEM_PROMPT
    assert 'If a macro changes motion or extrusion state, preserve or restore it' in ai_routes.SYSTEM_PROMPT
    assert 'If no safe grounded answer is possible, say what must be verified next instead of guessing.' in ai_routes.SYSTEM_PROMPT


def test_system_prompt_mentions_mini_diff_edit_protocol():
    assert 'emit a mini-diff' in ai_routes.SYSTEM_PROMPT
    assert '-    BED_MESH_CALIBRATE' in ai_routes.SYSTEM_PROMPT
    assert '+    BED_MESH_CALIBRATE ADAPTIVE=1' in ai_routes.SYSTEM_PROMPT


def test_system_prompt_mentions_tools_are_not_gcode_commands():
    assert 'G28' in ai_routes.SYSTEM_PROMPT
    assert 'never wrap them in ```tool blocks' in ai_routes.SYSTEM_PROMPT


# ── _prepare_messages ───────────────────────────────────────────────────


def _blank_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())


# ── _is_edit_request (Phase 3 auto-search gating) ─────────────────────


def test_is_edit_request_positive():
    assert ai_routes._is_edit_request([
        {'role': 'user', 'content': 'Modify my level_bed macro to call BED_MESH_CALIBRATE in adaptive'},
    ])
    assert ai_routes._is_edit_request([
        {'role': 'user', 'content': 'In printer.cfg change the [printer] max_accel to 12000'},
    ])
    assert ai_routes._is_edit_request([
        {'role': 'user', 'content': 'Add a [bed_mesh] section to my config'},
    ])
    assert ai_routes._is_edit_request([
        {'role': 'user', 'content': 'Delete the RESET_ACCEL macro'},
    ])


def test_is_edit_request_negative():
    assert not ai_routes._is_edit_request([
        {'role': 'user', 'content': 'What does horizontal_move_z do?'},
    ])
    assert not ai_routes._is_edit_request([
        {'role': 'user', 'content': 'What is the default value of pressure_advance?'},
    ])
    assert not ai_routes._is_edit_request([
        {'role': 'user', 'content': 'Help me set up my new printer from scratch'},
    ])


def test_is_edit_request_uses_latest_user_message():
    # The decision is based on the latest user message, not older context.
    assert not ai_routes._is_edit_request([
        {'role': 'user', 'content': 'Change my max_accel'},
        {'role': 'assistant', 'content': 'Done.'},
        {'role': 'user', 'content': 'What is pressure advance?'},
    ])


def test_auto_search_enabled_toggle(monkeypatch):
    monkeypatch.delenv('KWC_AUTO_SEARCH', raising=False)
    assert not ai_routes._auto_search_enabled()  # default disabled (Phase 3 A/B)
    monkeypatch.setenv('KWC_AUTO_SEARCH', '1')
    assert ai_routes._auto_search_enabled()
    monkeypatch.setenv('KWC_AUTO_SEARCH', '0')
    assert not ai_routes._auto_search_enabled()


def test_config_fallback_enabled_toggle(monkeypatch):
    # Default disabled (Phase 5 lean first pass).
    monkeypatch.delenv('KWC_CONFIG_FALLBACK', raising=False)
    assert not ai_routes._config_fallback_enabled()
    monkeypatch.setenv('KWC_CONFIG_FALLBACK', '1')
    assert ai_routes._config_fallback_enabled()
    monkeypatch.setenv('KWC_CONFIG_FALLBACK', '0')
    assert not ai_routes._config_fallback_enabled()


def test_minimal_prompt_enabled_toggle(monkeypatch):
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    assert not ai_routes._minimal_prompt_enabled()
    monkeypatch.setenv('KWC_MINIMAL_PROMPT', '1')
    assert ai_routes._minimal_prompt_enabled()


def test_no_system_prompt_enabled_toggle(monkeypatch):
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    assert not ai_routes._no_system_prompt_enabled()
    monkeypatch.setenv('KWC_NO_SYSTEM', '1')
    assert ai_routes._no_system_prompt_enabled()


def test_prepare_messages_no_system_sends_conversation_only(monkeypatch):
    # Experiment gate: no system content at all — just the conversation.
    monkeypatch.setenv('KWC_NO_SYSTEM', '1')
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    msgs = ai_routes._prepare_messages([{'role': 'user', 'content': 'hello'}])

    assert all(m['role'] != 'system' for m in msgs)
    assert len(msgs) == 1
    assert msgs[0]['content'] == 'hello'


def test_prepare_messages_minimal_prompt_sends_tools_only(monkeypatch):
    # Experiment gate: system message = tool list only, no SYSTEM_PROMPT,
    # no printer memory, no auto-fill, no task anchor.
    monkeypatch.setenv('KWC_MINIMAL_PROMPT', '1')
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    msgs = ai_routes._prepare_messages([{'role': 'user', 'content': 'hello'}])

    system_msgs = [m for m in msgs if m['role'] == 'system']
    assert len(system_msgs) == 1
    system = system_msgs[0]['content']
    assert ai_routes.SYSTEM_PROMPT not in system
    assert 'Available Tools' in system
    assert 'read_user_config' in system
    assert 'Printer Memory' not in system
    assert 'Auto-Fill' not in system
    assert 'current task' not in system


def test_prepare_messages_starts_with_system_and_ends_with_task_anchor(monkeypatch):
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'Explain pressure advance.'},
    ])
    assert prepared[0]['role'] == 'system'
    assert ai_routes.SYSTEM_PROMPT in prepared[0]['content']
    assert '# Available Tools' in prepared[0]['content']
    assert prepared[-1]['role'] == 'system'
    assert 'latest (last) message' in prepared[-1]['content']
    assert prepared[-2] == {'role': 'user', 'content': 'Explain pressure advance.'}


def test_prepare_messages_includes_blank_memory_auto_fill(monkeypatch):
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    assert 'Printer Memory Auto-Fill' in prepared[0]['content']
    assert 'printer-memory' in prepared[0]['content']


def test_prepare_messages_drops_empty_messages(monkeypatch):
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': '  '},
        {'role': 'user', 'content': 'Real question'},
    ])
    user_messages = [m for m in prepared if m['role'] == 'user']
    assert user_messages == [{'role': 'user', 'content': 'Real question'}]


def test_prepare_messages_keeps_custom_system_message(monkeypatch):
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([
        {'role': 'system', 'content': 'Custom instruction.'},
        {'role': 'user', 'content': 'hi'},
    ])
    assert 'Custom instruction.' in prepared[0]['content']


# ── _build_provider_payload ─────────────────────────────────────────────


def test_build_provider_payload_openai_compatible():
    payload = ai_routes._build_provider_payload(
        'chatgpt',
        [{'role': 'user', 'content': 'hi'}],
        'gpt-4o',
    )
    assert payload == {
        'model': 'gpt-4o',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'temperature': 0.1,
        'max_tokens': 4096,
    }


def test_build_provider_payload_openai_merges_system_messages():
    # Strict chat templates (e.g. ones that enforce "system message must be
    # at the beginning") reject multiple system messages. When merge_system
    # is set, the OpenAI-compatible builder must merge them into a single
    # leading system message so every server accepts the payload.
    payload = ai_routes._build_provider_payload(
        'chatgpt',
        [
            {'role': 'system', 'content': 'System one.'},
            {'role': 'user', 'content': 'hi'},
            {'role': 'system', 'content': 'System two.'},
        ],
        'gpt-4o',
        merge_system=True,
    )
    assert payload['model'] == 'gpt-4o'
    assert payload['messages'] == [
        {'role': 'system', 'content': 'System one.\n\nSystem two.'},
        {'role': 'user', 'content': 'hi'},
    ]
    assert payload['max_tokens'] == 4096


def test_build_provider_payload_openai_keeps_multiple_system_messages_by_default():
    # Default (merge_system=False) must preserve the trailing task anchor
    # as its own system message — it is positionally meaningful for models
    # whose chat templates accept multiple system messages.
    payload = ai_routes._build_provider_payload(
        'chatgpt',
        [
            {'role': 'system', 'content': 'System one.'},
            {'role': 'user', 'content': 'hi'},
            {'role': 'system', 'content': 'System two.'},
        ],
        'gpt-4o',
    )
    assert payload['messages'] == [
        {'role': 'system', 'content': 'System one.'},
        {'role': 'user', 'content': 'hi'},
        {'role': 'system', 'content': 'System two.'},
    ]


def test_build_provider_payload_anthropic_merges_system_messages():
    payload = ai_routes._build_provider_payload(
        'anthropic',
        [
            {'role': 'system', 'content': 'System one.'},
            {'role': 'user', 'content': 'hi'},
            {'role': 'system', 'content': 'System two.'},
        ],
        'claude-sonnet',
    )
    assert payload['model'] == 'claude-sonnet'
    assert payload['system'] == 'System one.\n\nSystem two.'
    assert payload['messages'] == [{'role': 'user', 'content': 'hi'}]
    assert payload['max_tokens'] == 4096


def test_build_provider_payload_openai_with_tools():
    tools = [{'type': 'function', 'function': {'name': 'lookup', 'description': 'd', 'parameters': {}}}]
    payload = ai_routes._build_provider_payload(
        'chatgpt',
        [{'role': 'user', 'content': 'hi'}],
        'gpt-4o',
        tools=tools,
    )
    assert payload['tools'] == tools


def test_build_provider_payload_openai_honors_temperature():
    payload = ai_routes._build_provider_payload(
        'chatgpt',
        [{'role': 'user', 'content': 'hi'}],
        'gpt-4o',
        temperature=0.7,
    )
    assert payload['temperature'] == 0.7
    assert payload['max_tokens'] == 4096


def test_build_provider_payload_anthropic_includes_temperature_when_set():
    payload = ai_routes._build_provider_payload(
        'anthropic',
        [{'role': 'user', 'content': 'hi'}],
        'claude-sonnet',
        temperature=0.5,
    )
    assert payload['temperature'] == 0.5
    assert payload['max_tokens'] == 4096


def test_build_provider_payload_anthropic_omits_temperature_by_default():
    # Preserve historical behavior: Anthropic's own default applies when the
    # client does not send a temperature.
    payload = ai_routes._build_provider_payload(
        'anthropic',
        [{'role': 'user', 'content': 'hi'}],
        'claude-sonnet',
    )
    assert 'temperature' not in payload
    assert payload['max_tokens'] == 4096


def test_build_provider_payload_anthropic_flattens_tools():
    tools = [{'type': 'function', 'function': {'name': 'lookup', 'description': 'd', 'parameters': {}}}]
    payload = ai_routes._build_provider_payload(
        'anthropic',
        [{'role': 'user', 'content': 'hi'}],
        'claude-sonnet',
        tools=tools,
    )
    assert payload['tools'] == [{
        'name': 'lookup',
        'description': 'd',
        'input_schema': {},
    }]


# ── _query_provider ─────────────────────────────────────────────────────


def test_query_provider_extracts_openai_content():
    def fake_post(url, headers, payload):
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z is the Z hop.'}}]},
            url=url,
        )

    content, data = asyncio.run(ai_routes._query_provider(
        FakeAsyncClient(post_handler=fake_post),
        'http://localhost:1234/v1/chat/completions',
        {},
        {},
        'chatgpt',
    ))
    assert content == 'horizontal_move_z is the Z hop.'
    assert data['choices'][0]['message']['content'] == 'horizontal_move_z is the Z hop.'


def test_query_provider_extracts_anthropic_content():
    def fake_post(url, headers, payload):
        return DummyResponse(
            {'content': [{'type': 'text', 'text': 'Anthropic answer.'}]},
            url=url,
        )

    content, _ = asyncio.run(ai_routes._query_provider(
        FakeAsyncClient(post_handler=fake_post),
        'https://api.anthropic.com/v1/messages',
        {},
        {},
        'anthropic',
    ))
    assert content == 'Anthropic answer.'


def test_query_provider_empty_content_returns_empty():
    # A literal empty completion (llama.cpp transient hiccup) must come back
    # as an empty string, not an exception — the chat handler's backstop
    # re-prompts without tools and recovers.
    def fake_post(url, headers, payload):
        return DummyResponse(
            {'choices': [{'message': {'content': ''}}], 'error': None},
            url=url,
        )

    content, data = asyncio.run(ai_routes._query_provider(
        FakeAsyncClient(post_handler=fake_post),
        'http://localhost:1234/v1/chat/completions',
        {},
        {},
        'chatgpt',
    ))
    assert content == ''
    assert data['choices'][0]['message']['content'] == ''


def test_query_provider_api_error_raises_value_error():
    def fake_post(url, headers, payload):
        return DummyResponse(
            {'error': {'message': 'Model not found'}},
            url=url,
        )

    with pytest.raises(ValueError, match='Model not found'):
        asyncio.run(ai_routes._query_provider(
            FakeAsyncClient(post_handler=fake_post),
            'http://localhost:1234/v1/chat/completions',
            {},
            {},
            'chatgpt',
        ))


def test_query_provider_stop_event_raises_chat_stopped():
    stop_event = asyncio.Event()
    stop_event.set()

    def fake_post(url, headers, payload):
        raise AssertionError('request should not be sent after stop')

    with pytest.raises(ai_routes.ChatStoppedError):
        asyncio.run(ai_routes._query_provider(
            FakeAsyncClient(post_handler=fake_post),
            'http://localhost:1234/v1/chat/completions',
            {},
            {},
            'chatgpt',
            stop_event=stop_event,
        ))


# ── _build_api_base_url / extraction helpers ────────────────────────────


def test_build_api_base_url():
    assert ai_routes._build_api_base_url('http://localhost:1234/v1/chat/completions') == 'http://localhost:1234'
    assert ai_routes._build_api_base_url('https://api.openai.com/v1/chat/completions') == 'https://api.openai.com'
    assert ai_routes._build_api_base_url('') == ''


def test_is_local_provider():
    # Local OpenAI-compatible servers use plain http.
    assert ai_routes._is_local_provider('openai-compatible', 'http://192.168.1.133:8080/v1/chat/completions') is True
    assert ai_routes._is_local_provider('openai-compatible', 'http://localhost:11434/v1/chat/completions') is True
    # Cloud OpenAI-compatible APIs (DeepSeek, OpenRouter, ...) are https and
    # get the cloud treatment: required API key + native function calling.
    assert ai_routes._is_local_provider('openai-compatible', 'https://api.deepseek.com/v1/chat/completions') is False
    assert ai_routes._is_local_provider('openai-compatible', 'HTTPS://api.deepseek.com/v1/chat/completions') is False
    # Other providers are never local.
    assert ai_routes._is_local_provider('chatgpt', 'http://localhost:1234/v1/chat/completions') is False
    assert ai_routes._is_local_provider('chatgpt') is False
    # Blank URL defaults to local treatment (backward compatible).
    assert ai_routes._is_local_provider('openai-compatible') is True


def test_resolve_native_tools_auto_split():
    # "auto" keeps the provider-based split: local http -> text protocol,
    # cloud https -> native function calling.
    assert ai_routes._resolve_native_tools(
        'openai-compatible', 'http://192.168.1.133:8080/v1/chat/completions', 'auto',
    ) is None
    tools = ai_routes._resolve_native_tools(
        'openai-compatible', 'https://api.deepseek.com/v1/chat/completions', 'auto',
    )
    assert tools is not None
    assert {t['function']['name'] for t in tools} >= {'search_klipper_docs'}


def test_resolve_native_tools_force_native_for_local():
    # "native" unlocks local llama.cpp servers (gpt-oss needs native tools).
    tools = ai_routes._resolve_native_tools(
        'openai-compatible', 'http://192.168.1.133:8080/v1/chat/completions', 'native',
    )
    assert tools is not None
    assert {t['function']['name'] for t in tools} >= {'search_klipper_docs'}


def test_resolve_native_tools_force_text_for_cloud():
    # "text" forces the text protocol even for cloud endpoints.
    assert ai_routes._resolve_native_tools(
        'openai-compatible', 'https://api.deepseek.com/v1/chat/completions', 'text',
    ) is None


def test_extract_provider_content():
    assert ai_routes._extract_provider_content('chatgpt', {'choices': [{'message': {'content': 'x'}}]}) == 'x'
    assert ai_routes._extract_provider_content('anthropic', {'content': [{'text': 'y'}]}) == 'y'
    assert ai_routes._extract_provider_content('chatgpt', {}) == ''


def test_extract_api_error_message():
    assert ai_routes._extract_api_error_message({'error': {'message': 'boom'}}) == 'boom'
    assert ai_routes._extract_api_error_message({'error': 'simple'}) == 'simple'
    assert ai_routes._extract_api_error_message({'choices': []}) is None


# ── chat proxy endpoints ────────────────────────────────────────────────


def test_chat_proxy_requires_api_key_for_remote_provider():
    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Explain pressure advance.'}],
            'apiKey': '',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        'error': 'AI settings not configured. Please configure your API key in settings.'
    }


def test_chat_proxy_cloud_openai_compatible_requires_api_key():
    # Cloud OpenAI-compatible endpoints (https) must carry an API key, just
    # like the other cloud providers.
    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Explain pressure advance.'}],
            'apiKey': '',
            'model': 'deepseek-chat',
            'apiUrl': 'https://api.deepseek.com/v1/chat/completions',
            'apiProvider': 'openai-compatible',
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        'error': 'AI settings not configured. Please configure your API key in settings.'
    }


def test_chat_proxy_local_openai_compatible_allows_missing_key(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    captured = {}

    def fake_post(url, headers, payload):
        captured['url'] = url
        captured['headers'] = headers
        return DummyResponse(
            {'choices': [{'message': {'content': 'LM Studio answer.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'apiKey': '',
            'model': 'gemma-4-12b',
            'apiUrl': 'http://192.168.1.133:8080/v1/chat/completions',
            'apiProvider': 'openai-compatible',
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        'content': 'LM Studio answer.',
        'mcpToolTurns': 0,
        'mcpToolNames': [],
        'toolCalls': [],
        'repromptCount': 0,
    }
    # The local URL is POSTed verbatim and no Authorization header is added
    # when no key was provided.
    assert captured['url'] == 'http://192.168.1.133:8080/v1/chat/completions'
    assert 'Authorization' not in captured['headers']


def test_chat_proxy_local_native_tool_protocol_sends_tools(monkeypatch):
    # toolProtocol="native" forces the OpenAI tools array even for a local
    # plain-http provider (gpt-oss on llama.cpp needs this).
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    captured = {}

    def fake_post(url, headers, payload):
        captured['payload'] = payload
        return DummyResponse(
            {'choices': [{'message': {'content': 'LM Studio answer.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'apiKey': '',
            'model': 'gpt-oss-20b',
            'apiUrl': 'http://192.168.1.133:8080/v1/chat/completions',
            'apiProvider': 'openai-compatible',
            'toolProtocol': 'native',
        },
    )

    assert response.status_code == 200
    tools = captured['payload'].get('tools')
    assert tools is not None
    assert {t['function']['name'] for t in tools} >= {'search_klipper_docs'}


def test_chat_proxy_local_default_tool_protocol_sends_no_tools(monkeypatch):
    # Default ("auto") keeps the text protocol for local providers: no tools
    # array in the outgoing payload.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    captured = {}

    def fake_post(url, headers, payload):
        captured['payload'] = payload
        return DummyResponse(
            {'choices': [{'message': {'content': 'LM Studio answer.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'apiKey': '',
            'model': 'gemma-4-12b',
            'apiUrl': 'http://192.168.1.133:8080/v1/chat/completions',
            'apiProvider': 'openai-compatible',
        },
    )

    assert response.status_code == 200
    assert 'tools' not in captured['payload']


def test_chat_proxy_returns_plain_content(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    def fake_post(url, headers, payload):
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z is the Z hop before XY travel.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        'content': 'horizontal_move_z is the Z hop before XY travel.',
        'mcpToolTurns': 0,
        'mcpToolNames': [],
        'toolCalls': [],
        'repromptCount': 0,
    }


def test_chat_proxy_auto_search_fallback_injects_docs(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    # The fallback is off by default (Phase 3 A/B) — this test exercises the
    # injection path with the toggle explicitly enabled.
    monkeypatch.setenv('KWC_AUTO_SEARCH', '1')
    monkeypatch.setattr(
        ai_routes,
        '_auto_search_context',
        lambda query: 'From Probes.md (score 1.2):\n- horizontal_move_z is a bed_mesh safety travel height.',
    )

    captured = {'count': 0}

    def fake_post(url, headers, payload):
        captured['count'] += 1
        # First call: model gives a plain (ungrounded) answer -> fallback triggers.
        if captured['count'] == 1:
            return DummyResponse(
                {'choices': [{'message': {'content': 'I think it controls Z travel.'}}]},
                url=url,
            )
        # Second call: model answers after the docs were injected.
        captured['second_payload'] = payload
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z is the Z hop before XY travel.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'horizontal_move_z is the Z hop before XY travel.'
    assert body['mcpToolTurns'] == 1
    assert body['mcpToolNames'] == ['search_klipper_docs']
    # The injected docs must appear as a user-role tool result message in the second payload.
    second_payload = captured['second_payload']
    assert any('[Tool result: search_klipper_docs' in str(m.get('content', '')) for m in second_payload['messages'])


def test_chat_proxy_native_tool_call_loop(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) == 1:
            # First response: native tool call, no text content.
            return DummyResponse(
                {
                    'choices': [{
                        'message': {
                            'content': None,
                            'tool_calls': [{
                                'type': 'function',
                                'id': 'call_1',
                                'function': {'name': 'search_klipper_docs', 'arguments': '{"query": "bed_mesh"}'},
                            }],
                        }
                    }]
                },
                url=url,
            )
        # Second response: final answer after the tool result is fed back.
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z sets the Z hop before XY travel.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'horizontal_move_z sets the Z hop before XY travel.'
    assert body['mcpToolTurns'] == 1
    assert body['mcpToolNames'] == ['search_klipper_docs']
    # The client-facing tool call detail must carry name, arguments, and output.
    assert body['toolCalls'] == [{
        'name': 'search_klipper_docs',
        'arguments': json.dumps({'query': 'bed_mesh'}, sort_keys=True),
        'output': 'result for search_klipper_docs',
        'outputTruncated': False,
    }]
    # The second request must carry the assistant tool_calls echo plus a tool result.
    second_payload = calls[1]
    roles = [m['role'] for m in second_payload['messages']]
    assert 'tool' in roles
    assistant_msg = [m for m in second_payload['messages'] if m['role'] == 'assistant'][-1]
    assert assistant_msg['tool_calls'][0]['function']['name'] == 'search_klipper_docs'


def test_chat_proxy_dsml_text_protocol_tool_loop(monkeypatch):
    # DeepSeek V3.2/V4 sometimes returns its native DSML tool-call markup as
    # plain text in message.content instead of structured tool_calls. The
    # backend must parse it, execute the tool, and keep the markup out of the
    # visible reply.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) == 1:
            # First response: DSML tool call only, no visible text.
            return DummyResponse(
                {
                    'choices': [{
                        'message': {
                            'content': (
                                '<||DSML||tool_calls> '
                                '<||DSML||invoke name="search_klipper_docs"> '
                                '<||DSML||parameter name="query" string="true">bed_mesh adaptive</||DSML||parameter> '
                                '</||DSML||invoke> '
                                '</||DSML||tool_calls>'
                            ),
                        }
                    }]
                },
                url=url,
            )
        # Second response: final answer.
        return DummyResponse(
            {'choices': [{'message': {'content': 'BED_MESH_CALIBRATE ADAPTIVE=1 probes the print area.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Make my level bed macro adaptive.'}],
            'apiKey': 'deepseek-test-key',
            'model': 'deepseek-chat',
            'apiUrl': 'https://api.deepseek.com/v1/chat/completions',
            'apiProvider': 'openai-compatible',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'BED_MESH_CALIBRATE ADAPTIVE=1 probes the print area.'
    assert body['mcpToolTurns'] == 1
    assert body['mcpToolNames'] == ['search_klipper_docs']
    # The DSML markup must not leak into any assistant message sent onward.
    second_payload = calls[1]
    assert any('[Tool result: search_klipper_docs' in str(m.get('content', '')) for m in second_payload['messages'])
    assert not any('DSML' in str(m.get('content', '')) for m in second_payload['messages'])


def test_chat_proxy_empty_reprompt_executes_xml_calls(monkeypatch):
    # DeepSeek flash: 5 native tool turns with no text, then the empty
    # re-prompt (sent WITHOUT tools) still returns a bare <tool_calls> XML
    # block. The backend must execute those calls and keep the markup out of
    # the visible reply instead of surfacing raw XML or the fallback message.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        n = len(calls)
        if n <= 6:
            # Initial call + 5 native tool turns, all tool-only.
            return DummyResponse(
                {
                    'choices': [{
                        'message': {
                            'content': None,
                            'tool_calls': [{
                                'type': 'function',
                                'id': f'call_{n}',
                                'function': {'name': 'search_klipper_docs', 'arguments': '{"query": "bed_mesh"}'},
                            }],
                        }
                    }]
                },
                url=url,
            )
        if n == 7:
            # Empty re-prompt: model ignores no-tools and emits XML markup.
            return DummyResponse(
                {
                    'choices': [{
                        'message': {
                            'content': (
                                '<tool_calls>\n'
                                '<invoke name="search_klipper_docs">\n'
                                '<parameter name="query" string="true">bed_mesh adaptive</parameter>\n'
                                '</invoke>\n'
                                '</tool_calls>'
                            ),
                        }
                    }]
                },
                url=url,
            )
        # Second re-prompt: real answer.
        return DummyResponse(
            {'choices': [{'message': {'content': 'BED_MESH_CALIBRATE probes the print area in adaptive mode.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Make my level bed macro adaptive.'}],
            'apiKey': 'deepseek-test-key',
            'model': 'deepseek-v4-flash',
            'apiUrl': 'https://api.deepseek.com/v1/chat/completions',
            'apiProvider': 'openai-compatible',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'BED_MESH_CALIBRATE probes the print area in adaptive mode.'
    assert body['mcpToolTurns'] >= 6
    assert 'search_klipper_docs' in body['mcpToolNames']
    # No raw XML markup anywhere in the messages sent onward.
    assert not any('<tool_calls>' in str(m.get('content', '')) for m in calls[-1]['messages'])


# ── Empty-response re-prompt backstop ──────────────────────────────────
# When a model ends its turn with only a tool call and no visible text,
# the backend re-prompts without tools so the UI doesn't show "No response."


def test_chat_proxy_empty_response_reprompt_recovers(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(
        ai_routes, '_execute_tool_call',
        lambda call: f"result for {call['name']}",
    )
    max_turns = ai_routes.MAX_MCP_TOOL_TURNS

    # The llama.cpp/Qwen-style tool-only response from the real failure log.
    tool_only = (
        '<|tool_call>call:tool_call:get_config_reference_section'
        '{section_name: "bed_mesh"}<tool_call|>'
    )
    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) <= max_turns + 1:
            # Initial call + MAX tool-turn re-queries: tool-only, no text.
            return DummyResponse(
                {'choices': [{'message': {'content': tool_only}}]},
                url=url,
            )
        # The empty-response re-prompt (tools disabled) finally yields text.
        return DummyResponse(
            {'choices': [{'message': {
                'content': 'horizontal_move_z sets the Z hop before XY travel.',
            }}]},
            url=url,
        )

    monkeypatch.setattr(
        httpx, 'AsyncClient',
        lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post),
    )

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user',
                          'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'horizontal_move_z sets the Z hop before XY travel.'
    assert body['mcpToolTurns'] == max_turns
    assert 'get_config_reference_section' in body['mcpToolNames']
    # 1 initial + MAX tool turns + 1 empty re-prompt = MAX + 2 provider calls.
    assert len(calls) == max_turns + 2
    # The re-prompt payload must disable tools and carry the direct-answer instruction.
    reprompt = calls[max_turns + 1]
    assert 'tools' not in reprompt
    assert any(
        m.get('role') == 'system' and 'Do not call any tools' in m.get('content', '')
        for m in reprompt['messages']
    )


def test_chat_proxy_empty_response_reprompt_exhausts(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(
        ai_routes, '_execute_tool_call',
        lambda call: f"result for {call['name']}",
    )
    max_turns = ai_routes.MAX_MCP_TOOL_TURNS

    tool_only = (
        '<|tool_call>call:tool_call:get_config_reference_section'
        '{section_name: "bed_mesh"}<tool_call|>'
    )
    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        # Every response — including both re-prompts — is tool-only.
        return DummyResponse(
            {'choices': [{'message': {'content': tool_only}}]},
            url=url,
        )

    monkeypatch.setattr(
        httpx, 'AsyncClient',
        lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post),
    )

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user',
                          'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    # Backstop: never surface a blank bubble — return an explicit fallback so
    # the UI doesn't show "No response."
    assert body['content'] == (
        "I wasn't able to generate a response. "
        "Please try rephrasing your question."
    )
    # MAX main tool turns + up to MAX more executed re-prompt tool turns (the
    # model keeps calling tools even when told not to), then 2 empty attempts
    # before giving up: 1 initial + MAX + MAX + 2 = 2*MAX + 3 provider calls.
    assert body['mcpToolTurns'] == 2 * max_turns
    assert len(calls) == 2 * max_turns + 3


def test_chat_proxy_provider_empty_recovers_via_backstop(monkeypatch):
    # A literal empty completion from the provider (llama.cpp transient
    # hiccup) must not surface as an API error. The auto-search fallback and
    # the empty-response backstop both re-query; the tool-less re-prompt
    # recovers with real text.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(
        ai_routes, '_auto_search_context',
        lambda query: 'Snippet: BED_MESH_CALIBRATE ADAPTIVE=1 ...',
    )

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) <= 2:
            # Initial pass and the auto-search re-query: literally nothing
            # from the server.
            return DummyResponse(
                {'choices': [{'message': {'content': ''}}]},
                url=url,
            )
        # The tool-less backstop re-prompt finally answers directly.
        return DummyResponse(
            {'choices': [{'message': {
                'content': 'horizontal_move_z sets the Z hop before XY travel.',
            }}]},
            url=url,
        )

    monkeypatch.setattr(
        httpx, 'AsyncClient',
        lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post),
    )

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user',
                          'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'horizontal_move_z sets the Z hop before XY travel.'
    # 1 initial + 1 auto-search + 1 backstop re-prompt = 3 provider calls.
    assert len(calls) == 3
    # The backstop re-prompt must disable tools and carry the direct-answer
    # instruction.
    reprompt = calls[2]
    assert 'tools' not in reprompt
    assert any(
        m.get('role') == 'system' and 'Do not call any tools' in m.get('content', '')
        for m in reprompt['messages']
    )


def test_chat_proxy_local_reprompt_bumps_max_tokens(monkeypatch):
    # Local reasoning builds (llama.cpp --reasoning-budget) can exhaust a low
    # max_tokens invisibly and return empty content with finish_reason=length.
    # The tool-less re-prompt must raise the budget so the answer fits.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(
        ai_routes, '_execute_tool_call',
        lambda call: f"result for {call['name']}",
    )
    max_turns = ai_routes.MAX_MCP_TOOL_TURNS

    tool_only = (
        '<|tool_call>call:tool_call:get_config_reference_section'
        '{section_name: "bed_mesh"}<tool_call|>'
    )
    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        return DummyResponse(
            {'choices': [{'message': {'content': tool_only}}]},
            url=url,
        )

    monkeypatch.setattr(
        httpx, 'AsyncClient',
        lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post),
    )

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user',
                          'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'local',
            'model': 'gemma-4-12b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'openai-compatible',
            'maxTokens': 1024,
        },
    )

    assert response.status_code == 200
    body = response.json()
    # All responses are tool-only → backstop exhausts → graceful fallback.
    assert body['content'] == (
        "I wasn't able to generate a response. "
        "Please try rephrasing your question."
    )
    # 1 initial + MAX tool turns + MAX executed re-prompt tool turns + 2 empty
    # attempts = 2*MAX + 3 provider calls.
    assert len(calls) == 2 * max_turns + 3
    # The final backstop re-prompts (last two calls) must disable tools via the
    # direct-answer instruction AND raise the budget from the requested 1024
    # to EMPTY_REPROMPT_MAX_TOKENS (4096). Earlier payloads keep the request's
    # budget. Local providers don't use the native 'tools' key, so identify
    # the re-prompts by their system instruction.
    reprompts = calls[-2:]
    assert len(reprompts) == 2
    for p in calls[-2:]:
        assert p['max_tokens'] == ai_routes.EMPTY_REPROMPT_MAX_TOKENS == 4096
        assert any(
            m.get('role') == 'system' and 'Do not call any tools' in m.get('content', '')
            for m in p['messages']
        )
    # The initial + MAX main tool turns keep the request's budget; the
    # executed re-prompt turns (which also carry the direct-answer
    # instruction) get the raised budget like the final attempts.
    for p in calls[:max_turns + 1]:
        assert p['max_tokens'] == 1024
    for p in calls[max_turns + 1:]:
        assert p['max_tokens'] == ai_routes.EMPTY_REPROMPT_MAX_TOKENS == 4096
        assert any(
            m.get('role') == 'system' and 'Do not call any tools' in m.get('content', '')
            for m in p['messages']
        )


# ── Google Gemini thought-signature passthrough ─────────────────────────
# Gemini 3.5+ reasoning models attach extra_content.google.thought_signature
# to every tool call. The backend must preserve it when echoing the assistant
# message or Google rejects the follow-up with 400 "missing a thought_signature".


def test_extract_native_tool_calls_preserves_google_extra_content():
    calls = ai_routes._extract_native_tool_calls('chatgpt', {
        'choices': [{'message': {
            'content': None,
            'tool_calls': [{
                'type': 'function',
                'id': 'N0Y5NuNL',
                'function': {'name': 'search_klipper_docs', 'arguments': '{"query": "bed_mesh"}'},
                'extra_content': {'google': {'thought_signature': 'sig123'}},
            }],
        }}],
    })
    assert calls is not None
    assert calls[0]['name'] == 'search_klipper_docs'
    assert calls[0]['id'] == 'N0Y5NuNL'
    assert calls[0]['extra_content'] == {'google': {'thought_signature': 'sig123'}}


def test_extract_native_tool_calls_without_extra_content_still_works():
    calls = ai_routes._extract_native_tool_calls('chatgpt', {
        'choices': [{'message': {
            'tool_calls': [{
                'type': 'function',
                'id': 'call_1',
                'function': {'name': 'search_klipper_docs', 'arguments': '{"query": "bed_mesh"}'},
            }],
        }}],
    })
    assert calls is not None
    assert calls[0]['extra_content'] is None


def test_build_native_tool_followup_echoes_extra_content():
    messages = ai_routes._build_native_tool_followup(
        'chatgpt',
        '',
        [{
            'name': 'search_klipper_docs',
            'arguments': {'query': 'bed_mesh'},
            'id': 'N0Y5NuNL',
            'extra_content': {'google': {'thought_signature': 'sig123'}},
        }],
        ['result text'],
    )
    assistant_msg = messages[0]
    assert assistant_msg['role'] == 'assistant'
    assert assistant_msg['tool_calls'][0]['extra_content'] == {'google': {'thought_signature': 'sig123'}}
    assert messages[1]['role'] == 'tool'
    assert messages[1]['tool_call_id'] == 'N0Y5NuNL'


def test_build_native_tool_followup_omits_extra_content_when_absent():
    messages = ai_routes._build_native_tool_followup(
        'chatgpt',
        '',
        [{'name': 'search_klipper_docs', 'arguments': {'query': 'bed_mesh'}, 'id': 'call_1'}],
        ['result text'],
    )
    assert 'extra_content' not in messages[0]['tool_calls'][0]


def test_chat_proxy_native_tool_loop_preserves_google_thought_signature(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) == 1:
            # Gemini 3.5-style response: tool call WITH Google's extra_content.
            return DummyResponse(
                {
                    'choices': [{
                        'message': {
                            'content': None,
                            'tool_calls': [{
                                'type': 'function',
                                'id': 'N0Y5NuNL',
                                'function': {'name': 'search_klipper_docs', 'arguments': '{"query": "bed_mesh"}'},
                                'extra_content': {'google': {'thought_signature': 'sig123'}},
                            }],
                        }
                    }]
                },
                url=url,
            )
        # Second response: final answer after the tool result is fed back.
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z sets the Z hop before XY travel.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}],
            'apiKey': 'google-token',
            'model': 'gemini-3.5-flash-lite',
            'apiUrl': 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            'apiProvider': 'google',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'horizontal_move_z sets the Z hop before XY travel.'
    assert body['mcpToolTurns'] == 1
    # The follow-up payload must echo the thought_signature or Google 400s.
    second_payload = calls[1]
    assistant_msg = [m for m in second_payload['messages'] if m['role'] == 'assistant'][-1]
    assert assistant_msg['tool_calls'][0]['extra_content'] == {'google': {'thought_signature': 'sig123'}}


def test_reference_route_returns_full_klipper_doc():
    response = client.get('/api/reference/klipper-docs/Bed_Mesh.md')

    assert response.status_code == 200
    assert response.json()['filename'] == 'Bed_Mesh.md'
    assert response.json()['content'].startswith('# Bed Mesh')


# ── Config-grounding fallback (Phase 4) ───────────────────────────────


def test_targeted_section_headers_parity_with_frontend():
    content = (
        '[printer]\n'
        'kinematics: corexy\n'
        '\n'
        '[gcode_macro Level_Bed]\n'
        'gcode:\n'
        '  BED_MESH_CALIBRATE\n'
        '\n'
        '[bed_mesh]\n'
        'speed: 50\n'
    )
    assert ai_routes._targeted_section_headers('fix the Level_Bed macro', content) == ['gcode_macro Level_Bed']
    assert ai_routes._targeted_section_headers('what does the [bed_mesh] section do?', content) == ['bed_mesh']
    assert ai_routes._targeted_section_headers('change speed', content) == []


def test_mentioned_config_filenames_word_boundaries():
    available = ['printer.cfg', 'EBB.cfg']
    assert ai_routes._mentioned_config_filenames('update printer.cfg please', available) == ['printer.cfg']
    # No '.' between printer and cfg -> not a filename mention.
    assert ai_routes._mentioned_config_filenames('printer_cfg is fine', available) == []


def test_config_fallback_context_section_targeted():
    context_files = {
        'printer.cfg': {
            'content': '[printer]\nkinematics: corexy\nmax_accel: 12000\n\n[bed_mesh]\nspeed: 50\n',
            'label': 'Loaded config',
        },
    }
    injections = ai_routes._config_fallback_context(
        'What is my max_accel in the [printer] section of printer.cfg?',
        context_files,
    )
    assert injections is not None
    assert len(injections) == 1
    call, result = injections[0]
    assert call['name'] == 'read_user_config'
    assert call['arguments'] == {'filename': 'printer.cfg', 'section': 'printer'}
    assert 'max_accel: 12000' in result
    # Section-targeted read stays lean — the other section is not included.
    assert 'bed_mesh' not in result


def test_config_fallback_context_whole_file_last_resort():
    context_files = {
        'printer.cfg': {
            'content': '[printer]\nkinematics: corexy\nmax_accel: 12000\n',
            'label': 'Loaded config',
        },
    }
    injections = ai_routes._config_fallback_context('What is my max_accel in printer.cfg?', context_files)
    assert injections is not None
    call, result = injections[0]
    assert call['arguments'] == {'filename': 'printer.cfg'}
    assert 'max_accel: 12000' in result


def test_config_fallback_context_none_without_reference():
    context_files = {
        'printer.cfg': {'content': '[printer]\nkinematics: corexy\n', 'label': 'Loaded config'},
    }
    # Pure knowledge question -> no config injection even with one file loaded.
    assert ai_routes._config_fallback_context('What is pressure advance?', context_files) is None
    assert ai_routes._config_fallback_context('What is pressure advance?', {}) is None


def test_config_fallback_context_single_file_without_filename_mention():
    context_files = {
        'printer.cfg': {
            'content': '[printer]\nkinematics: corexy\nmax_accel: 12000\n\n[bed_mesh]\nspeed: 50\n',
            'label': 'Loaded config',
        },
    }
    # No filename mention, but a config section reference -> section-targeted.
    injections = ai_routes._config_fallback_context('What does [bed_mesh] speed do?', context_files)
    assert injections is not None
    call, result = injections[0]
    assert call['arguments'] == {'filename': 'printer.cfg', 'section': 'bed_mesh'}
    assert 'speed: 50' in result


def test_chat_proxy_config_fallback_injects_section(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)
    # The fallback is off by default (lean-first-pass workflow) — this test
    # exercises the injection path with the toggle explicitly enabled.
    monkeypatch.setenv('KWC_CONFIG_FALLBACK', '1')

    captured = {'count': 0}

    def fake_post(url, headers, payload):
        captured['count'] += 1
        # First call: model answers without calling any tool -> fallback triggers.
        if captured['count'] == 1:
            return DummyResponse(
                {'choices': [{'message': {'content': 'Your max accel is probably fine.'}}]},
                url=url,
            )
        # Second call: model answers after the config section was injected.
        captured['second_payload'] = payload
        return DummyResponse(
            {'choices': [{'message': {'content': 'Your max_accel is 12000 (from the [printer] section).'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What is my max_accel in the [printer] section of printer.cfg?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
            'contextFiles': {
                'printer.cfg': {
                    'content': '[printer]\nkinematics: corexy\nmax_accel: 12000\n',
                    'label': 'Loaded config',
                },
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'Your max_accel is 12000 (from the [printer] section).'
    assert body['mcpToolTurns'] == 1
    assert body['mcpToolNames'] == ['read_user_config']
    # The injected config must appear as a user-role tool result in the second payload.
    second_payload = captured['second_payload']
    assert any('[Tool result: read_user_config' in str(m.get('content', '')) for m in second_payload['messages'])


def test_chat_proxy_config_fallback_skips_without_context_files(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    captured = {'count': 0}

    def fake_post(url, headers, payload):
        captured['count'] += 1
        return DummyResponse(
            {'choices': [{'message': {'content': 'I think max_accel is around 12000.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'What is my max_accel in printer.cfg?'}],
            'apiKey': 'openai-token',
            'model': 'gpt-4o',
            'apiUrl': 'https://api.openai.com/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    assert captured['count'] == 1  # no context files -> fallback skipped -> single provider call
    body = response.json()
    assert body['mcpToolTurns'] == 0
    assert body['mcpToolNames'] == []


# ── Tool call detail records ──────────────────────────────────────────

def test_build_executed_tool_call_bounds_long_output():
    record = ai_routes._build_executed_tool_call(
        {'name': 'read_user_config', 'arguments': {'filename': 'printer.cfg'}},
        'x' * (ai_routes.TOOL_CALL_OUTPUT_MAX_CHARS + 100),
    )
    assert record['name'] == 'read_user_config'
    assert record['output'].endswith('...[truncated]')
    assert record['outputTruncated'] is True
    assert len(record['output']) <= (
        ai_routes.TOOL_CALL_OUTPUT_MAX_CHARS + len('...[truncated]')
    )


def test_build_executed_tool_call_bounds_long_arguments():
    big_args = {'filename': 'a' * (ai_routes.TOOL_CALL_ARGS_MAX_CHARS + 50)}
    record = ai_routes._build_executed_tool_call(
        {'name': 'validate_macro', 'arguments': big_args}, 'ok'
    )
    assert record['name'] == 'validate_macro'
    assert record['outputTruncated'] is False
    assert record['arguments'].endswith('...[truncated]')
    assert len(record['arguments']) <= (
        ai_routes.TOOL_CALL_ARGS_MAX_CHARS + len('...[truncated]')
    )


def test_build_executed_tool_call_handles_non_json_arguments():
    record = ai_routes._build_executed_tool_call(
        {'name': 'weird', 'arguments': object()}, 'ok'
    )
    assert record['name'] == 'weird'
    assert 'raw' in record['arguments']


# ── AI state + history file storage ───────────────────────────────────

def test_ai_state_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(ai_routes, 'AI_DATA_DIR', tmp_path)
    monkeypatch.setattr(ai_routes, 'AI_STATE_FILE', tmp_path / 'state.json')

    assert client.get('/ai/state').json() == {}
    saved = client.post('/ai/state', json={
        'settings': {'model': 'gpt-4o', 'apiProvider': 'chatgpt'},
        'messages': [{'role': 'user', 'content': 'hello'}],
    })
    assert saved.status_code == 200
    assert saved.json() == {'status': 'saved'}
    assert client.get('/ai/state').json() == {
        'settings': {'model': 'gpt-4o', 'apiProvider': 'chatgpt'},
        'messages': [{'role': 'user', 'content': 'hello'}],
    }


def test_ai_history_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(ai_routes, 'AI_DATA_DIR', tmp_path)
    monkeypatch.setattr(ai_routes, 'AI_HISTORY_FILE', tmp_path / 'history.json')

    assert client.get('/ai/history').json() == {}
    conversation_entry = {
        'id': 'chat_1', 'title': 'Test', 'timestamp': 1, 'messages': [],
    }
    saved = client.post('/ai/history', json={'conversations': [conversation_entry]})
    assert saved.status_code == 200
    expected_history = {'conversations': [conversation_entry]}
    assert client.get('/ai/history').json() == expected_history


def test_ai_state_returns_empty_for_invalid_json(monkeypatch, tmp_path):
    monkeypatch.setattr(ai_routes, 'AI_DATA_DIR', tmp_path)
    monkeypatch.setattr(ai_routes, 'AI_STATE_FILE', tmp_path / 'state.json')
    (tmp_path / 'state.json').write_text('{not valid json', encoding='utf-8')
    assert client.get('/ai/state').json() == {}
