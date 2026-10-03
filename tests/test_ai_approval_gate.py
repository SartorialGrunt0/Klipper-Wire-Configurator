"""Edit-path contracts after the post-hoc review change (2026-10-02).

Two contracts live in this file, and they are deliberately separated:

1. **The un-gated edit path** (route level, /ai/chat): a validated write
   stages IMMEDIATELY into the request's working state and change set, the
   model is told it is staged, and review happens after the reply. No
   suspension, no card, no 90s clock. Invalid calls kick back exactly as
   they always did.

2. **The DORMANT gate** (driven DIRECTLY, never through /ai/chat):
   ApprovalRequest, the GET/POST /ai/chat/approval rail, the timeout, the
   invalidation-on-anchor-miss rule and format_approval_result's wording.
   Nothing in the edit path calls it any more — it is kept intact for the
   first IRREVERSIBLE tool (disk write, firmware restart, printer command),
   where a keep/undo surface cannot take the decision back. These tests
   drive _run_approval_gate itself so the law stays locked and does not
   have to be re-derived when that tool lands.

Concurrency pattern (inherited): the gate runs in a helper thread on its
own event loop while the main thread polls/decides over HTTP — the same
shape the real frontend uses.
"""
import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from services.ai_edit_tools import (  # noqa: E402
    EditSession,
    create_approval,
    format_approval_result,
)

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100

[gcode_macro PARK]
gcode:
    G91
    G1 Z5
"""


def _ctx():
    return {'printer.cfg': {'content': PRINTER_CFG}}


def _text_tool_call(name, arguments):
    args = {k: str(v) for k, v in arguments.items()}
    block = f"```tool\n{json.dumps({'name': name, 'arguments': args})}\n```"
    return {'choices': [{'message': {'content': f'Sure.\n\n{block}'}}]}


def _final_reply(text='Done.'):
    return {'choices': [{'message': {'content': text}}]}


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.text = json.dumps(payload)

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


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
        raise AssertionError('Unexpected GET')


def _install(monkeypatch, replies):
    from api.printer_memory_routes import PrinterMemory
    scripted = _ScriptedClient(replies)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    return scripted


@pytest.fixture()
def edit_flag(monkeypatch):
    """No-op since the Phase-6 flag removal (2026-09-24): the write tools
    are product behavior; each payload below carries editSkill=True
    because these tests script write calls directly."""
    monkeypatch.delenv('KWC_EDIT_WRITE_CAP', raising=False)


SET_ACCEL = {'file': 'printer.cfg', 'op': 'set_param',
             'section': 'printer', 'key': 'max_accel', 'value': '3000'}


def _post_chat_bg(payload_holder):
    """Run one in-flight chat request in a thread; return (thread, result)."""
    result = {}

    def run():
        r = client.post('/ai/chat', json=payload_holder)
        result['body'] = r.json() if r.status_code == 200 else r.text
        result['status'] = r.status_code

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, result


def _wait_card(request_id, timeout=5.0):
    """Poll until a card appears; return its payload."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f'/ai/chat/approval?requestId={request_id}')
        body = r.json()
        if body.get('pending'):
            return body
        time.sleep(0.05)
    raise AssertionError('approval card never appeared')


def _chat_payload(request_id, **overrides):
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(), 'editSkill': True,
        'requestId': request_id,
    }
    payload.update(overrides)
    return payload


# ══ The DORMANT gate (driven directly) ══════════════════════════════════


def _gate_bg(tool_call, request_id, ctx=None):
    """Run the dormant _run_approval_gate for ONE call in a background
    loop; the main thread polls/decides over HTTP, as the UI does."""
    box = {'session': EditSession(ctx or _ctx())}
    session = box['session']

    async def run_gate():
        box['out'] = await ai_routes._run_approval_gate(
            session, tool_call, None, request_id, ai_routes.logger)

    def thread_main():
        try:
            asyncio.run(run_gate())
        except Exception as exc:  # surfaced by the test that joins
            box['error'] = exc

    t = threading.Thread(target=thread_main, daemon=True)
    t.start()
    return t, box


def _call(op):
    return {'name': 'config_edit',
            'arguments': {k: str(v) for k, v in op.items()}}


