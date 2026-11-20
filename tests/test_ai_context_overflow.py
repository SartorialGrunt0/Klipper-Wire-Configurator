"""W8 — graceful context-window overflow handling.

Two behaviors, both proven in both directions:

1. PRE-FLIGHT: when the client reports the router window it already probed
   (W7's /ai/context-window) and the assembled prompt is obviously over it
   (chars/4 estimate, pi's trick), the chat refuses cleanly BEFORE spending
   a provider round-trip — the llama.cpp silent-hang class. An unknown
   window (null) never blocks: W7's law, silence over guessing.

2. MAPPING: provider context-length errors (400 bodies and 200-with-error
   bodies) become the same structured, actionable error instead of the raw
   "API request failed: ..." passthrough. Any OTHER provider error keeps
   its existing generic surface untouched.
"""
import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from api.printer_memory_routes import PrinterMemory  # noqa: E402
from services.ai_context_overflow import (  # noqa: E402
    CONTEXT_OVERFLOW_ERROR_CODE,
    CONTEXT_OVERFLOW_MESSAGE,
    estimate_prompt_tokens,
    is_context_overflow_error,
    preflight_overflow,
)


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
        return self._post_handler(url=url, headers=headers, payload=json)

    async def get(self, url, headers=None):
        return self._get_handler(url=url, headers=headers)


LOCAL_CHAT = {
    'apiKey': '',
    'model': 'gemma-4-12b',
    'apiUrl': 'http://192.168.1.133:8080/v1/chat/completions',
    'apiProvider': 'openai-compatible',
    'editTools': False,
}


# ── pure estimate (chars/4 + image constant) ──────────────────────────────


def test_estimate_empty_is_zero():
    assert estimate_prompt_tokens([]) == 0


def test_estimate_is_chars_over_four_rounded_up():
    # 400 chars -> 100 tokens; 401 chars -> 101 (ceil, never floor: an
    # underestimate is the direction that defeats the pre-flight).
    assert estimate_prompt_tokens([{'role': 'user', 'content': 'x' * 400}]) == 100
    assert estimate_prompt_tokens([{'role': 'user', 'content': 'x' * 401}]) == 101


def test_estimate_handles_none_and_multimodal_list_content():
    assert estimate_prompt_tokens([{'role': 'user', 'content': None}]) == 0
    msgs = [{'role': 'user', 'content': [
        {'type': 'text', 'text': 'y' * 800},
        {'type': 'image_url', 'image_url': {'url': 'http://x/y.png'}},
    ]}]
    # text part counted by chars; the image part is a constant, NOT its URL
    # length (pi's trick). The constant must be a positive token count.
    est = estimate_prompt_tokens(msgs)
    assert est >= 200 + 1


def test_estimate_ignores_malformed_rows():
    assert estimate_prompt_tokens(['nope', {'no_content': 1}]) == 0


# ── pure pre-flight decision ──────────────────────────────────────────────


def test_preflight_silent_without_window():
    # W7 law: unknown window = silence, never a guess, never a block.
    assert preflight_overflow([{'role': 'user', 'content': 'x' * 100}], None) is None
    assert preflight_overflow([{'role': 'user', 'content': 'x' * 100}], 0) is None
    assert preflight_overflow([{'role': 'user', 'content': 'x' * 100}], -5) is None
    assert preflight_overflow([{'role': 'user', 'content': 'x' * 100}], 'big') is None
    assert preflight_overflow([{'role': 'user', 'content': 'x' * 100}], True) is None  # bool is not a window


def test_preflight_only_refuses_obviously_over():
    messages = [{'role': 'user', 'content': 'x' * 4000}]  # est 1000 tokens
    assert preflight_overflow(messages, 2000) is None      # fits
    assert preflight_overflow(messages, 1000) is None      # exactly at = provider's call
    payload = preflight_overflow(messages, 999)            # over -> refuse
    assert payload['error'] == CONTEXT_OVERFLOW_MESSAGE
    assert payload['errorCode'] == CONTEXT_OVERFLOW_ERROR_CODE
    # Harness-visible telemetry; the user sees only the label.
    assert payload['estimatedPromptTokens'] == 1000
    assert payload['contextWindow'] == 999


# ── provider-error classification (both directions) ───────────────────────


def test_classifies_real_provider_overflow_strings():
    provider_samples = [
        # OpenAI / vLLM / OpenAI-compatible servers
        "This model's maximum context length is 8192 tokens. However, you requested ...",
        'context_length_exceeded',
        # llama.cpp server variants
        'Exceeded context size (4096 vs 2048)',
        'exceed available context, try reducing the size of the binary system prompt',
        # Anthropic
        'prompt is too long: 254085 tokens > 200000 maximum',
        # Google
        'The input token count (1079606) exceeds the maximum number of tokens allowed (1048576)',
        # Generic OpenAI "reduce" tail
        'Please reduce the length of the messages or completion',
    ]
    for sample in provider_samples:
        assert is_context_overflow_error(sample), sample


def test_does_not_classify_unrelated_errors():
    for sample in [
        'Rate limit exceeded for your plan',
        "Incorrect API key provided: sk-bad",
        '502 Bad Gateway',
        'model not found: gpt-9',
        'Request timed out',
        'Your input content violated the content policy',
        'Connection reset by peer',
        '',
    ]:
        assert not is_context_overflow_error(sample), sample


# ── endpoint: pre-flight refusal in /ai/chat ──────────────────────────────


