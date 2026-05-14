import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402


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


def test_build_lm_studio_chat_payload_formats_history_and_integrations():
    messages = [
        {'role': 'system', 'content': 'System instructions.'},
        {'role': 'user', 'content': 'My printer is a Voron 2.4.'},
        {'role': 'assistant', 'content': 'Understood.'},
        {'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'},
    ]

    payload = ai_routes._build_lm_studio_chat_payload(messages, 'unsloth/qwen3.5-9b')

    assert payload['model'] == 'unsloth/qwen3.5-9b'
    assert payload['store'] is False
    assert payload['system_prompt'] == 'System instructions.'
    assert payload['integrations'] == [ai_routes.LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID]
    assert 'Conversation so far:' in payload['input']
    assert 'Current user request:' in payload['input']
    assert 'horizontal_move_z' in payload['input']


def test_build_lm_studio_context_metadata_uses_usage_and_context_window():
    metadata = ai_routes._build_lm_studio_context_metadata(
        {
            'usage': {
                'prompt_tokens': 1800,
                'completion_tokens': 200,
                'total_tokens': 2000,
            },
            'model_info': {
                'context_length': 8192,
            },
        },
        request_chars=7200,
        truncated=False,
    )

    assert metadata == {
        'requestChars': 7200,
        'truncated': False,
        'promptTokens': 1800,
        'completionTokens': 200,
        'totalTokens': 2000,
        'estimatedPromptTokens': None,
        'contextWindow': 8192,
        'usedTokens': 2000,
        'utilization': 0.2441,
    }


def test_system_prompt_includes_config_and_macro_guardrails():
    assert 'Prefer minimal targeted edits over rewrites.' in ai_routes.SYSTEM_PROMPT
    assert 'return only the changed or new Klipper sections inside fenced cfg code blocks' in ai_routes.SYSTEM_PROMPT
    assert 'If a macro changes motion or extrusion state, preserve or restore that state' in ai_routes.SYSTEM_PROMPT
    assert 'If no safe grounded answer is possible, say what must be verified next instead of guessing.' in ai_routes.SYSTEM_PROMPT


def test_docs_grounding_prompt_mentions_macro_summary_priority_and_safe_state_handling():
    assert 'For macro requests, prefer the macro summary first' in ai_routes.DOCS_GROUNDING_PROMPT
    assert 'keep macro state handling explicit and safe' in ai_routes.DOCS_GROUNDING_PROMPT


def test_build_lm_studio_context_metadata_estimates_when_usage_is_missing():
    metadata = ai_routes._build_lm_studio_context_metadata(
        {},
        request_chars=4001,
        truncated=True,
        context_window=8192,
    )

    assert metadata == {
        'requestChars': 4001,
        'truncated': True,
        'promptTokens': None,
        'completionTokens': None,
        'totalTokens': None,
        'estimatedPromptTokens': 1001,
        'contextWindow': 8192,
        'usedTokens': 1001,
        'utilization': 0.1222,
    }


def test_list_models_uses_provider_base_url_and_optional_auth(monkeypatch):
    captured = {}

    def fake_get(url, headers):
        captured['url'] = url
        captured['headers'] = headers
        return DummyResponse(
            {'data': [{'id': 'qwen3'}, {'id': 'llama3'}]},
            method='GET',
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(get_handler=fake_get))

    response = client.get(
        '/ai/models',
        params={
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiKey': 'secret-token',
        },
    )

    assert response.status_code == 200
    assert response.json() == {'models': ['qwen3', 'llama3']}
    assert captured == {
        'url': 'http://localhost:1234/v1/models',
        'headers': {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer secret-token',
        },
    }


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


