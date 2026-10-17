"""Tests for Step 4: completion check at the loop-exit seam.

An edit-INTENT request closing on confident prose gets ONE re-query
(usage.completionKicks==1) re-presenting the request plus its own trace
ledger (KWC_COMPLETION_CHECK=bare|ledger, default ledger). Must fire on
BOTH tool protocols; must NOT fire on pure Q&A, on cfg-fenced closes
(edit-prose nudge's case), on continue-intent tails (ack guard's case),
or on tails asking the user a question. Second prose exit closes
normally; a steer clears the counter.

Unit tests pin the directive text (bare/ledger, section cap, failed-
call lines, multi-file) directly against the pure function.
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
from services.ai_edit_tools import (  # noqa: E402
    COMPLETION_LEDGER_SECTION_CAP,
    EditSession,
    completion_check_mode,
    completion_kickback_directive,
)

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000

[stepper_x]
step_pin: PF13
rotation_distance: 40
microsteps: 16

[stepper_y]
step_pin: PF11
rotation_distance: 40
microsteps: 16
"""


class DummyResponse:
    def __init__(self, payload, *, status_code=200, url='http://example.test'):
        self._payload = payload
        self.status_code = status_code
        self.request = httpx.Request('POST', url)
        self.text = ''

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('request failed', request=self.request,
                                        response=self)

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
        reply = self.replies.pop(0) if self.replies else {
            'choices': [{'message': {'content': 'fallback'}}]}
        return DummyResponse(reply, url=url)


@pytest.fixture()
def blank_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory())
    monkeypatch.delenv('KWC_COMPLETION_CHECK', raising=False)
    monkeypatch.delenv('KWC_THRASH_BUDGET', raising=False)


