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
from mcp_server import McpServer  # noqa: E402
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


# ── v2 content law (2026-11-17 double-blind review) ──────────────────────
# Two fresh-context reviewers converged on defects v1 taught with
# confidence; every fix below is pinned either by an engine run of the
# shipped string or by an anti-pattern grep. The engine pins are the W4
# law applied to the skill itself: no unverified prose.

def _sim(**args):
    return McpServer()._handle_simulate_macro(args)


def test_shipped_examples_render_on_the_bare_call():
    """v1's examples carried params.X|float|default(...) and ABORTED on
    the bare call the same body mandated — examples are what models copy
    verbatim, so they run through the real engine on every CI run."""
    out = _sim(macro_text=ai_routes.MACRO_EX_BLINK)
    assert 'Findings: none' in out
    assert 'SET_PIN PIN=casing_light VALUE=1' in out
    out = _sim(macro_text=ai_routes.MACRO_EX_PARK,
               scenarios=[{'name': 'bare',
                           'printer_state': {'toolhead.axis_maximum.z': 250}}])
    assert 'Findings: none' in out
    assert 'G1 Z0.0 F600' in out


def test_blink_example_actually_toggles_over_two_calls():
    """v1's BLINK computed the flip but never wrote it back — a toggle
    that never toggles. The pin re-derives the runs=2 proof, which only
    holds while the SET_GCODE_VARIABLE line ships."""
    out = _sim(macro_text=ai_routes.MACRO_EX_BLINK, runs=2)
    first, second = out.split('## call 2')
    assert 'SET_PIN PIN=casing_light VALUE=1' in first
    assert 'SET_PIN PIN=casing_light VALUE=0' in second
    assert 'commands differ: YES' in out


def test_body_idiom_renders_on_bare_call():
    """The prescribed order IS the proof: default-before-coerce renders;
    v1's coerce-before-default aborts (tests/test_macro_render.py)."""
    out = _sim(macro_text='[gcode_macro IDIOM]\ngcode:\n'
                          '    M106 S{params.FAN|default(0)|int}\n')
    assert 'M106 S0' in out and 'Findings: none' in out


def test_body_prescribes_default_before_coerce_order():
    body = ai_routes._macro_skill_body()
    assert '|float|default(' not in body and '|int|default(' not in body
    assert 'Default BEFORE you coerce' in body
    # empty-string params are DEFINED: boolean-form default is the only fix
    assert "default('10', true)" in body


def test_m109_law_states_the_s0_skip_and_never_waiting_m104():
    """v1 inverted the S=0 exception (heaters.py 'wait and temp') and
    called the rename_existing load conflict a 'shadow' (gcode.py
    'already registered')."""
    body = ai_routes._macro_skill_body()
    assert 'skip the wait when the target is 0' in body
    assert 'M104/M140 are Set-only and NEVER wait' in body
    assert 'SHADOWS' not in body
    assert 'already registered' in body
    # TEMPERATURE_WAIT is the cooldown / no-M109-heater wait, not forbidden
    assert 'TEMPERATURE_WAIT SENSOR=extruder MAXIMUM=60' in body


def test_doc_pointers_use_the_real_arg_names():
    """v1 prescribed read_klipper_doc(name=...) while the schema requires
    filename — unexecutable for schema-less text-protocol models."""
    body = ai_routes._macro_skill_body()
    assert 'read_klipper_doc(name=' not in body
    assert "filename='Command_Templates.md'" in body
    assert "get_config_reference_section(section_name='gcode_macro')" in body
    assert 'list_klipper_docs' in body


def test_verdict_answer_law_is_gone_guard_still_carries_it():
    """Cliff 2026-11-17: four prose levers failed MACRO-17; the mechanical
    trace guard (tests/test_sim_verdict_guard.py) enforces it instead."""
    body = ai_routes._macro_skill_body()
    assert 'FIRST SENTENCE' not in body
    assert 'macros it invokes are NOT' in body  # non-recursion disclosed
    assert "load_skill(name='config-editing') " in body  # staged at step 4


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
