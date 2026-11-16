"""W4-R2 — macro-authoring knowledge skill + multi-skill loading.

Cliff's ruling (2026-11-16): the edit skill stays tool-mechanics law; Klipper
macro authoring knowledge (Jinja rules, validate/simulate workflow, pitfalls,
examples) lives in its own skill, loaded on demand — never injected into
conversations that don't ask for it. Multi-skill: load_skill supports more
than one skill per conversation; loading a knowledge skill NEVER unlocks
write tools (the edit gate is still earned only by config-editing).

Pins:
- registry: spec enum + unknown-skill message cover all three skills
- dispatch: load_skill(macro-authoring) returns its body, gate stays closed
- two-skill flow: config-editing + macro-authoring coexist
- stickiness: loadedSkills=['macro-authoring'] re-injects its body at the
  trailing seam (lean replay survives); printer-memory is NOT sticky (its
  playbook is one-shot); bodies ride in registry order, before the ledger
- idempotence: a trail already carrying the macro body gets no second copy
- ablation: minimal/no_system never carry skill bodies (Invariant A parity)
- content law: the M109 rule MOVED from the edit body to the macro body
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from services.ai_edit_tools import EDIT_TOOL_NAMES  # noqa: E402

client = TestClient(app)

EDIT_MARKER = "Skill 'config-editing' loaded"
MACRO_MARKER = "Skill 'macro-authoring' loaded"
MEMORY_MARKER = "Skill 'printer-memory' loaded"

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000

[output_pin casing_light]
pin: PF5
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


def _tool_names(payload):
    return {t['function']['name'] for t in payload.get('tools') or []}


def _text(payload):
    return json.dumps(payload.get('messages') or [])


# ── Registry ─────────────────────────────────────────────────────────────

def test_spec_enum_lists_all_three_skills():
    enum = ai_routes.LOAD_SKILL_SPEC['inputSchema']['properties']['name']['enum']
    assert set(enum) >= {'config-editing', 'printer-memory', 'macro-authoring'}


def test_registry_flags_are_correct():
    reg = ai_routes._SKILL_REGISTRY
    assert reg['config-editing']['gates_write'] is True
    assert reg['config-editing']['sticky'] is True
    assert reg['printer-memory']['gates_write'] is False
    # printer-memory is a one-shot playbook: its block proposal lands in
    # the history the same turn — no per-request re-injection.
    assert reg['printer-memory']['sticky'] is False
    assert reg['macro-authoring']['gates_write'] is False
    assert reg['macro-authoring']['sticky'] is True


def test_index_block_advertises_macro_skill():
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True,
                                            skill_active=False)
    assert 'macro-authoring' in ctx


# ── Dispatch: knowledge loads never arm the gate ─────────────────────────

def test_load_macro_skill_mid_loop_never_unlocks_write_tools(install):
    scripted = install([
        _native_tool_call('load_skill', {'name': 'macro-authoring'}),
        _final_reply('Macro rules loaded.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Write me an LED toggle macro.'}],
    ))
    assert resp.status_code == 200
    tool_msgs = [m for m in scripted.payloads[-1]['messages']
                 if 'macro-authoring' in str(m.get('content', ''))]
    assert any(MACRO_MARKER in str(m.get('content', '')) for m in tool_msgs), (
        'load_skill(macro-authoring) must return the macro body')
    # Gate law: config-editing is the ONLY thing that unlocks writes.
    assert EDIT_TOOL_NAMES.isdisjoint(_tool_names(scripted.payloads[-1]))
    assert EDIT_MARKER not in _text(scripted.payloads[-1])


def test_two_skill_loads_coexist(install):
    scripted = install([
        _native_tool_call('load_skill', {'name': 'macro-authoring'}),
        _native_tool_call('load_skill', {'name': 'config-editing'}),
        _final_reply('Both loaded.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Add a purge line macro to printer.cfg.'}],
    ))
    assert resp.status_code == 200
    final = scripted.payloads[-1]
    t = _text(final)
    assert MACRO_MARKER in t and EDIT_MARKER in t
    assert EDIT_TOOL_NAMES <= _tool_names(final)


def test_unknown_skill_names_all_available(install):
    scripted = install([
        _native_tool_call('load_skill', {'name': 'nope'}),
        _final_reply('ok'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'load a skill'}],
    ))
    assert resp.status_code == 200
    t = _text(scripted.payloads[-1])
    assert "Unknown skill 'nope'" in t
    for name in ('config-editing', 'printer-memory', 'macro-authoring'):
        assert name in t


# ── Stickiness: loadedSkills re-injects sticky bodies, selectively ───────

def test_loaded_skills_flag_reinjects_macro_body_once(install):
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Why does my blink macro render empty?'}],
        loadedSkills=['macro-authoring'],
    ))
    assert resp.status_code == 200
    p = scripted.payloads[0]
    assert _text(p).count(MACRO_MARKER) == 1
    assert EDIT_MARKER not in _text(p)
    # A knowledge load never arms writes.
    assert EDIT_TOOL_NAMES.isdisjoint(_tool_names(p))


def test_loaded_skills_flag_printer_memory_is_not_sticky(install):
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what is my board?'}],
        loadedSkills=['printer-memory'],
    ))
    assert resp.status_code == 200
    assert MEMORY_MARKER not in _text(scripted.payloads[0])


def test_macro_body_in_trail_gets_no_duplicate(install):
    body = ai_routes._macro_skill_body()
    trail = [
        {'role': 'user', 'content': 'Draft a blink macro.'},
        {'role': 'assistant', 'content': (
            f'[Tool result: load_skill(name=macro-authoring)]\n\n{body}\n\n'
            '[End tool result.] Drafted.'
        )},
    ]
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        trail, loadedSkills=['macro-authoring'],
    ))
    assert resp.status_code == 200
    assert _text(scripted.payloads[0]).count(MACRO_MARKER) == 1


def test_seam_order_edit_body_then_macro_body_then_ledger(monkeypatch):
    """Unit level (the route merger concatenates system messages in its own
    order — the LAW lives in _prepare_messages): trailing seam order is
    references → edit law → sticky knowledge → work ledger → observation."""
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory())
    prepared = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'fix my macro'}],
        edit_capable=True,
        skill_active=True,
        inject_edit_skill_body=True,
        loaded_skills=['macro-authoring'],
        work_ledger=[{'turnOffset': 1, 'file': 'printer.cfg',
                      'section': 'gcode_macro BLINK', 'verdict': 'undone'}],
    )
    texts = [str(m.get('content')) for m in prepared if m['role'] == 'system']
    edit_i = next(i for i, x in enumerate(texts) if x.startswith(EDIT_MARKER))
    macro_i = next(i for i, x in enumerate(texts) if x.startswith(MACRO_MARKER))
    # startswith, not `in`: the edit body itself MENTIONS the work-ledger
    # (W6.5 rule), only the ledger message STARTS with it.
    ledger_i = next(i for i, x in enumerate(texts)
                    if x.startswith('Conversation work-ledger'))
    assert edit_i < macro_i < ledger_i == len(texts) - 1


def test_route_carries_all_three_surfaces_together(install):
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'fix my macro'}],
        editTools=True,
        editSkill=True,
        loadedSkills=['macro-authoring'],
        workLedger=[{'turnOffset': 1, 'file': 'printer.cfg',
                     'section': 'gcode_macro BLINK', 'verdict': 'undone'}],
    ))
    assert resp.status_code == 200
    t = _text(scripted.payloads[0])
    assert t.count(EDIT_MARKER) == 1
    assert t.count(MACRO_MARKER) == 1
    assert 'Conversation work-ledger' in t


@pytest.mark.parametrize('env', ['KWC_MINIMAL_PROMPT', 'KWC_NO_SYSTEM'])
def test_ablation_never_carries_the_macro_body(install, monkeypatch, env):
    scripted = install([_final_reply()])
    monkeypatch.setenv(env, '1')
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'hi'}],
        loadedSkills=['macro-authoring'],
    ))
    assert resp.status_code == 200
    assert MACRO_MARKER not in _text(scripted.payloads[0])


# ── Content law ──────────────────────────────────────────────────────────

def test_m109_rule_moved_out_of_edit_body():
    from services.ai_edit_tools import EDIT_PROTOCOL_PROMPT
    macro_body = ai_routes._macro_skill_body()
    assert 'M109' not in EDIT_PROTOCOL_PROMPT
    assert 'M109' in macro_body


def test_macro_body_covers_enforced_pitfalls_and_workflow():
    body = ai_routes._macro_skill_body()
    # Enforced-rule vocabulary (each maps to a validator/sim code).
    for needle in ('default(', 'SET_LED', 'validate_macro', 'simulate_macro',
                   'rename_existing', 'SAVE_GCODE_STATE'):
        assert needle in body, f'macro body missing enforced rule: {needle}'
    # Named doc pointers — specific, not "read the docs".
    assert 'Command_Templates' in body
    assert 'read_klipper_doc' in body


# ── Wire: editSkillLoaded deleted (single path) ──────────────────────────

def test_legacy_edit_skill_loaded_field_is_gone():
    fields = set(ai_routes.ChatRequest.model_fields)
    assert 'loadedSkills' in fields
    assert 'editSkillLoaded' not in fields


def test_loaded_skills_can_carry_edit_skill_stickiness(install):
    """The generalized field subsumes the old boolean: listing
    config-editing arms the request exactly as editSkillLoaded did."""
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Set max_accel to 1200.'}],
        loadedSkills=['config-editing'],
        editTools=True,
    ))
    assert resp.status_code == 200
    p = scripted.payloads[0]
    assert EDIT_TOOL_NAMES <= _tool_names(p)
    assert _text(p).count(EDIT_MARKER) == 1