def test_chat_proxy_preflight_refuses_before_provider_call(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    called = {'hit': False}

    def fake_post(url, headers, payload):
        called['hit'] = True
        return DummyResponse({'choices': [{'message': {'content': 'should not run'}}]}, url=url)

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={
        **LOCAL_CHAT,
        'messages': [{'role': 'user', 'content': 'x' * 5000}],
        'knownContextWindow': 120,  # absurdly small -> assembled prompt is obviously over
    })

    assert response.status_code == 200
    body = response.json()
    assert body['error'] == CONTEXT_OVERFLOW_MESSAGE
    assert body['errorCode'] == CONTEXT_OVERFLOW_ERROR_CODE
    assert called['hit'] is False  # zero provider round-trips


def test_chat_proxy_without_window_never_blocks(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    called = {'hit': False}

    def fake_post(url, headers, payload):
        called['hit'] = True
        return DummyResponse({'choices': [{'message': {'content': 'fine.'}}]}, url=url)

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={
        **LOCAL_CHAT,
        'messages': [{'role': 'user', 'content': 'x' * 5000}],
        # knownContextWindow omitted entirely (harness, older clients)
    })

    assert response.status_code == 200
    assert body_content(response) == 'fine.'
    assert called['hit'] is True


def test_chat_proxy_generous_window_does_not_block(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    called = {'hit': False}

    def fake_post(url, headers, payload):
        called['hit'] = True
        return DummyResponse({'choices': [{'message': {'content': 'fine.'}}]}, url=url)

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={
        **LOCAL_CHAT,
        'messages': [{'role': 'user', 'content': 'hi'}],
        'knownContextWindow': 2_000_000,
    })

    assert response.status_code == 200
    assert body_content(response) == 'fine.'
    assert called['hit'] is True


def body_content(response):
    return (response.json() or {}).get('content')


# ── endpoint: provider context-length error mapping ───────────────────────


def test_provider_http_400_overflow_body_maps_to_actionable_error(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    def fake_post(url, headers, payload):
        return DummyResponse(
            {},
            status_code=400,
            url=url,
            text='{"error": {"message": "Exceeded context size (4096 vs 2048)", "code": 400}}',
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={**LOCAL_CHAT, 'messages': [{'role': 'user', 'content': 'hi'}]})

    assert response.status_code == 200
    body = response.json()
    assert body['error'] == CONTEXT_OVERFLOW_MESSAGE
    assert body['errorCode'] == CONTEXT_OVERFLOW_ERROR_CODE
    assert 'API request failed' not in body['error']


def test_provider_200_error_body_overflow_maps(monkeypatch):
    # Some servers answer 200 with an error object (the _extract_api_error_message
    # ValueError path) — mapping must cover that path too, mid-loop included.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    def fake_post(url, headers, payload):
        return DummyResponse(
            {'error': {'message': "This model's maximum context length is 2048 tokens."}},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={**LOCAL_CHAT, 'messages': [{'role': 'user', 'content': 'hi'}]})

    assert response.status_code == 200
    body = response.json()
    assert body['error'] == CONTEXT_OVERFLOW_MESSAGE
    assert body['errorCode'] == CONTEXT_OVERFLOW_ERROR_CODE


def test_provider_http_400_unrelated_error_keeps_generic_surface(monkeypatch):
    # Control: the generic passthrough must NOT change shape for anything
    # that isn't a context-length error.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    def fake_post(url, headers, payload):
        return DummyResponse({}, status_code=400, url=url, text='{"error": {"message": "Rate limit exceeded"}}')

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={**LOCAL_CHAT, 'messages': [{'role': 'user', 'content': 'hi'}]})

    assert response.status_code == 200
    body = response.json()
    assert 'errorCode' not in body
    assert body['error'].startswith('API request failed')


def test_provider_200_unrelated_error_body_keeps_api_error_prefix(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())

    def fake_post(url, headers, payload):
        return DummyResponse({'error': {'message': 'model not found: gpt-9'}}, url=url)

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post('/ai/chat', json={**LOCAL_CHAT, 'messages': [{'role': 'user', 'content': 'hi'}]})

    body = response.json()
    assert 'errorCode' not in body
    assert body['error'].startswith('API error:')


# ── PR #43 review F9: the native tools payload rides the same window ──

def test_estimate_prompt_tokens_counts_native_tools_payload():
    # The provider bills the tools JSON against the context window, but
    # the pre-flight counted ONLY message content: measured 4,215 tokens
    # counted against 12,392 actually sent for an edit-armed request.
    msgs = [{"role": "user", "content": "hi"}]
    tools = [{"name": "t", "description": "x" * 4000}]
    assert estimate_prompt_tokens(msgs) < estimate_prompt_tokens(msgs, tools=tools)


def test_preflight_blocks_tools_inflated_request():
    msgs = [{"role": "user", "content": "hi"}]
    tools = [{"name": "t", "description": "x" * 4000}]  # ~1000 tokens
    assert preflight_overflow(msgs, 900) is None  # messages alone: under
    blocked = preflight_overflow(msgs, 900, tools=tools)
    assert blocked is not None
    assert blocked["estimatedPromptTokens"] > 900
    assert blocked["errorCode"]  # harness telemetry fields unchanged


def test_preflight_tools_none_is_the_old_behaviour():
    msgs = [{"role": "user", "content": "hi"}]
    assert (preflight_overflow(msgs, 10, tools=None)
            == preflight_overflow(msgs, 10))


def test_estimate_prompt_tokens_tools_never_raises():
    class Weird:
        pass

    # Non-serialisable entries degrade to str-length, never an exception:
    # an estimate failure must not turn into a 500 on the chat route.
    est = estimate_prompt_tokens([{"role": "user", "content": "hi"}],
                                 tools=[Weird(), {"a": 1}])
    assert est >= 0