def test_dormant_gate_suspends_and_approve_commits(edit_flag):
    """The gate's own contract is intact: a validated call opens a card,
    NOTHING is staged until the decision, and an approve commits the op
    into the session's working state with approval-honest wording."""
    t, box = _gate_bg(_call(SET_ACCEL), 'dormant-approve-1')
    card = _wait_card('dormant-approve-1')
    assert card['file'] == 'printer.cfg'
    assert card['op'] == 'set_param'
    assert card['timeoutSeconds'] > 0
    assert 'approvalId' in card
    # Nothing staged while the card is open.
    assert not box['session'].pending_edits

    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx(),
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    assert 'error' not in box, box['error']
    content, details = box['out']
    assert 'max_accel: 3000' in box['session'].state.files['printer.cfg']
    assert 'APPROVED' in content
    assert details is not None


def test_dormant_gate_decline_stages_nothing(edit_flag):
    t, box = _gate_bg(_call(SET_ACCEL), 'dormant-decline-1')
    card = _wait_card('dormant-decline-1')
    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline',
        'reason': 'I want to keep the stock value',
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    content, details = box['out']
    assert not box['session'].pending_edits
    assert 'max_accel: 1000' in box['session'].state.files['printer.cfg']
    assert 'NOT APPROVED' in content
    assert details is None


def test_dormant_gate_no_card_for_invalid_call(edit_flag):
    """Plan law: a call with new validation errors kicks back immediately —
    no card, no wait, identical lean error."""
    t, box = _gate_bg(_call({'file': 'printer.cfg', 'op': 'set_param',
                             'section': 'ghost', 'key': 'x', 'value': '1'}),
                      'dormant-invalid-1')
    t.join(timeout=10)
    assert 'error' not in box, box['error']
    content, details = box['out']
    assert details is None
    assert 'ghost' in content
    assert client.get(
        '/ai/chat/approval?requestId=dormant-invalid-1').json() == {
            'pending': False}


def test_dormant_gate_double_decision_rejected(edit_flag):
    t, box = _gate_bg(_call(SET_ACCEL), 'dormant-double-1')
    card = _wait_card('dormant-double-1')
    url = '/ai/chat/approval'
    d1 = client.post(url, json={'approvalId': card['approvalId'],
                                'decision': 'decline'})
    d2 = client.post(url, json={'approvalId': card['approvalId'],
                                'decision': 'approve'})
    assert d1.json()['status'] == 'ok'
    assert d2.json()['status'] == 'already_decided'
    t.join(timeout=10)
    assert not box['session'].pending_edits   # decline won; approve ignored


def test_dormant_gate_unknown_approval_id():
    r = client.post('/ai/chat/approval', json={
        'approvalId': 'nope', 'decision': 'approve'})
    assert r.json()['status'] == 'not_found'


def test_dormant_gate_manual_edit_invalidates_anchor(edit_flag):
    """Approve carries the frontend's LATEST files; if the anchor died the
    decision is NOT accepted and the card stays open for decline."""
    op = {'file': 'printer.cfg', 'op': 'patch_section',
          'section': 'gcode_macro PARK', 'old_text': 'G1 Z5',
          'new_text': 'G1 Z10'}
    t, box = _gate_bg(_call(op), 'dormant-stale-1')
    card = _wait_card('dormant-stale-1')

    edited = PRINTER_CFG.replace('G1 Z5', 'G1 Z7')
    stale_ctx = {'printer.cfg': {'content': edited, 'label': 'printer.cfg'}}

    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': stale_ctx,
    })
    assert dec.json()['status'] == 'invalidated'
    again = client.get('/ai/chat/approval?requestId=dormant-stale-1').json()
    assert again['pending'] is True
    dec2 = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline',
        'reason': 'anchor moved', 'contextFiles': stale_ctx,
    })
    assert dec2.json()['status'] == 'ok'
    t.join(timeout=10)
    assert not box['session'].pending_edits


def test_dormant_gate_manual_edit_clean_reapply(edit_flag):
    """Same window, but the manual edit does NOT touch the anchor:
    approve re-applies cleanly to the LATEST text (never clobbers)."""
    t, box = _gate_bg(_call(SET_ACCEL), 'dormant-merge-1')
    card = _wait_card('dormant-merge-1')
    edited = PRINTER_CFG.replace('max_velocity: 200', 'max_velocity: 250')
    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': {'printer.cfg': {'content': edited,
                                         'label': 'printer.cfg'}},
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    new_text = box['session'].state.files['printer.cfg']
    assert 'max_accel: 3000' in new_text      # approved op applied
    assert 'max_velocity: 250' in new_text    # manual edit preserved