def _chat(payload_over, replies, monkeypatch):
    scripted = ScriptedClient(replies)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: scripted)
    body = {
        'messages': [{'role': 'user',
                      'content': 'Change my max_accel to 4000 in printer.cfg'}],
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


def _edit_call(value='4000', section='printer'):
    return {'choices': [{'message': {
        'content': 'Applying now.',
        'tool_calls': [{
            'type': 'function', 'id': 'c1',
            'function': {'name': 'config_edit', 'arguments': json.dumps({
                'file': 'printer.cfg', 'op': 'set_param', 'section': section,
                'key': 'max_accel', 'value': value})},
        }],
    }}]}


# ── directive text (pure fn, both arms) ────────────────────────────────


def _session(records=(), failures=0, notes=()):
    s = EditSession({'printer.cfg': {'content': PRINTER_CFG}})
    for r in records:
        s.edit_records.append(r)
    s.write_failures = failures
    s.failure_notes = list(notes)
    return s


def _rec(file, section, op='set_param', key='', superseded=False):
    return {'file': file, 'section': section, 'key': key, 'op': op,
            'summary': '', 'superseded': superseded}


def test_mode_default_and_env():
    assert completion_check_mode() == 'ledger'
    import os
    old = os.environ.get('KWC_COMPLETION_CHECK')
    try:
        os.environ['KWC_COMPLETION_CHECK'] = 'bare'
        assert completion_check_mode() == 'bare'
        os.environ['KWC_COMPLETION_CHECK'] = 'garbage'
        assert completion_check_mode() == 'ledger'
    finally:
        if old is None:
            del os.environ['KWC_COMPLETION_CHECK']
        else:
            os.environ['KWC_COMPLETION_CHECK'] = old


def test_directive_bare_arms_verbatim_prompt():
    text = completion_kickback_directive(
        'comment every section', _session(), mode='bare')
    assert text == (
        'COMPLETION CHECK — Your request: "comment every section". Is it '
        'entirely resolved with the edits made? If not, continue with the '
        'edit tools now.')


def test_directive_ledger_zero_edits_no_failures():
    text = completion_kickback_directive(
        'do the thing', _session(), mode='ledger')
    assert 'staged 0 edits.' in text
    assert 'failed calls' not in text
    assert 'If you deliberately skipped items, name them in your reply.' in text


def test_directive_ledger_exact_staged_names_and_verbs():
    s = _session(records=[_rec('printer.cfg', 'printer', key='max_accel')])
    text = completion_kickback_directive('x', s, mode='ledger')
    assert 'staged 1 edit:' in text  # singular
    assert 'printer.cfg — set_param: printer.max_accel' in text


def test_directive_ledger_superseded_records_excluded():
    s = _session(records=[
        _rec('printer.cfg', 'printer', key='microsteps'),
        _rec('printer.cfg', 'printer', key='microsteps', superseded=True),
    ])
    text = completion_kickback_directive('x', s, mode='ledger')
    assert 'staged 1 edit:' in text


def test_directive_ledger_section_cap_and_plus_k_more():
    names = [f'section_{i}' for i in range(COMPLETION_LEDGER_SECTION_CAP + 7)]
    s = _session(records=[_rec('printer.cfg', n, op='add_section')
                          for n in names])
    text = completion_kickback_directive('x', s, mode='ledger')
    assert f'staged {len(names)} edits:' in text
    # Early entries first, exact "+K more" tail.
    assert f'section_0, section_1, section_2' in text
    assert ' +7 more' in text
    assert f'section_{COMPLETION_LEDGER_SECTION_CAP + 6}' not in text


def test_directive_ledger_multi_file_and_failed_calls():
    s = _session(records=[
        _rec('printer.cfg', 'printer', key='max_accel'),
        _rec('macros.cfg', 'gcode_macro PARK', op='replace_section'),
    ], failures=2, notes=['op[0] set_param@ghost: section not found',
                          'set_param@nope: unknown section'])
    text = completion_kickback_directive('x', s, mode='ledger')
    assert 'printer.cfg — set_param: printer.max_accel' in text
    assert ' · ' in text
    assert 'macros.cfg — replace_section: gcode_macro PARK' in text
    assert 'failed calls: 2 (op[0] set_param@ghost: section not found; ' \
        'set_param@nope: unknown section)' in text


def test_directive_ledger_failure_notes_cap():
    s = _session(failures=7,
                 notes=[f'note {i}' for i in range(5)])
    text = completion_kickback_directive('x', s, mode='ledger')
    assert 'failed calls: 7 (note 0; note 1; note 2; note 3; note 4) +2 more' \
        in text


# ── loop seam behavior ─────────────────────────────────────────────────


def test_completion_check_fires_once_after_staged_edit(blank_memory, monkeypatch):
    # Write stages, model closes on confident prose → ONE kick with the
    # ledger attached; second prose exit closes normally.
    body, scripted = _chat(
        {'requestId': 'cc-once-1'},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done — max_accel is 4000.'}}]},
            {'choices': [{'message': {'content': 'Confirmed: the request is fully resolved.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
    assert body['usage']['ackReprompts'] == 0
    injected = scripted.payloads[2]['messages'][-1]
    assert injected['role'] == 'user'
    assert injected['content'].startswith('COMPLETION CHECK — Your request:')
    assert 'Change my max_accel to 4000 in printer.cfg' in injected['content']
    assert 'staged 1 edit: printer.cfg — set_param: printer.max_accel' \
        in injected['content']
    # cap 1 — exactly initial + tool-turn + one kick.
    assert len(scripted.payloads) == 3


def test_completion_check_fires_advice_only_edit_request(blank_memory, monkeypatch):
    # The advice-only hole: edit request, ZERO writes, confident prose.
    # Today no guard fires; the completion check must.
    body, scripted = _chat(
        {'requestId': 'cc-advice-1'},
        [
            {'choices': [{'message': {'content':
                'You should set max_accel to 4000 — that is a safe value '
                'for a CoreXY.'}}]},
            {'choices': [{'message': {'content':
                'Right, applying it now is not possible here; here is the '
                'reasoning again, complete.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
    injected = scripted.payloads[1]['messages'][-1]
    assert 'staged 0 edits.' in injected['content']


def test_completion_check_not_fired_pure_qa(blank_memory, monkeypatch):
    body, scripted = _chat(
        {'requestId': 'cc-qa-1',
         'messages': [{'role': 'user',
                       'content': 'What does pressure_advance do?'}]},
        [
            {'choices': [{'message': {'content':
                'Pressure advance reduces ringing by adjusting extrusion.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 0
    assert len(scripted.payloads) == 1


def test_completion_check_skips_cfg_fence_and_question_tails(
        blank_memory, monkeypatch):
    # Case A: a cfg-fenced close is the inert-draft shape — the
    # edit-prose nudge owns the FIRST round; the model's nudge-round
    # reply asks the user a question, which exempts the completion
    # check (same exemption discipline as the ack guard).
    body, scripted = _chat(
        {'requestId': 'cc-fence-1'},
        [
            {'choices': [{'message': {'content':
                'Here is the change:\n\n```cfg\n[printer]\nmax_accel: 4000\n```'}}]},
            {'choices': [{'message': {'content':
                'Want me to apply that with the edit tool, or leave the '
                'value as it is?'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['ackReprompts'] == 0
    assert body['usage']['completionKicks'] == 0
    # initial + one nudge round; the clarifying close then breaks.
    assert len(scripted.payloads) == 2
    assert scripted.payloads[1]['messages'][-1]['content'] == \
        ai_routes.EDIT_NUDGE_TEXT_NATIVE


def test_completion_check_skips_clarifying_tail(blank_memory, monkeypatch):
    # Case B: zero-write edit request closing on an honest clarifying
    # question — never kicked (forcing a guess between real candidates
    # is the ack guard's documented lesson).
    body, scripted = _chat(
        {'requestId': 'cc-ask-1'},
        [
            {'choices': [{'message': {'content':
                'I can set that — which value do you want, 3000 or 4000?'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 0
    assert len(scripted.payloads) == 1


def test_completion_check_fires_text_protocol(blank_memory, monkeypatch):
    body, scripted = _chat(
        {'requestId': 'cc-text-1',
         'apiProvider': 'openai-compatible',
         'apiUrl': 'http://192.168.1.145:1237/v1/chat/completions',
         'apiKey': ''},
        [
            {'choices': [{'message': {'content':
                'Sure.\n\n```tool\n{"name": "config_edit", "arguments": '
                '{"file": "printer.cfg", "op": "set_param", '
                '"section": "printer", "key": "max_accel", "value": "4000"}}\n```'}}]},
            {'choices': [{'message': {'content': 'Done, max_accel is 4000 now.'}}]},
            {'choices': [{'message': {'content': 'Yes — entirely resolved.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
    assert 'COMPLETION CHECK' in scripted.payloads[2]['messages'][-1]['content']


def test_completion_check_bare_arm_env(blank_memory, monkeypatch):
    monkeypatch.setenv('KWC_COMPLETION_CHECK', 'bare')
    body, scripted = _chat(
        {'requestId': 'cc-bare-1'},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            {'choices': [{'message': {'content': 'Resolved.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
    injected = scripted.payloads[2]['messages'][-1]['content']
    assert 'staged' not in injected  # bare carries no ledger
    assert 'If not, continue with the edit tools now.' in injected


def test_completion_check_ledger_names_failed_calls(
        blank_memory, monkeypatch):
    # A failed write (bad section) leaves outcome='correctable', so the
    # edit-prose nudge owns the first three give-up closes (r4/r5 law);
    # after its budget is spent, the completion check fires and the
    # ledger rides the kick with the failed-call one-liner.
    bad = {'choices': [{'message': {
        'content': 'Applying.',
        'tool_calls': [{
            'type': 'function', 'id': 'c1',
            'function': {'name': 'config_edit', 'arguments': json.dumps({
                'file': 'printer.cfg', 'op': 'set_param',
                'section': 'ghost_section', 'key': 'k', 'value': '1'})},
        }],
    }}]}
    prose = {'choices': [{'message': {'content':
        'All set — everything is updated.'}}]}
    body, scripted = _chat(
        {'requestId': 'cc-fail-1'},
        [bad, prose, prose, prose, prose,
         {'choices': [{'message': {'content':
             'Correction: the [ghost_section] change failed. Here is '
             'what was and was not applied, in full.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
    cc_payloads = [p for p in scripted.payloads
                   if p['messages'][-1]['role'] == 'user'
                   and 'COMPLETION CHECK' in str(
                       p['messages'][-1].get('content', ''))]
    assert cc_payloads, 'completion-check directive never reached the model'
    injected = cc_payloads[0]['messages'][-1]['content']
    assert 'failed calls: 1' in injected
    assert 'staged 0 edits.' in injected


def test_steer_re_arms_completion_check(blank_memory, monkeypatch):
    # Kick consumed, then the model continues; the user steers; the
    # post-steer prose close gets its OWN fresh kick.
    state = {'steered': False}

    real_post = ScriptedClient.post

    async def posting(self, url, headers=None, json=None):
        # Steer while the FIRST kick round-trip is in flight (payloads
        # holds the initial + tool-turn requests already).
        if len(self.payloads) == 2 and not state['steered']:
            state['steered'] = True
            ai_routes._chat_steers.setdefault('cc-steer-1', []).append(
                'actually use 3000')
        return await real_post(self, url, headers=headers, json=json)

    monkeypatch.setattr(ScriptedClient, 'post', posting)
    body, scripted = _chat(
        {'requestId': 'cc-steer-1'},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done — 4000 set.'}}]},
            {'choices': [{'message': {'content': 'Fully resolved.'}}]},   # kick reply #1
            # steer injects here (payload 3), model re-edits:
            _edit_call(value='3000'),
            {'choices': [{'message': {'content': 'Done — it is 3000.'}}]},
            {'choices': [{'message': {'content': 'Yes, entirely resolved.'}}]},  # 2nd kick reply
        ],
        monkeypatch,
    )
    # Two COMPLETION CHECK directives reached the model: one before the
    # steer, one after (the steer re-armed the budget). The usage field
    # reports the counter AT RESPONSE TIME — reset by the steer — so the
    # injection count, not the counter, proves the re-arm.
    injections = [p for p in scripted.payloads
                  if p['messages'][-1]['role'] == 'user'
                  and 'COMPLETION CHECK' in str(
                      p['messages'][-1].get('content', ''))]
    assert len(injections) == 2
    assert body['usage']['completionKicks'] == 1
    assert body['steers'] == [{'turn': 1, 'text': 'actually use 3000'}]
