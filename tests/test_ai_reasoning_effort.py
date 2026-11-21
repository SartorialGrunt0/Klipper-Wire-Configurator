"""Reasoning-effort support (feature/ai-reasoning-effort).

Laws this file pins:
1. 'default' sends NOTHING — an omitted field means the model default on
   every server; a literal 'default' string is not a valid level anywhere.
2. The field rides for the openai-compatible provider ONLY (scope
   2026-11-21): a level saved under a local endpoint must never ride along
   to chatgpt/google/github/anthropic.
3. A 4xx that NAMES the field is our input, not the provider's failure:
   retry once without it, and remember the (url, model) pair so the field
   is omitted proactively afterwards. The matcher is literal (intent law).
4. /ai/reasoning-levels contract: source 'props' is authoritative ([] means
   "no configurable effort", NOT "unknown"); source null means nothing is
   advertised. Probe failures degrade to null + error, never a 500.
"""
import asyncio
import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


class DummyResponse:
    def __init__(self, payload, *, status_code=200, text='', raise_on_json=False):
        self._payload = payload
        self.status_code = status_code
        self.text = text
        self._raise_on_json = raise_on_json
        self.request = httpx.Request('GET', 'http://fake.test')

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('request failed', request=self.request, response=self)

    def json(self):
        if self._raise_on_json:
            raise ValueError('not JSON')
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
        return self._post_handler(url, headers or {}, json)

    async def get(self, url, headers=None, params=None):
        return self._get_handler(url, headers or {}, params)


MSGS = [{'role': 'user', 'content': 'hi'}]
OK_BODY = {'choices': [{'message': {'content': 'ok'}, 'finish_reason': 'stop'}]}


# ── 1/2: payload mapping ─────────────────────────────────────────────────

def test_default_sends_nothing():
    for value in ('default', '', None):
        payload = ai_routes._build_provider_payload(
            'openai-compatible', MSGS, 'm', reasoning_effort=value)
        assert 'reasoning_effort' not in payload


def test_level_forwarded_verbatim_for_openai_compatible():
    payload = ai_routes._build_provider_payload(
        'openai-compatible', MSGS, 'm', reasoning_effort='xhigh')
    assert payload['reasoning_effort'] == 'xhigh'


def test_off_level_forwarded_as_none_string_not_omitted():
    # 'none' is a REAL level (disable thinking where supported) — distinct
    # from 'default' (send nothing). Confusing the two silently changes
    # behavior on every reasoning-capable server.
    payload = ai_routes._build_provider_payload(
        'openai-compatible', MSGS, 'm', reasoning_effort='none')
    assert payload['reasoning_effort'] == 'none'


def test_other_providers_never_receive_the_field():
    for provider in ('chatgpt', 'google', 'github'):
        payload = ai_routes._build_provider_payload(
            provider, MSGS, 'm', reasoning_effort='high')
        assert 'reasoning_effort' not in payload, provider
    payload = ai_routes._build_provider_payload(
        'anthropic', MSGS, 'm', reasoning_effort='high')
    assert 'reasoning_effort' not in payload


def test_enum_provider_compares_by_value():
    # The route passes req.apiProvider (the str-Enum); the provider gate
    # must fire on the enum too, not only on raw strings.
    payload = ai_routes._build_provider_payload(
        ai_routes.AiProvider.openai_compatible, MSGS, 'm', reasoning_effort='low')
    assert payload['reasoning_effort'] == 'low'


# ── 3: rejection matcher + degrade ───────────────────────────────────────

def test_rejection_matcher_is_literal():
    assert ai_routes._looks_like_reasoning_effort_rejection(
        400, '{"error":"Unsupported value: \'reasoning_effort\' does not support \'high\'"}')
    assert ai_routes._looks_like_reasoning_effort_rejection(
        400, 'Invalid request: Reasoning Effort level unknown')
    assert not ai_routes._looks_like_reasoning_effort_rejection(400, 'missing field: model')
    assert not ai_routes._looks_like_reasoning_effort_rejection(500, 'reasoning_effort blew up')
    assert not ai_routes._looks_like_reasoning_effort_rejection(401, 'reasoning_effort? never heard')


def _run(coro):
    return asyncio.run(coro)


def test_rejected_field_retried_once_and_remembered():
    url = 'http://effort.test/v1/chat/completions'
    posts = []

    def post(u, headers, body):
        posts.append(dict(body))
        if 'reasoning_effort' in body:
            return DummyResponse({}, status_code=400,
                                 text='{"error":"Unsupported value: reasoning_effort"}')
        return DummyResponse(OK_BODY)

    saved = set(ai_routes._effort_rejected_endpoints)
    try:
        ai_routes._effort_rejected_endpoints.clear()
        payload = ai_routes._build_provider_payload(
            'openai-compatible', MSGS, 'm', reasoning_effort='high')
        content, _ = _run(ai_routes._query_provider(
            FakeAsyncClient(post_handler=post), url, {}, payload, 'openai-compatible'))
        assert content == 'ok'
        # first attempt WITH the field, retry WITHOUT it.
        assert 'reasoning_effort' in posts[0] and 'reasoning_effort' not in posts[1]
        assert (url, 'm') in ai_routes._effort_rejected_endpoints
        # second request: proactive omission, exactly one post.
        posts.clear()
        payload2 = ai_routes._build_provider_payload(
            'openai-compatible', MSGS, 'm', reasoning_effort='high')
        content2, _ = _run(ai_routes._query_provider(
            FakeAsyncClient(post_handler=post), url, {}, payload2, 'openai-compatible'))
        assert content2 == 'ok'
        assert len(posts) == 1 and 'reasoning_effort' not in posts[0]
    finally:
        ai_routes._effort_rejected_endpoints.clear()
        ai_routes._effort_rejected_endpoints.update(saved)


