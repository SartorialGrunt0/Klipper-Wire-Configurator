"""Post-hoc edit review: the change set, its resolution, and steering.

Three contracts, all of them about what happens AFTER (or during) a request
that stages edits rather than suspending on them:

1. **The change set** rides back with the reply — one record per edit in the
   order the model made them, plus a summary grouped by file/section whose
   totals count only the surviving (non-superseded) set.
2. **Resolution** (keep/undo) is a REPLAY of the kept ops onto the file's
   pre-request baseline, never a text revert — and a file the human edited
   mid-loop is never clobbered; its stale ops are reported instead.
3. **Steering** queues real user speech into an in-flight request at the
   next tool-turn boundary, clearing the deterministic ledgers and both
   budgets so a redirected request can act on the new instruction.
"""
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

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000

[stepper_x]
microsteps: 16
rotation_distance: 40

[gcode_macro PARK]
gcode:
    G91
    G1 Z5
"""


def _ctx(content=PRINTER_CFG):
    return {'printer.cfg': {'content': content}}


def _tool_call(name, arguments):
    block = f"```tool\n{json.dumps({'name': name, 'arguments': arguments})}\n```"
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
    """Replies in order; optional hook per provider call."""

    def __init__(self, replies, on_call=None):
        self.replies = list(replies)
        self.payloads = []
        self.on_call = on_call

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        if self.on_call is not None:
            self.on_call(len(self.payloads) + 1, json)
        self.payloads.append(json)
        reply = self.replies.pop(0) if self.replies else _final_reply()
        return _Resp(reply)

    async def get(self, url, headers=None):
        raise AssertionError('Unexpected GET')


def _install(monkeypatch, replies, on_call=None):
    from api.printer_memory_routes import PrinterMemory
    scripted = _ScriptedClient(replies, on_call=on_call)
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    return scripted


def _payload(request_id, **overrides):
    payload = {
        'messages': [{'role': 'user', 'content': 'change my printer settings'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(), 'editSkill': True,
        'requestId': request_id,
    }
    payload.update(overrides)
    return payload


def _run(monkeypatch, replies, request_id, on_call=None, **overrides):
    _install(monkeypatch, replies, on_call=on_call)
    resp = client.post('/ai/chat', json=_payload(request_id, **overrides))
    assert resp.status_code == 200, resp.text
    return resp.json()


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


SET_ACCEL = {'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
             'key': 'max_accel', 'value': '3000'}
SET_VELOCITY = {'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
                'key': 'max_velocity', 'value': '300'}
SET_MICROSTEPS = {'file': 'printer.cfg', 'op': 'set_param',
                  'section': 'stepper_x', 'key': 'microsteps', 'value': '32'}


# ══ The change set ══════════════════════════════════════════════════════


def test_change_set_groups_by_file_and_section(monkeypatch):
    body = _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _tool_call('config_edit', SET_VELOCITY),
        _final_reply('Both set.'),
    ], 'cs-group-1')

    change_set = body['changeSet']
    assert [e['id'] for e in change_set['edits']] == ['e0', 'e1']
    assert [e['section'] for e in change_set['edits']] == ['printer', 'printer']
    assert change_set['totalAdded'] == 2
    assert change_set['totalRemoved'] == 2

    assert len(change_set['files']) == 1
    entry = change_set['files'][0]
    assert entry['file'] == 'printer.cfg'
    assert [s['section'] for s in entry['sections']] == ['printer']
    assert entry['sections'][0]['edits'] == ['e0', 'e1']
    # Line numbers are deliberately NOT part of a row's identity.
    assert 'line' not in json.dumps(change_set['edits'][0]).lower()


def test_change_set_rows_carry_their_own_mini_diff(monkeypatch):
    # A file long enough that "compact" is a real claim: the unfold payload
    # must be the changed neighbourhood, not the whole file.
    long_cfg = PRINTER_CFG + '\n'.join(
        f'[gcode_macro M{i:02d}]\ngcode:\n    M117 hello {i}\n'
        for i in range(20))
    body = _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _final_reply('Done.'),
    ], 'cs-diff-1', contextFiles=_ctx(long_cfg))
    diff_text = body['changeSet']['edits'][0]['diffText']
    assert '-max_accel: 1000' in diff_text
    assert '+max_accel: 3000' in diff_text
    assert len(diff_text.splitlines()) < 15
    assert 'M117 hello 19' not in diff_text       # not the whole file
    # The before/after pair is NOT shipped per edit — that is why a row
    # carries a unified diff in the first place.
    assert len(json.dumps(body['changeSet'])) < len(long_cfg)
    assert body['changeSet']['edits'][0]['key'] == 'max_accel'


def test_changes_endpoint_serves_the_same_set(monkeypatch):
    body = _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _final_reply('Done.'),
    ], 'cs-get-1')
    served = client.get('/ai/chat/changes?requestId=cs-get-1').json()
    assert served['found'] is True
    assert served['edits'] == body['changeSet']['edits']
    assert client.get('/ai/chat/changes?requestId=nope').json() == {'found': False}


# ══ Resolution: keep / undo is a replay, never a text revert ════════════


def test_resolve_undoes_only_the_dropped_edit(monkeypatch):
    _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _tool_call('config_edit', SET_VELOCITY),
        _final_reply('Both set.'),
    ], 'resolve-keep-1')
    # Keep only the accel edit: the velocity edit's effect must be GONE,
    # not merely marked.
    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-keep-1',
        'keptEditIds': ['e0'],
        'contextFiles': {'printer.cfg': {'content': (
            PRINTER_CFG.replace('max_accel: 1000', 'max_accel: 3000')
                       .replace('max_velocity: 200', 'max_velocity: 300'))}},
    }).json()
    assert out['status'] == 'ok'
    text = out['files']['printer.cfg']['content']
    assert 'max_accel: 3000' in text      # kept op survives
    assert 'max_velocity: 200' in text    # dropped op reverted to baseline
    assert out['stale'] == []


def test_resolve_with_nothing_kept_restores_the_baseline(monkeypatch):
    _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _tool_call('config_edit', SET_VELOCITY),
        _final_reply('Both set.'),
    ], 'resolve-none-1')
    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-none-1', 'keptEditIds': [],
    }).json()
    assert out['files']['printer.cfg']['content'].strip() == PRINTER_CFG.strip()


def test_resolve_reports_a_stale_op_instead_of_clobbering_a_manual_edit(
        monkeypatch):
    """The user edited the anchor mid-loop: their text wins, and the op that
    no longer applies is reported — never forced through."""
    patch = {'file': 'printer.cfg', 'op': 'patch_section',
             'section': 'gcode_macro PARK', 'old_text': 'G1 Z5',
             'new_text': 'G1 Z10'}
    _run(monkeypatch, [
        _tool_call('config_edit', patch),
        _final_reply('Park lifts to Z10.'),
    ], 'resolve-stale-1')
    edited = PRINTER_CFG.replace('G1 Z5', 'G1 Z7')
    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-stale-1', 'keptEditIds': ['e0'],
        'contextFiles': {'printer.cfg': {'content': edited}},
    }).json()
    assert out['clientEdited'] == ['printer.cfg']
    assert [s['id'] for s in out['stale']] == ['e0']
    assert 'G1 Z7' in out['files']['printer.cfg']['content']  # manual edit kept
    assert 'G1 Z10' not in out['files']['printer.cfg']['content']


def test_resolve_deletes_a_file_the_request_created_when_it_is_rejected(
        monkeypatch):
    body = _run(monkeypatch, [
        _tool_call('config_write', {
            'file': 'macros.cfg', 'content': '[gcode_macro HI]\ngcode:\n    M117 HI\n'}),
        _final_reply('Created macros.cfg.'),
    ], 'resolve-newfile-1')
    assert body['changeSet']['createdFiles'] == ['macros.cfg']
    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-newfile-1', 'keptEditIds': [],
    }).json()
    assert out['files']['macros.cfg'] == {'content': '', 'deleted': True}
    # Keeping it keeps the file.
    out2 = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-newfile-1', 'keptEditIds': ['e0'],
    }).json()
    assert out2['files']['macros.cfg']['deleted'] is False
    assert 'gcode_macro HI' in out2['files']['macros.cfg']['content']


def test_resolve_unknown_request_is_not_found():
    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'nope', 'keptEditIds': []}).json()
    assert out == {'status': 'not_found', 'missing': ['nope']}
    # No segment at all is not_found too (nothing to replay).
    assert client.post('/ai/chat/changes/resolve', json={}).json() == {
        'status': 'not_found'}


def test_a_decision_can_span_several_requests(monkeypatch):
    """The change set is a RUNNING TOTAL (Sir, 2026-10-02): a second message
    does not discard the first message's unreviewed edits, so one undo has to
    replay the whole chain — oldest first, each request's ops onto the state
    the previous one left."""
    _run(monkeypatch, [
        _tool_call('config_edit', SET_ACCEL),
        _final_reply('Set max_accel.'),
    ], 'chain-1')
    # The second message starts from the text the first one produced.
    after_first = PRINTER_CFG.replace('max_accel: 1000', 'max_accel: 3000')
    _run(monkeypatch, [
        _tool_call('config_edit', SET_VELOCITY),
        _final_reply('Set max_velocity.'),
    ], 'chain-2', contextFiles=_ctx(after_first))
    after_second = after_first.replace('max_velocity: 200', 'max_velocity: 300')

    # Drop the FIRST request's edit: the second's survives, because the chain
    # replays it onto the oldest baseline.
    out = client.post('/ai/chat/changes/resolve', json={
        'segments': [
            {'requestId': 'chain-1', 'keptEditIds': []},
            {'requestId': 'chain-2', 'keptEditIds': ['e0']},
        ],
        'contextFiles': {'printer.cfg': {'content': after_second}},
    }).json()
    assert out['status'] == 'ok'
    text = out['files']['printer.cfg']['content']
    assert 'max_accel: 1000' in text        # dropped, back to the baseline
    assert 'max_velocity: 300' in text      # kept
    assert out['stale'] == []

    # Keeping only the first drops the second's edit, even though it sits on
    # top: replay order is what makes that possible. The client now holds the
    # text the previous decision produced, and sends that back — which is what
    # tells the server nobody edited by hand in between.
    out2 = client.post('/ai/chat/changes/resolve', json={
        'segments': [
            {'requestId': 'chain-1', 'keptEditIds': ['e0']},
            {'requestId': 'chain-2', 'keptEditIds': []},
        ],
        'contextFiles': {'printer.cfg': {'content': text}},
    }).json()
    text2 = out2['files']['printer.cfg']['content']
    assert out2['clientEdited'] == []
    assert 'max_accel: 3000' in text2
    assert 'max_velocity: 200' in text2

    # A missing segment fails the whole call rather than replaying a partial
    # chain (that would silently drop a request's edits).
    out3 = client.post('/ai/chat/changes/resolve', json={
        'segments': [
            {'requestId': 'chain-1', 'keptEditIds': []},
            {'requestId': 'gone-request', 'keptEditIds': []},
        ],
    }).json()
    assert out3 == {'status': 'not_found', 'missing': ['gone-request']}


def test_change_set_is_resolvable_while_the_request_is_still_running(
        monkeypatch):
    """Live UI find (2026-10-02): review happens DURING the loop as often as
    after it — 'Reject all' on a change that is still streaming must replay,
    not answer not_found because the reply has not landed yet."""
    import asyncio

    class _HoldingClient(_ScriptedClient):
        """Holds the follow-up provider call open so the request is
        demonstrably still in flight when the decision is posted."""

        async def post(self, url, headers=None, json=None):
            if self.payloads:
                await asyncio.sleep(1.0)
            return await super().post(url, headers=headers, json=json)

    from api.printer_memory_routes import PrinterMemory
    holding = _HoldingClient([
        _tool_call('config_edit', SET_ACCEL),
        _final_reply('Set max_accel to 3000.'),
    ])
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: holding)

    t, result = _post_chat_bg(_payload('resolve-midloop-1'))
    session = None
    deadline = time.time() + 10
    while time.time() < deadline:
        session = ai_routes._edit_sessions.get('resolve-midloop-1')
        if session is not None and session.edit_records:
            break
        time.sleep(0.02)
    assert session is not None and session.edit_records, 'no staged edit seen'
    assert t.is_alive(), 'precondition: the request must still be running'

    out = client.post('/ai/chat/changes/resolve', json={
        'requestId': 'resolve-midloop-1', 'keptEditIds': []}).json()
    assert out['status'] == 'ok'
    assert 'max_accel: 1000' in out['files']['printer.cfg']['content']
    t.join(timeout=20)
    assert result['status'] == 200


# ══ Steering ════════════════════════════════════════════════════════════


def test_steer_endpoint_rejects_requests_that_are_not_in_flight():
    out = client.post('/ai/chat/steer', json={
        'requestId': 'ghost-request', 'message': 'use 64'}).json()
    assert out['accepted'] is False
    assert out['reason'] == 'no in-flight request'
    out = client.post('/ai/chat/steer', json={
        'requestId': '', 'message': 'use 64'}).json()
    assert out['accepted'] is False


def test_steered_re_edit_is_one_net_change_with_no_duplicate_target(
        monkeypatch):
    """The plan's probe: stage microsteps 32, the user steers 'use 64', the
    model re-edits the SAME target — one net change to 64, no DUPLICATE
    TARGET kickback, and the transcript keeps both rows honestly."""
    state = {'steered': False}

    def on_call(index, request_json):
        # The user types while the loop is between turns: queue the steer
        # the moment the first tool result is on its way back to the model.
        if index == 2 and not state['steered']:
            state['steered'] = True
            ai_routes._chat_steers.setdefault('steer-1', []).append('use 64')

    scripted = _install(monkeypatch, [
        _tool_call('config_edit', SET_MICROSTEPS),          # turn 1
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),  # dropped
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),  # re-edit
        _final_reply('Microsteps are 64.'),
    ], on_call=on_call)

    resp = client.post('/ai/chat', json=_payload('steer-1'))
    assert resp.status_code == 200
    body = resp.json()

    # The steer was injected as USER SPEECH, never a tool result.
    steer_payload = scripted.payloads[2]
    assert steer_payload['messages'][-1] == {'role': 'user',
                                             'content': 'use 64'}
    # The response the model had produced for the OLD instruction was
    # dropped, not executed. editAttempts is the BUDGET counter, which the
    # steer reset — so the steered re-edit reads 1, not 2.
    assert body['editAttempts'] == 1

    tool_output = json.dumps(body['toolCalls'])
    assert 'DUPLICATE TARGET' not in tool_output
    assert body['steers'] == [{'turn': 1, 'text': 'use 64'}]

    change_set = body['changeSet']
    assert [e['id'] for e in change_set['edits']] == ['e0', 'e1']
    assert change_set['edits'][0]['superseded'] is True
    assert change_set['edits'][1]['superseded'] is False
    assert change_set['totalAdded'] == 1     # net: 16 -> 64 is one hunk
    assert change_set['totalRemoved'] == 1
    assert 'microsteps: 64' in body['pendingEdits'][0]['newText']
    assert 'microsteps: 32' not in body['pendingEdits'][0]['newText']


def test_steer_resets_the_write_budget(monkeypatch):
    """A steer resets the write budget: without it, the re-edit after a
    redirect would be refused by a cap the model already spent driving the
    wrong way."""
    monkeypatch.setenv('KWC_EDIT_WRITE_CAP', '1')
    state = {'steered': False}

    def on_call(index, request_json):
        if index == 2 and not state['steered']:
            state['steered'] = True
            ai_routes._chat_steers.setdefault('steer-budget-1', []).append(
                'actually use 64')

    _install(monkeypatch, [
        _tool_call('config_edit', SET_MICROSTEPS),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _final_reply('Microsteps are 64.'),
    ], on_call=on_call)

    resp = client.post('/ai/chat', json=_payload('steer-budget-1'))
    assert resp.status_code == 200
    body = resp.json()
    assert 'WRITE LIMIT REACHED' not in json.dumps(body['toolCalls'])
    assert 'microsteps: 64' in body['pendingEdits'][0]['newText']


def test_steer_endpoint_accepts_while_the_request_is_live(monkeypatch):
    """The HTTP rail itself: an in-flight request accepts a steer and it
    reaches the model; a finished request's id is not steerable."""
    accepted = {}

    def on_call(index, request_json):
        if index == 1:
            # The request is registered before its first provider call, so
            # this is the same window the UI posts in.
            r = client.post('/ai/chat/steer', json={
                'requestId': 'steer-live-1', 'message': 'use 64'})
            accepted['body'] = r.json()

    scripted = _install(monkeypatch, [
        _tool_call('config_edit', SET_MICROSTEPS),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _final_reply('Microsteps are 64.'),
    ], on_call=on_call)

    resp = client.post('/ai/chat', json=_payload('steer-live-1'))
    assert resp.status_code == 200
    assert accepted['body'] == {'accepted': True, 'queued': 1}
    assert resp.json()['steers'] == [{'turn': 1, 'text': 'use 64'}]
    assert any('use 64' in json.dumps(p) for p in scripted.payloads)