def test_chat_proxy_injects_docs_grounding_and_reference_context(monkeypatch):
    captured = {}

    def fake_post(url, headers, payload):
        captured['url'] = url
        captured['headers'] = headers
        captured['payload'] = payload
        return DummyResponse(
            {'choices': [{'message': {'content': 'horizontal_move_z is the Z hop before XY travel.'}}]},
            url=url,
        )

    monkeypatch.setattr(
        ai_routes,
        '_get_config_reference_context',
        lambda query, limit=ai_routes.MAX_CONFIG_REFERENCE_RESULTS: [
            '### [bed_mesh]\nhorizontal_move_z: The Z gap when traversing the mesh.'
        ],
    )
    monkeypatch.setattr(
        ai_routes,
        '_get_klipper_docs_summary_context',
        lambda query, limit=ai_routes.MAX_KLIPPER_DOCS_SUMMARY_RESULTS: [
            '## Probes, leveling, and bed mesh\n- horizontal_move_z is a bed_mesh safety travel height.'
        ],
    )
    monkeypatch.setattr(
        ai_routes,
        '_get_full_klipper_docs_context',
        lambda query, limit=ai_routes.MAX_FULL_KLIPPER_DOC_RESULTS: [],
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
    assert response.json() == {'content': 'horizontal_move_z is the Z hop before XY travel.'}
    assert captured['url'] == 'https://api.openai.com/v1/chat/completions'
    assert captured['headers'] == {
        'Authorization': 'Bearer openai-token',
        'Content-Type': 'application/json',
    }
    assert captured['payload']['model'] == 'gpt-4o'
    assert captured['payload']['messages'][0]['role'] == 'system'
    assert ai_routes.DOCS_GROUNDING_PROMPT in captured['payload']['messages'][0]['content']
    assert 'Relevant sections from the bundled Klipper_Docs_AI_Summary.md' in captured['payload']['messages'][0]['content']
    assert 'Relevant sections from the bundled Config_Reference.md' in captured['payload']['messages'][0]['content']
    assert '## Probes, leveling, and bed mesh' in captured['payload']['messages'][0]['content']
    assert '### [bed_mesh]' in captured['payload']['messages'][0]['content']
    assert captured['payload']['messages'][1:] == [
        {'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}
    ]


def test_chat_proxy_lm_studio_without_token_uses_openai_compatible_fallback(monkeypatch):
    captured = {}

    async def fake_post_openai_compatible_chat(client, api_url, headers, payload):
        captured['api_url'] = api_url
        captured['headers'] = headers
        captured['payload'] = payload
        return ({'choices': [{'message': {'content': 'Use a small but safe Z hop.'}}]}, 'Use a small but safe Z hop.')

    monkeypatch.setattr(ai_routes, '_post_openai_compatible_chat', fake_post_openai_compatible_chat)

    async def fake_resolve_context_window(client, api_url, headers, model, data):
        return 8192

    monkeypatch.setattr(ai_routes, '_resolve_lm_studio_context_window', fake_resolve_context_window)

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Suggest a safe [bed_mesh] horizontal_move_z value.'}],
            'apiKey': '',
            'model': 'unsloth/qwen3.5-9b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'lm-studio',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'Use a small but safe Z hop.'
    assert body['lmStudioMcp'] == {
        'requested': True,
        'pluginId': ai_routes.LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID,
        'route': 'openai-compatible',
        'toolUsed': False,
        'toolNames': [],
        'fallbackUsed': True,
        'fallbackReason': 'LM Studio MCP plugin access requires an API token, so the proxy used the OpenAI-compatible endpoint.',
    }
    assert body['lmStudioContext']['contextWindow'] == 8192
    assert body['lmStudioContext']['usedTokens'] == body['lmStudioContext']['estimatedPromptTokens']
    assert body['lmStudioContext']['promptTokens'] is None
    assert body['lmStudioContext']['truncated'] is False
    assert captured['api_url'] == 'http://localhost:1234/v1/chat/completions'
    assert captured['headers'] == {'Content-Type': 'application/json'}
    assert captured['payload']['model'] == 'unsloth/qwen3.5-9b'
    assert captured['payload']['messages'][0]['role'] == 'system'


def test_chat_proxy_lm_studio_context_uses_model_listing_when_response_omits_window(monkeypatch):
    def fake_post(url, headers, payload):
        return DummyResponse(
            {
                'choices': [{'message': {'content': 'Use a small but safe Z hop.'}}],
                'usage': {
                    'prompt_tokens': 1024,
                    'completion_tokens': 128,
                    'total_tokens': 1152,
                },
            },
            url=url,
        )

    def fake_get(url, headers):
        return DummyResponse(
            {
                'data': [
                    {
                        'id': 'unsloth/qwen3.5-9b',
                        'max_context_length': 8192,
                    }
                ]
            },
            method='GET',
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs: FakeAsyncClient(post_handler=fake_post, get_handler=fake_get))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'Suggest a safe [bed_mesh] horizontal_move_z value.'}],
            'apiKey': '',
            'model': 'unsloth/qwen3.5-9b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'lm-studio',
            'lmStudioMcpPluginId': '',
        },
    )

    assert response.status_code == 200
    assert response.json()['lmStudioContext'] == {
        'requestChars': response.json()['lmStudioContext']['requestChars'],
        'truncated': False,
        'promptTokens': 1024,
        'completionTokens': 128,
        'totalTokens': 1152,
        'estimatedPromptTokens': None,
        'contextWindow': 8192,
        'usedTokens': 1152,
        'utilization': 0.1406,
    }


def test_get_klipper_docs_summary_context_matches_macro_query():
    sections = ai_routes._get_klipper_docs_summary_context(
        'Help me write a gcode_macro that uses params, printer state, and delayed_gcode.'
    )

    assert sections
    assert any('## Macros, templates, and delayed G-Code' in section for section in sections)


def test_prepare_messages_injects_gcode_macro_summary_for_macro_query():
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'Help me write a macro that uses safe G-code moves and SAVE_GCODE_STATE.'}
    ])

    system_prompt = prepared[0]['content']

    assert 'Bundled Klipper_GCode_Macro_AI_Summary.md injected because the recent user request explicitly mentioned G-code or macros:' in system_prompt
    assert '# Klipper G-Code and Macro AI Summary' in system_prompt
    assert '## Macro rules' in system_prompt


def test_prepare_messages_injects_gcode_macro_summary_for_command_name_query():
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'How do I call BED_MESH_CALIBRATE in adaptive mode?'}
    ])

    system_prompt = prepared[0]['content']

    assert 'Bundled Klipper_GCode_Macro_AI_Summary.md injected because the recent user request explicitly mentioned G-code or macros:' in system_prompt
    assert '# Klipper G-Code and Macro AI Summary' in system_prompt
    assert 'BED_MESH_CALIBRATE' in system_prompt


def test_prepare_messages_injects_full_bed_mesh_doc_for_explicit_request():
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'Show me the full Bed_Mesh markdown document.'}
    ])

    system_prompt = prepared[0]['content']

    assert 'Full bundled Klipper document: Bed_Mesh.md' in system_prompt
    assert 'Official HTML mirror: https://www.klipper3d.org/Bed_Mesh.html' in system_prompt
    assert '# Bed Mesh' in system_prompt


def test_reference_route_returns_full_klipper_doc():
    response = client.get('/api/reference/klipper-docs/Bed_Mesh.md')

    assert response.status_code == 200
    assert response.json()['filename'] == 'Bed_Mesh.md'
    assert response.json()['content'].startswith('# Bed Mesh')