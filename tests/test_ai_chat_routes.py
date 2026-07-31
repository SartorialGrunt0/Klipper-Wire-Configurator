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
    assert 'For config edits, return only changed, new, or deleted sections in fenced cfg code blocks' in ai_routes.SYSTEM_PROMPT
    assert 'If a macro changes motion or extrusion state, preserve or restore it' in ai_routes.SYSTEM_PROMPT
    assert 'If no safe grounded answer is possible, say what must be verified next instead of guessing.' in ai_routes.SYSTEM_PROMPT


def test_system_prompt_mentions_tools_are_not_gcode_commands():
    assert 'G28' in ai_routes.SYSTEM_PROMPT
    assert 'never wrap them in ```tool blocks' in ai_routes.SYSTEM_PROMPT


# ── _prepare_messages ───────────────────────────────────────────────────


def _blank_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())


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


def test_query_provider_empty_content_raises_value_error():
    def fake_post(url, headers, payload):
        return DummyResponse(
            {'choices': [{'message': {'content': ''}}], 'error': None},
            url=url,
        )

    with pytest.raises(ValueError, match='Empty response from API'):
        asyncio.run(ai_routes._query_provider(
            FakeAsyncClient(post_handler=fake_post),
            'http://localhost:1234/v1/chat/completions',
            {},
            {},
            'chatgpt',
        ))


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
    }


def test_chat_proxy_auto_search_fallback_injects_docs(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
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
    # The second request must carry the assistant tool_calls echo plus a tool result.
    second_payload = calls[1]
    roles = [m['role'] for m in second_payload['messages']]
    assert 'tool' in roles
    assistant_msg = [m for m in second_payload['messages'] if m['role'] == 'assistant'][-1]
    assert assistant_msg['tool_calls'][0]['function']['name'] == 'search_klipper_docs'


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
