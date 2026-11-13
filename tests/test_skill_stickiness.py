"""W0 — Sticky per-conversation skill activation (editSkillLoaded + body re-injection).

Pins the two load-bearing invariants from the macro-jinja-reliability plan
(Cliff-approved, 2026-11-12):

Invariant A (atomic armament): a provider-bound request NEVER advertises
config_edit/config_write without the edit-skill body present in the same
outbound prompt. Half-arming (tools without the rulebook) is forbidden.

Invariant B (trailing injection): the body injects as a TRAILING system
message at the context_references seam (never head) — survives
head-truncation and keeps the KV-cache prefix byte-identical.

Also pins: harness editSkill semantics unchanged; no-flag/no-evidence stays
closed (regression of pre-W0 behavior); idempotence (a trail already carrying
the body gets no second copy).
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

# First line of _edit_skill_body() — the idempotence marker (plan W0).
BODY_MARKER = "Skill 'config-editing' loaded"

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100
"""


def _ctx():
    return {'printer.cfg': {'content': PRINTER_CFG}}


def _chat_payload(messages, **over):
    """Edit-capable request WITHOUT forcing editSkill — the stickiness flag
    under test must arm the gate by itself (or not at all)."""
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
    """Stand-in for httpx.AsyncClient replaying scripted provider replies."""

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
    """Return a factory that scripts provider replies; also clears the
    prompt-ablation env so injection is never gated off."""
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


def _payload_messages_text(payload):
    return json.dumps(payload.get('messages') or [])


def assert_atomic_armament(payload):
    """Invariant A: edit tools advertised ⇒ the same outbound prompt carries
    the skill body (body first line or the text-protocol result marker that
    wraps it)."""
    if EDIT_TOOL_NAMES.intersection(_payload_tool_names(payload)):
        text = _payload_messages_text(payload)
        assert (BODY_MARKER in text
                or '[Tool result: load_skill(name=config-editing' in text), (
            'Invariant A violated: write tools advertised without the skill '
            'body in the same outbound prompt'
        )


# ── Route level: the flag arms the request ──────────────────────────────

def test_flag_arms_write_tools_and_injects_body_once(install):
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Make the LED toggle macro work.'}],
        editSkillLoaded=True,
    ))
    assert resp.status_code == 200
    assert len(scripted.payloads) == 1
    p = scripted.payloads[0]
    names = _payload_tool_names(p)
    assert 'config_edit' in names and 'config_write' in names
    assert _payload_messages_text(p).count(BODY_MARKER) == 1
    assert_atomic_armament(p)


def test_no_flag_no_evidence_stays_closed(install):
    """Regression pin of pre-W0 behavior: no flag, no trail evidence → gate
    closed, no write tools, no body."""
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'What is pressure advance?'}],
    ))
    assert resp.status_code == 200
    p = scripted.payloads[0]
    assert EDIT_TOOL_NAMES.isdisjoint(_payload_tool_names(p))
    assert 'load_skill' in _payload_tool_names(p)
    assert BODY_MARKER not in _payload_messages_text(p)
    assert_atomic_armament(p)


def test_body_marker_in_trail_gets_no_duplicate_injection(install):
    """Model loaded the skill last turn under the text protocol: the trail
    already carries the body — the re-injection must stay idempotent."""
    body = ai_routes._edit_skill_body()
    trail = [
        {'role': 'user', 'content': 'Add an LED toggle macro.'},
        {'role': 'assistant', 'content': (
            f'[Tool result: load_skill(name=config-editing)]\n\n{body}\n\n'
            '[End tool result.] I loaded the skill.'
        )},
    ]
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        trail, editSkillLoaded=True,
    ))
    assert resp.status_code == 200
    p = scripted.payloads[0]
    assert 'config_edit' in _payload_tool_names(p)
    # Exactly the trail's own copy — no second injection.
    assert _payload_messages_text(p).count(BODY_MARKER) == 1
    assert_atomic_armament(p)


def test_harness_edit_skill_semantics_unchanged_without_flag(install):
    """editSkill=True still forces the unlocked arm when editSkillLoaded is
    unset (harness A/B untouched) — and per Invariant A the body rides too."""
    scripted = install([_final_reply()])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Set max_accel to 1500.'}],
        editSkill=True,
    ))
    assert resp.status_code == 200
    p = scripted.payloads[0]
    assert EDIT_TOOL_NAMES <= _payload_tool_names(p)
    assert _payload_messages_text(p).count(BODY_MARKER) == 1
    assert_atomic_armament(p)


def test_invariant_a_holds_for_mid_request_activation(install):
    """Flag off; the model calls load_skill mid-loop. Every captured payload
    (before AND after activation) must satisfy atomic armament."""
    scripted = install([
        _native_tool_call('load_skill', {'name': 'config-editing'}),
        _final_reply('Skill loaded, ready to edit.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Add a purge line to PRINT_START.'}],
        editSkillLoaded=False,
    ))
    assert resp.status_code == 200
    assert len(scripted.payloads) >= 2
    for p in scripted.payloads:
        assert_atomic_armament(p)
    # Activation really happened: the LAST payload advertises the write tools.
    assert EDIT_TOOL_NAMES <= _payload_tool_names(scripted.payloads[-1])


# ── Unit level: seam position + injection mechanics ─────────────────────

def test_body_injects_as_the_last_message_after_references(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    prepared = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True,
        skill_active=True,
        inject_edit_skill_body=True,
        context_references=[{
            'id': 'lines:printer.cfg:1-3',
            'kind': 'lines',
            'file': 'printer.cfg',
            'startLine': 1,
            'endLine': 3,
            'text': 'max_accel: 3000\nsquare_corner_velocity: 5',
        }],
    )
    assert prepared[-1]['role'] == 'system'
    assert prepared[-1]['content'].startswith(BODY_MARKER)
    # The references block keeps its own message directly above the body —
    # the body rides LAST (trailing seam, never head).
    assert prepared[0]['role'] == 'system'
    assert BODY_MARKER not in prepared[0]['content']
    assert any(m is not prepared[-1] and m['role'] == 'system'
               and 'printer.cfg:1-3' in m['content'] for m in prepared)


def test_no_injection_without_the_flag(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    prepared = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True,
        skill_active=True,
    )
    assert BODY_MARKER not in json.dumps(prepared)


def test_injection_is_idempotent_when_the_trail_has_the_body(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    body = ai_routes._edit_skill_body()
    prepared = ai_routes._prepare_messages(
        [
            {'role': 'user', 'content': 'hi'},
            {'role': 'assistant', 'content': f'[Tool result: load_skill(name=config-editing)]\n\n{body}'},
        ],
        edit_capable=True,
        skill_active=True,
        inject_edit_skill_body=True,
    )
    assert json.dumps(prepared).count(BODY_MARKER) == 1


@pytest.mark.parametrize('env', ['KWC_MINIMAL_PROMPT', 'KWC_NO_SYSTEM'])
def test_ablation_gates_never_get_the_injection(monkeypatch, env):
    """The ablation instruments carry no edit-tool surface (minimal: tools
    context without edit capability; no_system: nothing) — the body must not
    show up there either way (Invariant A cannot break)."""
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.setenv(env, '1')
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    prepared = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True,
        skill_active=True,
        inject_edit_skill_body=True,
    )
    assert BODY_MARKER not in json.dumps(prepared)
