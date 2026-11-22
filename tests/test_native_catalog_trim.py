"""Native-turn head trim: the per-tool catalog ships ONCE.

Industry posture (2026-11-22 research, skill ref tool-advertisement-research):
schemas travel in the native `tools` array; the head carries behavioral LAWS,
not a tool catalog. Text-protocol turns keep the catalog as their ONLY
channel (substitute, not addition). Tools-blind endpoints (llama.cpp template
that never reads the `tools` var / legacy --no-jinja) are DETECTED by a
prompt-token delta probe and re-receive the catalog — insurance as a
substitute that costs zero on healthy endpoints.

Contract pinned here:
- _build_mcp_tool_context(tools_catalog=False) -> laws intact, catalog gone.
- ChatRequest.nativeCatalog: None=auto (default), False=force off, True=force on.
- Auto on a native turn with NO recorded verdict -> trimmed (healthy posture;
  the whole 9-model bank fleet proved the array reaches every model).
- Recorded tools-blind verdict -> catalog back on native turns.
- The delta verdict: equal prompt_tokens (tools vs no-tools) -> blind;
  larger -> not blind; probe errors -> NOT blind + log (never blind by
  timeout-guess).
"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
"""


def _ctx():
    return {'printer.cfg': {'content': PRINTER_CFG}}


def _chat_payload(messages, **over):
    payload = {
        'messages': messages,
        'apiKey': 'test-key',
        'model': 'test-model',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt',
        'contextFiles': _ctx(),
    }
    payload.update(over)
    return payload


def _final_reply(text='Done.'):
    return {'choices': [{'message': {'content': text}}]}


class _ScriptedClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.payloads = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.payloads.append(json)
        reply = self.replies.pop(0) if self.replies else _final_reply()
        return _Resp(reply)

    async def get(self, url, headers=None):
        raise AssertionError('Unexpected GET request')


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.text = json.dumps(payload)

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


