"""Tests for Phase 6.5: mid-loop progress emit + ack guard.

Progress (6.5.1/6.5.3): the loop publishes the extracted tool batch and
the turn's narration to _chat_progress BEFORE execution; GET
/ai/chat/progress relays it while the request is in flight and reports
pending:false afterwards; the final response carries narrationTurns.

Ack guard (6.5.2): an edit request whose reply ENDS on a continue-intent
promise with no tool call and zero write attempts gets exactly ONE
injected execution directive (usage.ackReprompts==1). Must fire on BOTH
tool protocols; must NOT fire on pure Q&A, on complete answers that
merely mention a future action early, or after any write tool fired.
"""
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from api.printer_memory_routes import PrinterMemory  # noqa: E402

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
"""


class DummyResponse:
    def __init__(self, payload, *, status_code=200, url='http://example.test'):
        self._payload = payload
        self.status_code = status_code
        self.request = httpx.Request('POST', url)
        self.text = ''

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('request failed', request=self.request, response=self)

    def json(self):
        return self._payload


class ScriptedClient:
    """Replays scripted provider replies; records every outgoing payload."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.payloads = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.payloads.append(json)
        reply = self.replies.pop(0) if self.replies else {'choices': [{'message': {'content': 'fallback'}}]}
        return DummyResponse(reply, url=url)


@pytest.fixture()
def blank_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")


def _chat(payload_over, replies, monkeypatch):
    scripted = ScriptedClient(replies)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: scripted)
    body = {
        'messages': [{'role': 'user', 'content': 'Change my max_accel to 4000 in printer.cfg'}],
        'apiKey': 'test-key',
        'model': 'test-model',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt',
        'contextFiles': {'printer.cfg': {'content': PRINTER_CFG}},
        'autoApproveEdits': True,
        'editSkill': True,
    }
    body.update(payload_over)
    response = client.post('/ai/chat', json=body)
    assert response.status_code == 200
    return response.json(), scripted


# ── _ends_with_continue_intent (tail discipline) ───────────────────────


def test_continue_intent_tail_positive():
    assert ai_routes._ends_with_continue_intent("I'll now apply that to your config.")
    assert ai_routes._ends_with_continue_intent('Done reading. Let me make the change now.')
    assert ai_routes._ends_with_continue_intent("Sure!\n\nI will update max_accel next.")


def test_continue_intent_complete_answer_not_matched():
    # Answered question that merely MENTIONS a future action early: the
    # tail is the answer, not a promise. The guard must never gaslight a
    # correct answer (Q20 r3/B lesson).
    assert not ai_routes._ends_with_continue_intent(
        "I will check the docs. horizontal_move_z is the Z hop height "
        "before XY travel, default 5mm."
    )
    assert not ai_routes._ends_with_continue_intent('')
    assert not ai_routes._ends_with_continue_intent(
        'max_accel is already 4000 in your config, no change needed.'
    )


# ── Ack guard: fires once, both protocols ──────────────────────────────


