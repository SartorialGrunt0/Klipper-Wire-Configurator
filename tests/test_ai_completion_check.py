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


def _edit_call(value='4000', section='printer', key='max_accel'):
    return {'choices': [{'message': {
        'content': 'Applying now.',
        'tool_calls': [{
            'type': 'function', 'id': 'c1',
            'function': {'name': 'config_edit', 'arguments': json.dumps({
                'file': 'printer.cfg', 'op': 'set_param', 'section': section,
                'key': key, 'value': value})},
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


def test_completion_check_harness_override_disarms(blank_memory, monkeypatch):
    # ChatRequest.completionCheck=False (harness default for bank runs,
    # 2026-10-18): the same edit-intent confident-prose close that earns
    # a kick by default must close raw — no re-query, no echo, kicks 0.
    body, scripted = _chat(
        {'requestId': 'cc-off-1', 'completionCheck': False},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done — max_accel is 4000.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 0
    # The edit turn still runs; only the kick re-query is gone.
    assert len(scripted.payloads) == 2


def test_completion_check_harness_override_none_keeps_product_default(
        blank_memory, monkeypatch):
    # completionCheck omitted (frontend behavior) must be byte-identical
    # to the armed default — the override only disarms on explicit False.
    body, scripted = _chat(
        {'requestId': 'cc-none-1'},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done — max_accel is 4000.'}}]},
            {'choices': [{'message': {'content': 'Confirmed: the request is fully resolved.'}}]},
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 1
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


# ── fresh-context completion judge (dev A/B, plan 2026-10-18 Phase 2 slice) ──

from services.ai_completion_judge import (  # noqa: E402
    JUDGE_SYSTEM,
    completion_guard_mode,
    continue_directive_text,
    ledger_fingerprint,
    parse_verdict,
)


def test_guard_mode_default_and_env():
    assert completion_guard_mode() == 'kickback'
    import os
    old = os.environ.get('KWC_COMPLETION_GUARD')
    try:
        os.environ['KWC_COMPLETION_GUARD'] = 'judge'
        assert completion_guard_mode() == 'judge'
        os.environ['KWC_COMPLETION_GUARD'] = 'garbage'
        assert completion_guard_mode() == 'kickback'
    finally:
        if old is None:
            del os.environ['KWC_COMPLETION_GUARD']
        else:
            os.environ['KWC_COMPLETION_GUARD'] = old


def test_parse_verdict_plain_done():
    v = parse_verdict('{"verdict": "done"}', 'change max_accel')
    assert v['verdict'] == 'done'


def test_parse_verdict_fenced_json():
    v = parse_verdict('```json\n{"verdict": "done"}\n```', 'x')
    assert v['verdict'] == 'done'


def test_parse_verdict_garbage_fails_open_to_done():
    assert parse_verdict('not json at all', 'x')['verdict'] == 'done'
    assert parse_verdict('', 'x')['verdict'] == 'done'
    assert parse_verdict('{"verdict": "explode"}', 'x')['verdict'] == 'done'


def test_parse_verdict_continue_requires_verbatim_quote():
    goal = 'Change my max_accel to 4000 in printer.cfg'
    good = ('{"verdict": "continue", "remaining": [{"quote": '
            '"max_accel to 4000", "why": "not staged"}]}')
    v = parse_verdict(good, goal)
    assert v['verdict'] == 'continue'
    assert v['remaining'][0]['quote'] == 'max_accel to 4000'
    # continue WITHOUT a quote -> fail open (anti loop-extension)
    bad = '{"verdict": "continue", "remaining": [{"why": "vibes"}]}'
    assert parse_verdict(bad, goal)['verdict'] == 'done'
    # quote not present in the user's request -> not established
    fake = ('{"verdict": "continue", "remaining": [{"quote": '
            '"add a filament sensor", "why": "x"}]}')
    assert parse_verdict(fake, goal)['verdict'] == 'done'


def test_parse_verdict_needs_user():
    v = parse_verdict('{"verdict": "needs_user", "question": "Which file?"}', 'x')
    assert v['verdict'] == 'needs_user'
    assert v['question'] == 'Which file?'


def test_parse_verdict_explicit_json_nulls():
    # Live gemma judges emit explicit nulls for unused fields
    # ({"verdict": "done", "actions": [], "question": null}). A bare
    # .get(key, "") returns None for an EXPLICIT null — str(None) would
    # leak the literal "None": needs_user+null-question must fail open
    # to done, never deliver "None" as a question (2026-10-19 smoke).
    v = parse_verdict('{"verdict": "done", "actions": [], '
                      '"question": null}', 'x')
    assert v['verdict'] == 'done'
    v = parse_verdict('{"verdict": "needs_user", "question": null}', 'x')
    assert v['verdict'] == 'done'
    v = parse_verdict('{"verdict": "continue", "actions": '
                      '[{"text": null, "file": null, "quote": null}]}', 'x')
    assert v['verdict'] == 'done'
    # A null `text` with a real quote still yields the quote as action.
    v = parse_verdict('{"verdict": "continue", "actions": [{"text": null, '
                      '"quote": "delete the macro"}]}', 'delete the macro')
    assert v['remaining'][0]['text'] == 'delete the macro'
    assert v['remaining'][0]['file'] == ''


def test_ledger_fingerprint_tracks_state():
    s = _session()
    fp0 = ledger_fingerprint(s)
    assert ledger_fingerprint(s) == fp0  # stable
    s2 = _session(records=[_rec('printer.cfg', 'printer', key='max_accel')])
    assert ledger_fingerprint(s2) != fp0
    s3 = _session(records=[_rec('printer.cfg', 'printer', key='max_accel')],
                  failures=1)
    assert ledger_fingerprint(s3) != ledger_fingerprint(s2)


def test_continue_directive_is_assertive_actions_list():
    items = [{'text': 'rename existing gcode_macro _bed_mesh_calibrate to '
                      'bed_mesh_calibrate',
              'file': 'printer.cfg',
              'quote': 'rename _bed_mesh_calibrate',
              'evidence': '# [gcode_macro _bed_mesh_calibrate]',
              'why': 'still commented out'}]
    text = continue_directive_text(items)
    assert text.startswith('Verdict: needs work')
    assert 'rename existing gcode_macro _bed_mesh_calibrate to ' \
           'bed_mesh_calibrate [printer.cfg]' in text
    assert 'Actions:' in text and 'Do not continue' in text
    # Justification/evidence are log-only: never outbound to the worker.
    assert 'still commented out' not in text
    assert '# [gcode_macro _bed_mesh_calibrate]' not in text


def test_continue_directive_falls_back_to_quote_and_dedupes():
    # Legacy quote-only items still render (text := quote).
    legacy = [{'quote': 'all six sections', 'why': 'only 4 staged'}]
    text = continue_directive_text(legacy)
    assert '- all six sections' in text
    assert 'only 4 staged' not in text
    # Repeated action texts are dropped when prior_texts is supplied.
    once = continue_directive_text(legacy)
    again = continue_directive_text(
        legacy, prior_texts={'all six sections'})
    assert 'Verdict: needs work' in again  # header survives
    assert again.count('- all six sections') == 0
    mixed = continue_directive_text(
        legacy + [{'text': 'stage the delete', 'quote': 'delete x'}],
        prior_texts={'all six sections'})
    assert '- all six sections' not in mixed
    assert '- stage the delete' in mixed


def test_parse_verdict_actions_shape_normalizes():
    goal = ('Rename Level_Bed to bed_mesh_calibrate and update every '
            'reference')
    raw = ('{"verdict": "continue", "actions": ['
           '{"text": "rename gcode_macro Level_Bed to bed_mesh_calibrate",'
           ' "file": "printer.cfg", "quote": "Rename Level_Bed to '
           'bed_mesh_calibrate", "evidence": "[gcode_macro Level_Bed]",'
           ' "why": "header not renamed"},'
           '{"text": "invented work", "quote": "add a filament sensor",'
           ' "why": "not in the request"}]}')
    v = parse_verdict(raw, goal)
    assert v['verdict'] == 'continue'
    # Unquoted (not-established) action dropped; established one kept
    # with full normalization.
    assert len(v['remaining']) == 1
    a = v['remaining'][0]
    assert a['text'] == 'rename gcode_macro Level_Bed to bed_mesh_calibrate'
    assert a['file'] == 'printer.cfg'
    assert a['evidence'] == '[gcode_macro Level_Bed]'
    assert a['quote'] == 'Rename Level_Bed to bed_mesh_calibrate'


def test_parse_verdict_actions_without_text_falls_back_to_quote():
    goal = 'update every reference to level_bed'
    raw = ('{"verdict": "continue", "actions": ['
           '{"quote": "every reference to level_bed"}]}')
    v = parse_verdict(raw, goal)
    assert v['verdict'] == 'continue'
    assert v['remaining'][0]['text'] == 'every reference to level_bed'


# ── judge-wired loop (integration) ──────────────────────────────────────

GOAL = 'Change my max_accel to 4000 in printer.cfg'
JUDGE_DONE = {'choices': [{'message': {'content': '{"verdict": "done"}'}}]}
JUDGE_CONTINUE = {'choices': [{'message': {'content':
    '{"verdict": "continue", "remaining": [{"quote": "max_accel to 4000", '
    '"why": "not staged"}]}'}}]}
JUDGE_NEEDS_USER = {'choices': [{'message': {'content':
    '{"verdict": "needs_user", "question": '
    '"Which of the two printers should get it?"}'}}]}


def _judge_over(**extra):
    over = {'requestId': 'cj-1', 'completionCheck': True,
            'completionGuard': 'judge'}
    over.update(extra)
    return over


def test_judge_done_delivers_close_untouched(blank_memory, monkeypatch):
    body, scripted = _chat(
        _judge_over(requestId='cj-done-1'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done — max_accel is 4000.'}}]},
            JUDGE_DONE,
        ],
        monkeypatch,
    )
    assert 'All done — max_accel is 4000.' in body['content']
    cj = body['usage']['completionJudge']
    assert cj['calls'] == 1 and cj['verdicts'] == ['done']
    # fresh context: the judge payload carries NO worker transcript
    jp = scripted.payloads[2]
    joined = json.dumps(jp['messages'])
    assert 'Applying now.' not in joined and 'COMPLETION CHECK' not in joined
    assert JUDGE_SYSTEM[:40] in json.dumps(jp['messages'][0])
    assert 'max_accel' in joined  # ledger brief rides
    assert jp.get('temperature') == 0
    assert 'tools' not in jp or not jp['tools']
    assert len(scripted.payloads) == 3  # no worker re-query on done


def test_judge_continue_injects_system_directive_then_rejudges(
        blank_memory, monkeypatch):
    # Realistic shape: worker staged the WRONG thing first (max_velocity),
    # the auditor quotes the unmet ask, the worker stages the real target
    # (a NEW key — the same-request duplicate guard would block a
    # same-key rewrite), then re-close gets grade #2.
    body, scripted = _chat(
        _judge_over(requestId='cj-cont-1'),
        [
            _edit_call(section='printer', key='max_velocity', value='300'),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_CONTINUE,
            _edit_call(section='printer', key='max_accel', value='4000'),
            {'choices': [{'message': {'content': 'Now everything is set.'}}]},
            JUDGE_DONE,
        ],
        monkeypatch,
    )
    assert body['usage']['completionJudge']['calls'] == 2
    assert body['usage']['completionJudge']['verdicts'] == ['continue', 'done']
    worker_after = scripted.payloads[3]['messages']
    assert any(m['role'] == 'system' and 'max_accel to 4000' in m['content']
               for m in worker_after)
    assert 'Now everything is set.' in body['content']


def test_judge_needs_user_delivers_question(blank_memory, monkeypatch):
    body, scripted = _chat(
        _judge_over(requestId='cj-need-1'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_NEEDS_USER,
        ],
        monkeypatch,
    )
    assert 'Which of the two printers' in body['content']
    assert body['usage']['completionJudge']['verdicts'] == ['needs_user']
    assert len(scripted.payloads) == 3


def test_judge_second_continue_delivers_with_footer_flag(
        blank_memory, monkeypatch):
    body, scripted = _chat(
        _judge_over(requestId='cj-cap-1'),
        [
            _edit_call(section='printer', key='max_velocity', value='300'),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_CONTINUE,
            _edit_call(section='printer', key='max_accel', value='4000'),
            {'choices': [{'message': {'content': 'Now everything is set.'}}]},
            JUDGE_CONTINUE,
        ],
        monkeypatch,
    )
    cj = body['usage']['completionJudge']
    assert cj['calls'] == 2  # verdict cap: no third grade, no third worker call
    assert 'max_accel to 4000' in body['content']  # footer flag
    assert len(scripted.payloads) == 6


def test_judge_fingerprint_unchanged_skips_regrade(blank_memory, monkeypatch):
    # After a continue verdict, a re-close with NO new ledger movement is
    # delivered + flagged immediately — re-grading a rejected snapshot is
    # pure latency.
    body, scripted = _chat(
        _judge_over(requestId='cj-fp-1'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_CONTINUE,
            {'choices': [{'message': {'content': 'Yes, fully resolved.'}}]},
        ],
        monkeypatch,
    )
    cj = body['usage']['completionJudge']
    assert cj['calls'] == 1
    assert cj['flagged']  # footer items present
    assert len(scripted.payloads) == 4  # no second judge call


def test_judge_respects_check_off(blank_memory, monkeypatch):
    # completionCheck=False outranks the guard choice: fully off.
    body, scripted = _chat(
        {'requestId': 'cj-off-1', 'completionCheck': False,
         'completionGuard': 'judge'},
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
        ],
        monkeypatch,
    )
    assert len(scripted.payloads) == 2
    assert 'completionJudge' not in body['usage']


def test_judge_mode_keeps_kickback_counter_separate(blank_memory, monkeypatch):
    # Judge verdicts are NOT completionKicks (the harness counts the two
    # guards apart; the echo path must stay measurable on its own).
    body, scripted = _chat(
        _judge_over(requestId='cj-sep-1'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_DONE,
        ],
        monkeypatch,
    )
    assert body['usage']['completionKicks'] == 0


# ── judge payload enrichment: inventory + edited-file dumps (2026-10-19) ──

from services.ai_completion_judge import (
    judge_payload_mode,
    judge_user_payload,
    project_inventory,
    edited_file_dumps,
)

MICROSTEPS_CFG = """\
[printer]
kinematics: corexy
max_velocity: 300

[stepper_x]
step_pin: x
microsteps: 32

[stepper_y]
step_pin: y
microsteps: 32

[stepper_z]
step_pin: z
microsteps: 16
"""


def test_inventory_lists_sections_per_file():
    text = MICROSTEPS_CFG
    s = EditSession({'printer.cfg': {'content': text}})
    inv = project_inventory(s)
    assert 'printer.cfg' in inv
    assert '[stepper_z]' in inv
    # commented-out headers are NOT inventory (they are not live sections)
    s2 = EditSession({'a.cfg': {'content': text + '\n#[gcode_macro T3]\n#gcode:\n'}})
    assert '[gcode_macro T3]' not in project_inventory(s2)


def test_dump_mode_includes_edited_file_text_only():
    s = EditSession({'printer.cfg': {'content': MICROSTEPS_CFG},
                     'macros.cfg': {'content': '[gcode_macro A]\ngcode:\n    G28\n'}})
    # stage one edit on printer.cfg only
    s.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param', 'section': 'stepper_z',
        'key': 'microsteps', 'value': '32'}})
    dump = edited_file_dumps(s)
    assert '[stepper_z]' in dump and 'microsteps: 32' in dump
    # unedited macros.cfg must NOT be dumped
    assert 'gcode_macro A' not in dump
    payload = judge_user_payload('set all stepper microsteps to 32', s, mode='dump')
    assert 'PROJECT INVENTORY' in payload
    assert 'CURRENT TEXT OF EDITED FILES' in payload
    assert '[stepper_z]' in payload
    assert 'microsteps: 32' in payload


def test_dump_mode_labels_unchanged():
    s = EditSession({'printer.cfg': {'content': MICROSTEPS_CFG}})
    s.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param', 'section': 'stepper_z',
        'key': 'microsteps', 'value': '32'}})
    labels = judge_user_payload('set all stepper microsteps to 32', s, mode='labels')
    assert 'PROJECT INVENTORY' not in labels
    assert 'CURRENT TEXT OF EDITED FILES' not in labels
    assert 'staged 1 edit' in labels  # ledger line still rides


def test_dump_caps_oversized_files_with_section_fallback():
    body = '\n'.join(f'    step_{i}: {i}' for i in range(2000))
    big = f'[gcode_macro BIG]\ngcode:\n{body}\n\n[gcode_macro EDITED]\ngcode:\n    G91\n'
    s = EditSession({'printer.cfg': {'content': big}})
    s.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'patch_section',
        'section': 'gcode_macro EDITED', 'old_text': 'G91', 'new_text': 'G90'}})
    dump = edited_file_dumps(s)
    assert len(dump) <= 16000 + 2000  # per-file cap + framing slack
    assert 'G90' in dump  # the EDITED section survived truncation
    assert 'step_1999' not in dump  # the giant untouched section did not


