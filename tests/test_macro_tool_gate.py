"""Lazy gate: validate_macro / simulate_macro behind load_skill('macro-authoring').

Token motivation: the two schemas are ~2.1k tokens of every request's fixed
head; dogfood traces show the model ALREADY loads macro-authoring before
33/39 validate/simulate calls. The gate mirrors the config-editing pattern:

Registry law — the gated tool NAMES live only in _SKILL_REGISTRY
('gates_tools'); builders and dispatch read the derived set.

Invariant A for the macro surface: gated tools advertised ⇒ the macro
body ('Skill 'macro-authoring' loaded.') rides the same outbound prompt.

State law: initial = client sticky flag (loadedSkills) OR mechanical trail
evidence (_skill_load_in_trail); mid-request load_skill flips and
re-resolves (same-turn unlock, edit precedent). A closed-gate call kicks
back with the load step and NEVER executes.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

GATED = {"validate_macro", "simulate_macro"}
MACRO_BODY_MARKER = "Skill 'macro-authoring' loaded."

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


def _native_tool_call(name, arguments):
    return {'choices': [{'message': {
        'content': '',
        'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {
            'name': name, 'arguments': json.dumps(arguments),
        }}],
    }}]}


def _text_tool_block(name, arguments):
    body = json.dumps({"name": name, "arguments": arguments})
    return {'choices': [{'message': {'content': f"```tool\n{body}\n```"}}]}


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

    def _install(replies):
        scripted = _ScriptedClient(replies)
        monkeypatch.setattr(ai_routes.httpx, 'AsyncClient',
                            lambda *a, **k: scripted)
        return scripted

    return _install


def _payload_tool_names(payload):
    return {t['function']['name'] for t in payload.get('tools') or []}


def _payload_text(payload):
    return json.dumps(payload.get('messages') or [])


# ── Registry law ─────────────────────────────────────────────────────────────

def test_registry_declares_the_gated_surface():
    entry = ai_routes._SKILL_REGISTRY[ai_routes.MACRO_SKILL_NAME]
    assert set(entry["gates_tools"]) == GATED
    # config-editing keeps the SOLE write unlock
    for name, e in ai_routes._SKILL_REGISTRY.items():
        if name != ai_routes.MACRO_SKILL_NAME:
            assert not set(e.get("gates_tools", [])) & GATED
    assert ai_routes._SKILL_REGISTRY[ai_routes.EDIT_SKILL_NAME]["gates_write"]


# ── Builder units: BOTH surfaces, lock-step ──────────────────────────────────

@pytest.mark.parametrize("edit_capable", [False, True])
def test_native_tools_hidden_while_gate_closed(edit_capable):
    names = {t["function"]["name"] for t in ai_routes._build_native_tools(
        edit_capable, skill_active=False, macro_skill_active=False)}
    assert not (names & GATED)
    # load_skill is advertised on EVERY arm — the read-only path needs it
    # to unlock the macro surface.
    assert "load_skill" in names


@pytest.mark.parametrize("edit_capable", [False, True])
def test_native_tools_present_when_armed(edit_capable):
    names = {t["function"]["name"] for t in ai_routes._build_native_tools(
        edit_capable, skill_active=True, macro_skill_active=True)}
    assert GATED <= names


@pytest.mark.parametrize("macro_active,expect_present", [(False, False), (True, True)])
def test_head_snippets_lock_step_with_native(macro_active, expect_present):
    head = ai_routes._build_mcp_tool_context(
        edit_capable=True, skill_active=True, macro_skill_active=macro_active)
    for tool in GATED:
        assert (f"- {tool}:" in head) is expect_present


def test_head_shows_skill_index_while_macro_gate_closed():
    # Edit gate OPEN but macro gate CLOSED: the index must still ride —
    # it is the model's only pointer at the locked macro tools.
    head = ai_routes._build_mcp_tool_context(
        edit_capable=True, skill_active=True, macro_skill_active=False)
    assert "<available_skills>" in head
    assert ai_routes.MACRO_SKILL_NAME in head


def test_skill_index_names_the_unlocked_tools():
    # The activation lever is the index text (measured law): it must NAME
    # what loading unlocks, incl. validating/checking as a trigger.
    text = ai_routes._SKILL_INDEX_BLOCK.lower()
    assert "validate_macro" in text and "simulate_macro" in text
    assert "validat" in text  # checking/validating counts, not just writing


# ── Route level: sticky start, mid-request unlock, closed-gate kickback ─────

def test_sticky_flag_arms_from_the_start(install):
    scripted = install([_final_reply()])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'simulate my park macro'}],
        loadedSkills=['macro-authoring']))
    assert r.status_code == 200
    payload = scripted.payloads[0]
    assert GATED <= _payload_tool_names(payload)
    # Invariant A for the macro surface: tools without the rulebook = half-arming
    assert MACRO_BODY_MARKER in _payload_text(payload)


def test_trail_evidence_arms_without_the_flag(install):
    trail = [
        {'role': 'user', 'content': 'does BLINK need homing?'},
        {'role': 'assistant',
         'content': "[Tool result: load_skill(name=macro-authoring)] rules..."},
        {'role': 'assistant', 'content': 'Checked.'},
        {'role': 'user', 'content': 'now simulate it'},
    ]
    scripted = install([_final_reply()])
    r = client.post('/ai/chat', json=_chat_payload(trail))
    assert r.status_code == 200
    assert GATED <= _payload_tool_names(scripted.payloads[0])


def test_mid_request_load_rearms_next_payload(install):
    scripted = install([
        _native_tool_call('load_skill', {'name': 'macro-authoring'}),
        _final_reply('Loaded.'),
    ])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'validate my macro'}]))
    assert r.status_code == 200
    assert not (GATED & _payload_tool_names(scripted.payloads[0]))
    assert GATED <= _payload_tool_names(scripted.payloads[1])


def test_closed_gate_call_kicks_back_and_never_executes(install, monkeypatch):
    # Text protocol: the tool is invisible in the tools array but a model
    # can still emit the fence — dispatch must block with the load step,
    # not execute (validate_macro would touch the real validator).
    calls = []
    monkeypatch.setattr(
        ai_routes._mcp_server, "_handle_validate_macro",
        lambda *a, **k: calls.append(1))
    scripted = install([
        _text_tool_block('validate_macro', {'macro_text': '[gcode_macro X]\ngcode:\n  G28'}),
        _final_reply('Understood — loading the skill first.'),
    ])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'validate my macro'}],
        toolProtocol='text'))
    assert r.status_code == 200
    assert calls == []
    followup = _payload_text(scripted.payloads[1])
    assert "not available yet" in followup
    assert "load_skill(name='macro-authoring')" in followup


def test_armed_gate_executes_normally(install, monkeypatch):
    hits = []
    monkeypatch.setattr(
        ai_routes._mcp_server, "_handle_validate_macro",
        lambda args: (hits.append(1) or
                      json.dumps({"errors": [], "warnings": []})))
    scripted = install([
        _native_tool_call('validate_macro', {'macro_text': '[gcode_macro X]\ngcode:\n  G28'}),
        _final_reply('It validates clean.'),
    ])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'validate my macro'}],
        loadedSkills=['macro-authoring']))
    assert r.status_code == 200
    assert hits == [1]


def test_non_macro_requests_never_pay_the_schemas(install):
    scripted = install([_final_reply('ok')])
    r = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what is a stepper driver?'}]))
    assert r.status_code == 200
    payload = scripted.payloads[0]
    assert not (GATED & _payload_tool_names(payload))
    text = _payload_text(payload)
    assert MACRO_BODY_MARKER not in text