def test_ack_guard_fires_once_native(blank_memory, monkeypatch):
    # Reply 1: pure continue-intent promise, no tool call → guard nudges.
    # Reply 2: the model then actually calls a read tool → loop continues.
    # Reply 3: final answer.
    body, scripted = _chat(
        {'requestId': 'ack-native-1'},
        [
            {'choices': [{'message': {'content': "I'll now apply that change to your printer.cfg."}}]},
            {'choices': [{'message': {
                'content': None,
                'tool_calls': [{
                    'type': 'function', 'id': 'c1',
                    'function': {'name': 'read_user_config',
                                 'arguments': json.dumps({'filename': 'printer.cfg'})},
                }],
            }}]},
            {'choices': [{'message': {'content': 'Read the file, here is the answer.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 1
    # The injected directive is the 2nd request's trailing user message.
    second = scripted.payloads[1]['messages'][-1]
    assert second['role'] == 'user'
    assert 'Execute the edit now' in second['content']
    # The promised reply is kept in history (cleaned), not dropped.
    assert any(m['role'] == 'assistant' and 'apply that change' in str(m.get('content', ''))
               for m in scripted.payloads[1]['messages'])


def test_ack_guard_fires_once_text_protocol(blank_memory, monkeypatch):
    # Text protocol (local provider over http): promise-shaped prose is
    # messier here — the guard's tail check runs on visible text, so it
    # must behave identically.
    body, scripted = _chat(
        {'requestId': 'ack-text-1',
         'apiProvider': 'openai-compatible',
         'apiUrl': 'http://192.168.1.145:1237/v1/chat/completions',
         'apiKey': ''},
        [
            {'choices': [{'message': {'content': 'Let me update max_accel to 4000 for you now.'}}]},
            {'choices': [{'message': {'content': 'The change has been made to max_accel: 4000.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 1
    injected = scripted.payloads[1]['messages'][-1]
    assert 'Execute the edit now' in injected['content']


def test_ack_guard_capped_at_one(blank_memory, monkeypatch):
    # Model acks TWICE: second promise must NOT re-nudge (cap 1 — each
    # re-prompt is real llama.cpp latency). The second ack terminates:
    # reply 3 is prose again, loop breaks after it with zero nudges more.
    body, scripted = _chat(
        {'requestId': 'ack-cap-1'},
        [
            {'choices': [{'message': {'content': "I'll apply that now."}}]},
            {'choices': [{'message': {'content': 'Yes, I will make that change to the config now.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 1
    # exactly one extra request beyond the initial
    assert len(scripted.payloads) == 2


def test_ack_guard_locked_gate_uses_load_skill_arm(blank_memory, monkeypatch):
    # With the skill gate CLOSED (editSkill not forced), the write tools
    # are not advertised — the directive must be the load step, not an
    # order to use a tool the model cannot see.
    body, scripted = _chat(
        {'requestId': 'ack-gate-1', 'editSkill': False},
        [
            {'choices': [{'message': {'content': 'I will now edit printer.cfg for you.'}}]},
            {'choices': [{'message': {'content': 'Loaded. The edit is staged.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 1
    injected = scripted.payloads[1]['messages'][-1]
    assert "load_skill(name='config-editing')" in injected['content']
    assert 'Execute the edit now' not in injected['content']


def test_ack_guard_not_fired_on_pure_qa(blank_memory, monkeypatch):
    # Gate: _is_edit_request. A non-edit question ending "let me know" —
    # no session edit intent → guard must not fire.
    body, scripted = _chat(
        {'requestId': 'ack-neg-1',
         'messages': [{'role': 'user', 'content': 'What does pressure_advance do? Let me know if docs cover it.'}]},
        [
            {'choices': [{'message': {'content': 'Pressure advance reduces ringing by adjusting extrusion.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 0
    assert len(scripted.payloads) == 1


def test_ack_guard_not_fired_after_write_tool(blank_memory, monkeypatch):
    # Once a write tool has fired, a closing promise is a report on a
    # partial success — the confab guard owns the staged-nothing case.
    edit_call = {'choices': [{'message': {
        'content': 'Applying now.',
        'tool_calls': [{
            'type': 'function', 'id': 'c1',
            'function': {'name': 'config_edit', 'arguments': json.dumps({
                'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
                'key': 'max_accel', 'value': '4000'})},
        }],
    }}]}
    body, scripted = _chat(
        {'requestId': 'ack-postwrite-1'},
        [
            edit_call,
            {'choices': [{'message': {'content': 'I will summarize the change now.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 0
    # write actually staged; only the initial + tool-turn queries ran
    assert len(scripted.payloads) == 2
    assert body['editAttempts'] == 1


def test_ack_guard_edit_prose_nudge_owns_inert_draft(blank_memory, monkeypatch):
    # A cfg-fenced inert draft is stronger evidence than a promise tail:
    # the edit-prose nudge (not the ack guard) must own it.
    draft = ('I will show you the change:\n\n```cfg\n[printer]\nmax_accel: 4000\n```\n\n'
             'I will apply that now.')
    body, scripted = _chat(
        {'requestId': 'ack-draft-1'},
        [
            {'choices': [{'message': {'content': draft}}]},
            {'choices': [{'message': {'content': 'The change is staged.'}}]},
        ],
        monkeypatch,
    )
    # ack guard silent (edit-prose nudge consumed the turn instead)
    assert body['usage']['ackReprompts'] == 0
    injected = scripted.payloads[1]['messages'][-1]
    assert injected['content'] == ai_routes.EDIT_NUDGE_TEXT_NATIVE


# ── Progress registry + endpoint (6.5.1 / 6.5.3) ───────────────────────


def test_progress_emitted_before_execution_and_cleared(blank_memory, monkeypatch):
    seen = {}

    real_async = ai_routes._execute_tool_call_async

    async def spy(call):
        # Mid-execution, the poll must already see THIS batch (emit point
        # is before execution).
        entry = ai_routes._chat_progress.get('prog-1')
        seen['entry'] = dict(entry) if entry else None
        return await real_async(call)

    monkeypatch.setattr(ai_routes, '_execute_tool_call_async', spy)

    body, _ = _chat(
        {'requestId': 'prog-1',
         'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}]},
        [
            {'choices': [{'message': {
                'content': 'Let me look that up in the docs.',
                'tool_calls': [{
                    'type': 'function', 'id': 'c1',
                    'function': {'name': 'search_klipper_docs',
                                 'arguments': json.dumps({'query': 'horizontal_move_z'})},
                }],
            }}]},
            {'choices': [{'message': {'content': 'It is the Z hop before XY travel.'}}]},
        ],
        monkeypatch,
    )

    assert seen['entry']['toolNames'] == ['search_klipper_docs']
    assert seen['entry']['narration'] == 'Let me look that up in the docs.'
    assert seen['entry']['turn'] == 1
    # Registry entry is gone after the request finishes (finally-clear).
    assert 'prog-1' not in ai_routes._chat_progress
    # narrationTurns rides on the final response for harness grading.
    assert body['narrationTurns'] == [{
        'turn': 1,
        'narration': 'Let me look that up in the docs.',
        'toolNames': ['search_klipper_docs'],
    }]


def test_progress_endpoint_shapes(blank_memory, monkeypatch):
    # No requestId → pending false.
    assert client.get('/ai/chat/progress').json() == {'pending': False}
    # Unknown requestId → pending false.
    assert client.get('/ai/chat/progress?requestId=nope').json() == {'pending': False}

    # Mid-flight: seed a registry entry and poll it.
    import time as _t
    ai_routes._chat_progress['live-1'] = {
        'turn': 3, 'narration': 'Checking the macro.', 'toolNames': ['read_user_config'],
        'startedAt': _t.monotonic() - 2.0, 'lastText': 'Checking the macro.', 'turns': [],
    }
    poll = client.get('/ai/chat/progress?requestId=live-1').json()
    assert poll['pending'] is True
    assert poll['turn'] == 3
    assert poll['toolNames'] == ['read_user_config']
    assert poll['narration'] == 'Checking the macro.'
    assert poll['elapsedMs'] >= 1500
    ai_routes._chat_progress.pop('live-1', None)


def test_progress_narration_text_protocol_stripped(blank_memory, monkeypatch):
    # Text protocol: the emit-point narration must have the ```tool fence
    # removed, prose kept (the turn's VISIBLE text, not raw markup).
    seen = {}

    async def spy(call):
        entry = ai_routes._chat_progress.get('prog-text-1')
        seen['narration'] = entry['narration'] if entry else None
        return f"result for {call['name']}"

    monkeypatch.setattr(ai_routes, '_execute_tool_call_async', spy)

    _chat(
        {'requestId': 'prog-text-1',
         'apiProvider': 'openai-compatible',
         'apiUrl': 'http://192.168.1.145:1237/v1/chat/completions', 'apiKey': '',
         'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}]},
        [
            {'choices': [{'message': {'content': (
                'Reading the docs now.\n\n'
                '```tool\n{"name": "search_klipper_docs", "arguments": {"query": "horizontal_move_z"}}\n```'
            )}}]},
            {'choices': [{'message': {'content': 'It is the Z hop height.'}}]},
        ],
        monkeypatch,
    )
    assert seen['narration'] == 'Reading the docs now.'


def test_progress_dedupe_identical_consecutive_narration(blank_memory, monkeypatch):
    # Hermes invariant: identical narration across consecutive tool turns
    # never re-accumulates (per-turn dedupe set). Spied mid-execution
    # because the registry is cleared in the request's finally.
    seen = {}

    async def spy(call):
        entry = ai_routes._chat_progress.get('prog-dup-2')
        if entry:
            seen['turns'] = list(entry['turns'])
        return f"result for {call['name']}"

    monkeypatch.setattr(ai_routes, '_execute_tool_call_async', spy)
    _chat(
        {'requestId': 'prog-dup-2',
         'messages': [{'role': 'user', 'content': 'What does [bed_mesh] horizontal_move_z do?'}]},
        [
            {'choices': [{'message': {
                'content': 'Checking.',
                'tool_calls': [{'type': 'function', 'id': 'a', 'function': {
                    'name': 'search_klipper_docs', 'arguments': json.dumps({'query': 'a'})}}],
            }}]},
            {'choices': [{'message': {
                'content': 'Checking.',
                'tool_calls': [{'type': 'function', 'id': 'b', 'function': {
                    'name': 'search_klipper_docs', 'arguments': json.dumps({'query': 'b'})}}],
            }}]},
            {'choices': [{'message': {'content': 'Answer.'}}]},
        ],
        monkeypatch,
    )
    assert len(seen['turns']) == 1  # second identical narration deduped