def test_unrelated_400_never_retries():
    url = 'http://other.test/v1/chat/completions'
    posts = []

    def post(u, headers, body):
        posts.append(dict(body))
        return DummyResponse({}, status_code=400, text='bad request: messages empty')

    try:
        ai_routes._effort_rejected_endpoints.discard((url, 'm'))
        payload = ai_routes._build_provider_payload(
            'openai-compatible', MSGS, 'm', reasoning_effort='high')
        try:
            _run(ai_routes._query_provider(
                FakeAsyncClient(post_handler=post), url, {}, payload, 'openai-compatible'))
            raise AssertionError('expected HTTPStatusError')
        except httpx.HTTPStatusError:
            pass
        assert len(posts) == 1  # surfaces on the FIRST try, unchanged behavior
    finally:
        ai_routes._effort_rejected_endpoints.discard((url, 'm'))


# ── 4: /ai/reasoning-levels ──────────────────────────────────────────────

def _probe(monkeypatch, get_handler, model='m1', provider='openai-compatible'):
    monkeypatch.setattr(httpx, 'AsyncClient',
                        lambda *a, **k: FakeAsyncClient(get_handler=get_handler))
    res = client.post('/ai/reasoning-levels', json={
        'apiProvider': provider,
        'apiUrl': 'http://srv.test:8080/v1/chat/completions',
        'apiKey': '',
        'model': model,
    })
    assert res.status_code == 200
    return res.json()


def test_probe_single_server_caps(monkeypatch):
    def get(url, headers, params):
        return DummyResponse({'chat_template_caps': {
            'supports_reasoning_effort': True,
            'reasoning_effort_levels': ['low', 'medium', 'xhigh'],
            'reasoning_effort_rejected': [],
        }})
    body = _probe(monkeypatch, get)
    assert body == {'levels': ['low', 'medium', 'xhigh'], 'source': 'props'}


def test_probe_router_asks_per_model(monkeypatch):
    calls = []

    def get(url, headers, params):
        calls.append(params)
        if params:
            return DummyResponse({'chat_template_caps': {
                'supports_reasoning_effort': True,
                'reasoning_effort_levels': ['low', 'medium', 'xhigh'],
            }})
        return DummyResponse({'role': 'router', 'model_alias': 'llama-server'})
    body = _probe(monkeypatch, get, model='qwen3.8-27b')
    assert body['levels'] == ['low', 'medium', 'xhigh'] and body['source'] == 'props'
    assert calls == [None, {'model': 'qwen3.8-27b'}]


def test_probe_empty_levels_are_authoritative_not_unknown(monkeypatch):
    # The gemma-4-12b case: props answered, and the answer is "no
    # configurable effort". source MUST be 'props' so the UI shows Default
    # alone — an empty list with source null would wrongly unlock the
    # assumed ladder.
    def get(url, headers, params):
        return DummyResponse({'chat_template_caps': {
            'supports_reasoning_effort': False,
            'reasoning_effort_levels': [],
        }})
    body = _probe(monkeypatch, get)
    assert body['levels'] == [] and body['source'] == 'props'


def test_probe_rejected_levels_filtered(monkeypatch):
    def get(url, headers, params):
        return DummyResponse({'chat_template_caps': {
            'supports_reasoning_effort': True,
            'reasoning_effort_levels': ['low', 'medium', 'high', 'minimal'],
            'reasoning_effort_rejected': ['minimal'],
        }})
    body = _probe(monkeypatch, get)
    assert body['levels'] == ['low', 'medium', 'high']


def test_probe_llama_swap_shape_requires_model_param(monkeypatch):
    # llama-swap errors on bare /props; the route retries ?model=<id>.
    calls = []

    def get(url, headers, params):
        calls.append(params)
        if params:
            return DummyResponse({'chat_template_caps': {
                'supports_reasoning_effort': True,
                'reasoning_effort_levels': ['low', 'medium', 'xhigh'],
            }})
        return DummyResponse({'detail': 'model required'}, status_code=400)
    body = _probe(monkeypatch, get)
    assert body['levels'] == ['low', 'medium', 'xhigh'] and body['source'] == 'props'
    assert calls == [None, {'model': 'm1'}]


def test_probe_no_caps_is_unknown(monkeypatch):
    def get(url, headers, params):
        return DummyResponse({'total_slots': 1})  # old llama.cpp: no caps
    body = _probe(monkeypatch, get)
    assert body['levels'] == [] and body['source'] is None


def test_probe_failure_degrades_never_500(monkeypatch):
    def get(url, headers, params):
        return DummyResponse(None, status_code=404)
    body = _probe(monkeypatch, get)
    assert body['levels'] == [] and body['source'] is None and 'error' in body


def test_probe_non_json_body_degrades_never_500(monkeypatch):
    # The W7 lesson: a 200 landing page must not escape as a 500.
    def get(url, headers, params):
        return DummyResponse(None, raise_on_json=True)
    body = _probe(monkeypatch, get)
    assert body['levels'] == [] and body['source'] is None and 'error' in body


def test_probe_other_providers_answer_empty_without_network(monkeypatch):
    def get(url, headers, params):
        raise AssertionError('non-openai-compatible provider must not be probed')
    body = _probe(monkeypatch, get, provider='chatgpt')
    assert body['levels'] == [] and body['source'] is None


# ── request model plumbing ───────────────────────────────────────────────

def test_chat_request_reasoning_effort_defaults_to_default():
    req = ai_routes.ChatRequest(messages=MSGS, apiKey='')
    assert req.reasoningEffort == 'default'