def test_dormant_gate_timeout_auto_declines(edit_flag, monkeypatch):
    monkeypatch.setattr(ai_routes, 'APPROVAL_TIMEOUT_SECONDS', 0.4)
    t, box = _gate_bg(_call(SET_ACCEL), 'dormant-timeout-1')
    t.join(timeout=10)
    assert 'error' not in box, box['error']
    content, details = box['out']
    assert not box['session'].pending_edits
    assert 'did not respond' in content
    assert details is None


def test_dormant_gate_one_card_at_a_time(edit_flag):
    """Two validated calls: the second card only exists after the first is
    decided (the registry is one-card-deep per request by construction)."""
    session = EditSession(_ctx())
    second = dict(SET_ACCEL, key='max_velocity', value='300')
    box = {}

    async def run_two():
        first = await ai_routes._run_approval_gate(
            session, _call(SET_ACCEL), None, 'dormant-serial-1',
            ai_routes.logger)
        box['first'] = first
        box['second'] = await ai_routes._run_approval_gate(
            session, _call(second), None, 'dormant-serial-1',
            ai_routes.logger)

    t = threading.Thread(target=lambda: asyncio.run(run_two()), daemon=True)
    t.start()
    card1 = _wait_card('dormant-serial-1')
    assert card1['summary']
    from services.ai_edit_tools import _pending_approvals
    only = [a for a in _pending_approvals.values()
            if a.request_id == 'dormant-serial-1']
    assert len(only) == 1

    client.post('/ai/chat/approval', json={
        'approvalId': card1['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx()})
    card2 = _wait_card('dormant-serial-1')
    assert card2['approvalId'] != card1['approvalId']
    client.post('/ai/chat/approval', json={
        'approvalId': card2['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx()})
    t.join(timeout=10)
    text = session.state.files['printer.cfg']
    assert 'max_accel: 3000' in text
    assert 'max_velocity: 300' in text


def test_dormant_gate_poll_without_request_id_is_harmless():
    assert client.get('/ai/chat/approval').json() == {'pending': False}


def test_dormant_gate_has_no_env_default_within_it():
    """The gate never consults an env default for approval; its only bypass
    was the harness request field, which is inert now that the edit path
    does not call the gate at all."""
    import inspect
    gate_src = inspect.getsource(ai_routes._run_approval_gate)
    assert 'environ' not in gate_src
    edit_path = inspect.getsource(ai_routes.chat_proxy)
    assert 'autoApproveEdits' not in edit_path
    assert '_run_approval_gate' not in edit_path


def test_create_approval_requires_a_running_loop():
    """ApprovalRequest binds to the loop that owns the suspension; creating
    one off-loop is a programming error, not a supported state."""
    session = EditSession(_ctx())
    content, result, _state = session.prepare(_call(SET_ACCEL))
    with pytest.raises(RuntimeError):
        create_approval('config_edit', SET_ACCEL, result, session, 'no-loop')


# ══ Dormant gate: result wording (locked — do not re-derive) ═══════════


def test_decline_reason_and_timeout_note_wording():
    from services.ai_edit_tools import format_approval_result
    content, details = format_approval_result('config_edit', {
        'decision': 'declined', 'reason': 'too aggressive for my frame'})
    assert details is None
    assert 'Reason given: too aggressive for my frame.' in content
    content, details = format_approval_result('config_edit',
                                              {'decision': 'timeout'})
    assert details is None
    assert 'did not respond' in content
    assert 'NOT APPROVED' in content


def test_decline_wording_names_the_human_and_forbids_retry():
    content, _ = format_approval_result('config_edit', {'decision': 'declined'})
    assert 'NOT APPROVED' in content
    assert 'the user reviewed the change and chose' in content
    assert 'not an error on your' in content
    assert 'END WITH A DIRECT QUESTION' in content
    assert 'no reason given' not in content     # empty reason is silence
    assert 'Reason given' not in content


CIRCLE_MACRO = (
    'gcode:\n'
    '    G28\n'
    '    G90\n'
    '    G1 X100 Y100 Z50 F3000\n'
    '    {% for i in range(3) %}\n'
    '        G2 X100 Y100 I-50 J50 F3000\n'
    '    {% endfor %}\n'
    '    G28\n'
)

ADD_CIRCLE_MACRO = {'file': 'printer.cfg', 'op': 'add_section',
                    'section': 'gcode_macro CIRCLE_HOME',
                    'text': CIRCLE_MACRO}

_RUNTIME_ADVISORY = {'severity': 'warning',
                     'code': 'gcode_command_section_missing',
                     'section': 'gcode_macro CIRCLE_HOME', 'param': 'gcode',
                     'message': "'G2' needs a [gcode_arcs] section — it will "
                                'error at runtime without one.'}


def test_approved_result_carries_the_runtime_escalation():
    from services.ai_edit_tools import format_approval_result
    content, details = format_approval_result('config_edit', {
        'decision': 'approved',
        'summary': 'added section [gcode_macro CIRCLE_HOME] to printer.cfg',
        'details': {'advisories': [_RUNTIME_ADVISORY]},
    })
    assert details is not None            # approval still returns the stack
    assert 'APPROVED' in content
    assert 'RUNTIME FAILURE' in content
    assert '[gcode_arcs]' in content
    assert 'already approved' in content
    assert 'Do not ask permission first' not in content


def test_approved_result_keeps_cosmetic_advisories_without_escalation():
    from services.ai_edit_tools import format_approval_result
    content, _ = format_approval_result('config_edit', {
        'decision': 'approved', 'summary': 'renamed a macro',
        'advisories': [
            {'severity': 'warning', 'code': 'duplicate_section',
             'section': 'gcode_macro PARK', 'param': '',
             'message': "'gcode_macro PARK' is defined more than once; "
                        'the later definition wins.'}],
    })
    assert "'gcode_macro PARK' is defined more than once" in content
    assert 'with 1 advisory' in content
    assert 'RUNTIME FAILURE' not in content
    assert 'APPROVED' in content


def test_approved_rename_carries_the_stale_caller_directive():
    from services.ai_edit_tools import format_approval_result
    content, _ = format_approval_result('config_edit', {
        'decision': 'approved',
        'summary': 'renamed [gcode_macro Level_Bed] to [gcode_macro BED_LEVEL]',
        'renamed_from': 'gcode_macro Level_Bed',
        'renamed_to': 'gcode_macro BED_LEVEL',
        'advisories': [
            {'severity': 'warning', 'code': 'unknown_gcode_command',
             'section': 'gcode_macro PRINT_START', 'param': 'gcode',
             'message': "'Level_Bed' is not a Klipper command."}],
    })
    assert 'Level_Bed' in content                # the stale caller is named
    assert 'PRINT_START' in content
    assert "'Level_Bed'" in content
    assert 'STALE' in content.upper()


def test_approved_result_without_details_is_unchanged():
    from services.ai_edit_tools import format_approval_result
    content, details = format_approval_result('config_edit', {
        'decision': 'approved', 'summary': 'noop'})
    assert details is None
    assert 'RUNTIME FAILURE' not in content
    assert 'APPROVED' in content


def test_runtime_directive_default_tail_is_the_pre_approval_one():
    """The un-gated path uses the DEFAULT tail — the ``approved`` switch
    changes only the post-approval sentence."""
    from services.ai_edit_tools import _runtime_section_directive
    pre = _runtime_section_directive({'advisories': [_RUNTIME_ADVISORY]})
    assert 'Do not ask permission first' in pre
    assert 'already approved' not in pre
    post = _runtime_section_directive({'advisories': [_RUNTIME_ADVISORY]},
                                      approved=True)
    assert pre.split('. Do not')[0] == post.split('. The edit')[0]


# ══ The un-gated edit path (route level) ════════════════════════════════


def test_validated_write_stages_immediately_with_no_card(edit_flag, monkeypatch):
    """The core change: a validated write lands in the working state during
    the request, no card ever opens, and the model is told it is STAGED."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Set max_accel to 3000.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-stage-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert body['pendingEdits'][0]['file'] == 'printer.cfg'
    assert 'max_accel: 3000' in body['pendingEdits'][0]['newText']
    # No card is ever pending for this request.
    assert client.get(
        '/ai/chat/approval?requestId=post-hoc-stage-1').json() == {
            'pending': False}
    # The change set rides back with the reply.
    change_set = body['changeSet']
    assert [e['op'] for e in change_set['edits']] == ['set_param']
    assert change_set['totalAdded'] == 1
    assert change_set['totalRemoved'] == 1
    # The model-facing tool result says STAGED, not APPROVED.
    followup = json.dumps(scripted.payloads[-1])
    assert 'STAGED' in followup
    assert 'APPROVED' not in followup


def test_duplicate_target_kickback_keeps_the_change_set_honest(
        edit_flag, monkeypatch):
    """Two writes to the same set_param target in one request: the guard
    kicks the repeat back (a new value needs a new user message), so the
    change set carries exactly the one staged edit — the transcript never
    claims a change the set does not hold."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', dict(SET_ACCEL, value='3000')),
        _text_tool_call('config_edit', dict(SET_ACCEL, value='4000')),
        _final_reply('Raised it to 4000.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-supersede-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert [e['id'] for e in body['changeSet']['edits']] == ['e0']
    assert body['changeSet']['totalAdded'] == 1
    assert 'max_accel: 3000' in body['pendingEdits'][0]['newText']
    assert 'DUPLICATE TARGET' in json.dumps(body['toolCalls'])


def test_change_set_keeps_superseded_rows_out_of_the_totals(
        edit_flag, monkeypatch):
    """A body op CAN rewrite the same target twice (the duplicate guard is
    set_param-only on purpose). Both rows stay in the transcript — honest
    history — and only the survivor counts."""
    first = {'file': 'printer.cfg', 'op': 'replace_section',
             'section': 'gcode_macro PARK', 'text': 'gcode:\n    G91\n    G1 Z10'}
    second = dict(first, text='gcode:\n    G91\n    G1 Z20')
    _install(monkeypatch, [
        {'choices': [{'message': {'content':
            '```tool\n' + json.dumps({'name': 'config_edit',
                                      'arguments': first}) + '\n```\n'
            '```tool\n' + json.dumps({'name': 'config_edit',
                                      'arguments': second}) + '\n```'}}]},
        _final_reply('Park now lifts to Z20.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-supersede-2'))
    assert resp.status_code == 200
    body = resp.json()
    edits = body['changeSet']['edits']
    assert [e['id'] for e in edits] == ['e0', 'e1']
    assert edits[0]['superseded'] is True
    assert edits[0]['supersededBy'] == 'e1'
    assert edits[1]['superseded'] is False
    assert body['changeSet']['totalAdded'] == 1
    assert body['changeSet']['totalRemoved'] == 1
    # The grouped summary lists the section once, from the survivor.
    sections = body['changeSet']['files'][0]['sections']
    assert [s['section'] for s in sections] == ['gcode_macro PARK']
    assert sections[0]['edits'] == ['e1']
    assert 'G1 Z20' in body['pendingEdits'][0]['newText']


def test_duplicate_target_is_user_gated_and_shields_the_cfg_nudge(
        edit_flag, monkeypatch):
    """user_gated is now reachable in-loop only through the duplicate-target
    guard; its nudge shield must still hold — a ```cfg block in the answer
    after that kickback is a report, not an inert draft to pressure."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _text_tool_call('config_edit', dict(SET_ACCEL, value='12000')),
        _final_reply('The tool refused the repeat. Staged value is 3000.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-shield-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert body['content'] == 'The tool refused the repeat. Staged value is 3000.'
    assert '12000' not in json.dumps(body['pendingEdits'])


def test_invalid_call_kicks_back_with_no_stage(edit_flag, monkeypatch):
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'ghost', 'key': 'x',
                                        'value': '1'}),
        _final_reply('That section does not exist.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-invalid-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert not body['pendingEdits']
    assert body['changeSet'] is None
    assert body['editAttempts'] == 1
    assert 'ghost' in json.dumps(body['toolCalls'])
    assert client.get(
        '/ai/chat/approval?requestId=post-hoc-invalid-1').json() == {
            'pending': False}


def test_staged_edits_are_published_live_on_the_progress_rail(
        edit_flag, monkeypatch):
    """Live staging: the accumulated change set is readable from the
    progress poll while the request is still open, so the transcript rows
    and the editor track the same set as it grows."""
    import api.ai_routes as routes

    seen = {}

    class _SlowClient(_ScriptedClient):
        async def post(self, url, headers=None, json=None):
            reply = self.replies.pop(0)
            if not self.replies:    # last call: the write already ran
                entry = routes._chat_progress.get('post-hoc-live-1') or {}
                seen['staged'] = entry.get('stagedEdits')
                seen['changeSet'] = entry.get('changeSet')
            return _Resp(reply)

    from api.printer_memory_routes import PrinterMemory
    slow = _SlowClient([
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Staged.'),
    ])
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: slow)

    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-live-1'))
    assert resp.status_code == 200
    assert seen['staged'], 'staged edits were not published mid-request'
    assert 'max_accel: 3000' in seen['staged'][0]['newText']
    assert seen['changeSet']['edits'][0]['section'] == 'printer'


def test_runtime_advisory_reaches_the_model_on_the_ungated_path(
        edit_flag, monkeypatch):
    """2026-09-30 shape, un-gated: a G2 macro with no [gcode_arcs] must come
    back with the RUNTIME FAILURE escalation in the SAME tool result."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', ADD_CIRCLE_MACRO),
        _final_reply('Macro added.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        'post-hoc-runtime-1',
        messages=[{'role': 'user', 'content':
                   'add a macro that homes, travels in a 100mm circle '
                   'three times, then homes again'}]))
    assert resp.status_code == 200
    followup = json.dumps(scripted.payloads[-1])
    assert 'gcode_command_section_missing' in followup or \
        'gcode_arcs' in followup
    assert '[gcode_arcs]' in followup
    assert 'RUNTIME FAILURE' in followup
    # Pre-approval wording: nothing has been decided by the user yet.
    assert 'Do not ask permission first' in followup
    assert 'STAGED' in followup


def test_staged_then_cfg_echo_is_not_nudged(edit_flag, monkeypatch):
    """Native-mode traces 2026-09-17: right after a staged write, models
    re-quote the section in a ```cfg block to show it. That is a display
    echo, not an inert draft — the prose nudge must NOT fire."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('I have added the change to your printer.cfg. I used:\n\n'
                     '```cfg\n# file: printer.cfg\n[printer]\n'
                     'max_accel: 3000\n```\n'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload('post-hoc-echo-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert 'I have added the change' in body['content']
    assert body['pendingEdits']
    # Branch identity: NO nudge text entered any provider payload.
    assert not any('Call the tool NOW' in str(p) for p in scripted.payloads)


def test_multipart_giveup_after_staged_first_half_still_nudged(
        edit_flag, monkeypatch):
    """Negative control for the echo guard: after a staged first edit, a
    ```cfg block containing lines ABSENT from the project is the r5
    multi-part give-up shape — still inert, still nudged."""
    ctx = {'printer.cfg': {'content': PRINTER_CFG + '\n[fan]\npin: PA0\n'
                                             'cycle_time: 0.01\n'}}
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('max_accel staged. And for the fan:\n\n'
                     '```cfg\n[fan]\ncycle_time: 0.02\n```\n'),
        _text_tool_call('config_edit', {'file': 'printer.cfg',
                                        'op': 'set_param', 'section': 'fan',
                                        'key': 'cycle_time', 'value': '0.02'}),
        _final_reply('Both changes staged.'),
    ])
    resp = client.post('/ai/chat', json=_chat_payload(
        'post-hoc-echo-2', contextFiles=ctx,
        messages=[{'role': 'user', 'content':
                   'set max_accel to 3000 and fan cycle_time to 0.02'}]))
    assert resp.status_code == 200
    body = resp.json()
    assert body['pendingEdits']
    assert any('cycle_time' in (e.get('newText') or '')
               or 'cycle_time' in e.get('summary', '')
               for e in body['pendingEdits']), body['pendingEdits']


def test_reprompt_write_respects_skill_gate(edit_flag, monkeypatch):
    """The no-tools empty-response re-prompt must still honour the skill
    gate: a write call there gets the load_skill kickback, never executes."""
    scripted = _install(monkeypatch, [
        {'choices': [{'message': {'content': None}}]},   # empty -> re-prompt
        _text_tool_call('config_edit', SET_ACCEL),        # reprompt write
        _final_reply('I need to load the editing skill first.'),
    ])
    r = client.post('/ai/chat', json=_chat_payload(
        'post-hoc-reprompt-skill', editSkill=False))
    assert r.status_code == 200
    body = r.json()
    assert not body.get('pendingEdits'), body
    assert body.get('changeSet') is None
    assert body.get('editAttempts') in (0, None), body
    followup = json.dumps(scripted.payloads[-1])
    assert 'is not available yet' in followup


def test_reprompt_write_stages_on_the_ungated_path(edit_flag, monkeypatch):
    """Skill active: a write on the re-prompt path stages like any other —
    one staging surface, not two."""
    _install(monkeypatch, [
        {'choices': [{'message': {'content': None}}]},
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Set max_accel to 3000.'),
    ])
    r = client.post('/ai/chat', json=_chat_payload('post-hoc-reprompt-write'))
    assert r.status_code == 200
    body = r.json()
    assert body['pendingEdits'][0]['file'] == 'printer.cfg'
    assert 'max_accel: 3000' in body['pendingEdits'][0]['newText']
    assert client.get(
        '/ai/chat/approval?requestId=post-hoc-reprompt-write').json() == {
            'pending': False}