@pytest.fixture()
def install(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    # The delta probe must never fire (or spawn) inside route tests that
    # script httpx.AsyncClient — same discipline as the reasoning-levels
    # declaration-cache snapshot tests.
    monkeypatch.setattr(ai_routes, '_spawn_native_tools_probe',
                        lambda *a, **k: None)

    def _install(replies):
        scripted = _ScriptedClient(replies)
        monkeypatch.setattr(ai_routes.httpx, 'AsyncClient',
                            lambda *a, **k: scripted)
        return scripted

    return _install


@pytest.fixture()
def verdicts():
    """Snapshot/restore the process-global tools-blind cache; starts EMPTY
    (= no verdict recorded). Tests that need a verdict set it through the
    writer helper — an unseeded gate reads healthy, mirroring the
    declaration-cache lesson."""
    saved = dict(ai_routes._NATIVE_TOOLS_BLIND)
    ai_routes._NATIVE_TOOLS_BLIND.clear()
    yield ai_routes._NATIVE_TOOLS_BLIND
    ai_routes._NATIVE_TOOLS_BLIND.clear()
    ai_routes._NATIVE_TOOLS_BLIND.update(saved)


def _url_model():
    return ai_routes._url_model_key('https://api.example.com/v1/chat/completions',
                                    'test-model')


def _payload_tool_names(payload):
    return {t['function']['name'] for t in payload.get('tools') or []}


CATALOG_MARKERS = (
    "Tools:\n",
    "- read_user_config:",
    "- list_config_reference_sections:",
    "Specialized tools (use only for specific problems):",
    "- list_hardware:",
    "- detect_board:",
)
LAW_MARKERS = (
    "Use these tools proactively",
    "never write tool calls as text",
    "are NOT tools",
)


# ── Builder unit ─────────────────────────────────────────────────────────────

def test_builder_tools_catalog_false_drops_catalog_keeps_laws():
    ctx = ai_routes._build_mcp_tool_context(native_mode=True, tools_catalog=False)
    for marker in CATALOG_MARKERS:
        assert marker not in ctx, f"catalog marker {marker!r} must be gone"
    for law in LAW_MARKERS:
        assert law in ctx, f"behavioral law {law!r} must survive"


def test_builder_default_still_ships_catalog():
    # Default (text arm / explicit catalog=True) is UNCHANGED — the
    # substitute law: text turns keep their only channel.
    ctx = ai_routes._build_mcp_tool_context()
    for marker in CATALOG_MARKERS:
        assert marker in ctx
    ctx_native = ai_routes._build_mcp_tool_context(native_mode=True,
                                                   tools_catalog=True)
    for marker in CATALOG_MARKERS:
        assert marker in ctx_native


def test_builder_edit_and_skill_index_gone_with_catalog():
    # The edit-tool snippets, skill INDEX and load_skill snippet are
    # catalog content: gone with tools_catalog=False. Their surfaces are
    # the native array on healthy native turns.
    ctx = ai_routes._build_mcp_tool_context(
        edit_capable=True, skill_active=True, macro_skill_active=False,
        native_mode=True, tools_catalog=False)
    assert '- config_edit:' not in ctx
    assert '<available_skills>' not in ctx
    assert '- load_skill:' not in ctx
    armed = ai_routes._build_mcp_tool_context(
        edit_capable=True, skill_active=False, macro_skill_active=False,
        native_mode=True, tools_catalog=False)
    assert '- config_edit:' not in armed
    assert '<available_skills>' not in armed


def test_builder_catalog_with_macro_gate_still_locksteps():
    # When the catalog DOES ride (catalog=True), the macro lazy gate keeps
    # its lock-step semantics on the head too.
    closed = ai_routes._build_mcp_tool_context(
        native_mode=True, tools_catalog=True, macro_skill_active=False)
    armed = ai_routes._build_mcp_tool_context(
        native_mode=True, tools_catalog=True, macro_skill_active=True)
    assert '- validate_macro:' not in closed
    assert '- validate_macro:' in armed


# ── Route arms ───────────────────────────────────────────────────────────────

def test_route_auto_native_head_trimmed_array_carries_surface(install, verdicts):
    scripted = install([_final_reply('ok')])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what mcu board do I have?'}]))
    assert r.status_code == 200
    head = scripted.payloads[0]['messages'][0]['content']
    for marker in CATALOG_MARKERS:
        assert marker not in head, f"native auto head must not carry {marker!r}"
    for law in LAW_MARKERS:
        assert law in head
    # The array is the single carrier: the everyday tools are there.
    names = _payload_tool_names(scripted.payloads[0])
    assert 'read_user_config' in names
    assert 'list_hardware' in names


def test_route_native_blind_verdict_restores_catalog(install, verdicts):
    ai_routes._record_native_tools_blind(
        _url_model(), True, reason='prompt-token delta equal')
    scripted = install([_final_reply('ok')])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what mcu board do I have?'}]))
    assert r.status_code == 200
    head = scripted.payloads[0]['messages'][0]['content']
    for marker in CATALOG_MARKERS:
        assert marker in head, f"tools-blind endpoint must get {marker!r} back"


def test_route_native_notblind_verdict_stays_trimmed(install, verdicts):
    ai_routes._record_native_tools_blind(
        _url_model(), False, reason='delta grew')
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what mcu board do I have?'}]))
    head = scripted.payloads[0]['messages'][0]['content']
    assert 'Specialized tools (use only for specific problems):' not in head


def test_route_native_catalog_override_off_and_always(install, verdicts):
    # nativeCatalog=False -> trimmed even with a blind verdict (A/B off arm)
    ai_routes._record_native_tools_blind(_url_model(), True, reason='blind')
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}], nativeCatalog=False))
    head = scripted.payloads[0]['messages'][0]['content']
    assert 'Specialized tools (use only for specific problems):' not in head

    # nativeCatalog=True -> catalog despite no verdict (A/B always arm)
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}], nativeCatalog=True))
    head = scripted.payloads[0]['messages'][0]['content']
    assert '- read_user_config:' in head


def test_route_text_arm_unchanged_regardless_of_verdict(install, verdicts):
    # The substitute law: text turns always carry the catalog.
    ai_routes._record_native_tools_blind(_url_model(), False, reason='delta grew')
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}], toolProtocol='text'))
    head = scripted.payloads[0]['messages'][0]['content']
    for marker in CATALOG_MARKERS:
        assert marker in head
    assert '```tool' in head


def test_route_edit_armed_native_head_keeps_law_free_of_catalog(install, verdicts):
    # Edit-armed native turn: write tools + index come from the ARRAY, not
    # the head; the array carries them.
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 9000'}],
        editSkill=True))
    head = scripted.payloads[0]['messages'][0]['content']
    assert '- config_edit:' not in head
    names = _payload_tool_names(scripted.payloads[0])
    assert 'config_edit' in names


def test_route_spawns_probe_once_for_local_auto_arm(install, verdicts, monkeypatch):
    spawned = []
    monkeypatch.setattr(
        ai_routes, '_spawn_native_tools_probe',
        lambda key, api_url, model, api_key: spawned.append((key, api_url, model)))
    # provider=openai-compatible + auto + no verdict -> the route asks for a
    # probe EVERY request while the verdict is unknown; the spawn function's
    # own pending-set is what makes it fire once (tested separately).
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}],
        apiProvider='openai-compatible',
        apiUrl='http://192.0.2.7:8080/v1/chat/completions'))
    assert len(spawned) == 1
    key, url, model = spawned[0]
    assert key == ai_routes._url_model_key(
        'http://192.0.2.7:8080/v1/chat/completions', 'test-model')
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q2'}],
        apiProvider='openai-compatible',
        apiUrl='http://192.0.2.7:8080/v1/chat/completions'))
    assert len(spawned) == 2
    # recorded verdict -> no further spawn requests
    ai_routes._record_native_tools_blind(key, False, reason='delta grew')
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q3'}],
        apiProvider='openai-compatible',
        apiUrl='http://192.0.2.7:8080/v1/chat/completions'))
    assert len(spawned) == 2