def test_steer_queue_is_drained_once(monkeypatch):
    """The queue is a queue: after injection the same text is not
    re-injected on the next boundary."""
    state = {'steered': False}

    def on_call(index, request_json):
        if index == 2 and not state['steered']:
            state['steered'] = True
            ai_routes._chat_steers.setdefault('steer-once-1', []).append('use 64')

    scripted = _install(monkeypatch, [
        _tool_call('config_edit', SET_MICROSTEPS),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _tool_call('config_edit', dict(SET_MICROSTEPS, value='64')),
        _final_reply('Microsteps are 64.'),
    ], on_call=on_call)
    resp = client.post('/ai/chat', json=_payload('steer-once-1'))
    assert resp.status_code == 200
    assert resp.json()['steers'] == [{'turn': 1, 'text': 'use 64'}]
    assert not ai_routes._chat_steers.get('steer-once-1')


def test_steer_clears_the_identical_failure_ledger(monkeypatch):
    """A failed call repeated after a steer is not the 3x repetition loop —
    the ledger was cleared by the user's message."""
    from services.ai_edit_tools import EditSession
    session = EditSession(_ctx())
    bad = {'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param', 'section': 'ghost',
        'key': 'x', 'value': '1'}}
    for _ in range(3):
        session.execute(bad)
    assert session._repetition_blocked('config_edit', bad['arguments'])
    session.apply_steer()
    assert session._repetition_blocked('config_edit', bad['arguments']) is None
    assert session.edit_attempts == 0