def test_judge_payload_mode_matrix(monkeypatch):
    monkeypatch.delenv('KWC_COMPLETION_JUDGE_PAYLOAD', raising=False)
    assert judge_payload_mode() == 'labels'
    monkeypatch.setenv('KWC_COMPLETION_JUDGE_PAYLOAD', 'dump')
    assert judge_payload_mode() == 'dump'
    monkeypatch.setenv('KWC_COMPLETION_JUDGE_PAYLOAD', 'garbage')
    assert judge_payload_mode() == 'labels'


def test_judge_dump_payload_mode_reaches_the_call(blank_memory, monkeypatch):
    # End-to-end pin for ChatRequest.completionJudgePayload: with 'dump',
    # the judge call's user message carries the inventory AND the CURRENT
    # staged file text (the edit's effect visible in it).
    body, scripted = _chat(
        _judge_over(requestId='cj-dump-1', completionJudgePayload='dump'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_DONE,
        ],
        monkeypatch,
    )
    assert body['usage']['completionJudge']['calls'] == 1
    judge_msg = scripted.payloads[2]['messages'][1]['content']
    assert 'PROJECT INVENTORY' in judge_msg
    assert 'CURRENT TEXT OF EDITED FILES' in judge_msg
    assert 'max_accel: 4000' in judge_msg  # the staged truth, verbatim
    assert '[printer]' in judge_msg


def test_judge_labels_payload_default_no_dump(blank_memory, monkeypatch):
    body, scripted = _chat(
        _judge_over(requestId='cj-dump0-1'),
        [
            _edit_call(),
            {'choices': [{'message': {'content': 'All done.'}}]},
            JUDGE_DONE,
        ],
        monkeypatch,
    )
    assert body['usage']['completionJudge']['calls'] == 1
    judge_msg = scripted.payloads[2]['messages'][1]['content']
    assert 'PROJECT INVENTORY' not in judge_msg
    assert 'CURRENT TEXT OF EDITED FILES' not in judge_msg
    # The ledger line still rides (labels mode == shipped first-slice).
    assert 'staged 1 edit' in judge_msg