def test_spawn_dedupes_per_key(monkeypatch, verdicts):
    # The real spawn function's pending-set: repeated calls for one
    # (url, model) run the probe exactly once.
    ran = []

    async def _fake_probe(key, api_url, model, api_key):
        ran.append(key)

    async def _scenario():
        # The suite-wide conftest no-ops the spawn — this test exercises
        # the REAL one: restore it, then swap the probe underneath it.
        monkeypatch.undo()
        monkeypatch.setattr(ai_routes, '_probe_native_tools_support', _fake_probe)
        key = ai_routes._url_model_key('http://192.0.2.7:8080/v1', 'm')
        ai_routes._spawn_native_tools_probe(key, 'http://192.0.2.7:8080/v1', 'm', '')
        ai_routes._spawn_native_tools_probe(key, 'http://192.0.2.7:8080/v1', 'm', '')
        import asyncio as _a
        await _a.sleep(0)  # let the task run
        await _a.sleep(0)

    asyncio.run(_scenario())
    assert ran == [ai_routes._url_model_key('http://192.0.2.7:8080/v1', 'm')]


def test_route_no_probe_for_cloud_or_pinned_arms(install, verdicts, monkeypatch):
    spawned = []
    monkeypatch.setattr(
        ai_routes, '_spawn_native_tools_probe',
        lambda *a, **k: spawned.append(a))
    # cloud chatgpt native: always delivers, never probe
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}]))
    assert spawned == []
    # local but harness-pinned arms (False/True) are A/B overrides: the
    # probe is for the auto path only
    scripted = install([_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'q'}],
        apiProvider='openai-compatible',
        apiUrl='http://192.0.2.7:8080/v1/chat/completions',
        nativeCatalog=True))
    assert spawned == []


# ── Probe verdict logic ──────────────────────────────────────────────────────

class _UsageResp:
    def __init__(self, prompt_tokens):
        self.status_code = 200
        self._payload = {'choices': [{'message': {'content': ''}}],
                        'usage': {'prompt_tokens': prompt_tokens}}

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _UsageClient:
    """Two POSTs: with-tools first, no-tools second (probe's internal
    order) — or raising, for the error arm."""

    def __init__(self, with_tokens, without_tokens, fail=False):
        self.calls = []
        self._tokens = [with_tokens, without_tokens]
        self._fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.calls.append(json)
        if self._fail:
            raise RuntimeError('unreachable')
        has_tools = bool(json.get('tools'))
        return _UsageResp(self._tokens[0 if has_tools else 1])


def test_probe_equal_delta_records_blind(monkeypatch, verdicts):
    scripted = _UsageClient(131, 131)
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    key = ai_routes._url_model_key('http://192.0.2.7:8080/v1/chat/completions',
                                   'm')
    asyncio.run(ai_routes._probe_native_tools_support(
        key, 'http://192.0.2.7:8080/v1/chat/completions', 'm', ''))
    assert ai_routes._NATIVE_TOOLS_BLIND[key] is True


def test_probe_growth_records_not_blind(monkeypatch, verdicts):
    scripted = _UsageClient(257, 131)
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    key = ai_routes._url_model_key('http://192.0.2.7:8080/v1/chat/completions',
                                   'm')
    asyncio.run(ai_routes._probe_native_tools_support(
        key, 'http://192.0.2.7:8080/v1/chat/completions', 'm', ''))
    assert ai_routes._NATIVE_TOOLS_BLIND[key] is False


def test_probe_failure_records_not_blind_and_logs(monkeypatch, verdicts,
                                                  caplog):
    scripted = _UsageClient(0, 0, fail=True)
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    key = ai_routes._url_model_key('http://192.0.2.7:8080/v1/chat/completions',
                                   'm')
    with caplog.at_level(logging.WARNING):
        asyncio.run(ai_routes._probe_native_tools_support(
            key, 'http://192.0.2.7:8080/v1/chat/completions', 'm', ''))
    # fail-healthy: never declare blind on a probe that could not run
    assert ai_routes._NATIVE_TOOLS_BLIND[key] is False
    assert any('probe' in rec.getMessage().lower()
               for rec in caplog.records if rec.levelno >= logging.WARNING)
