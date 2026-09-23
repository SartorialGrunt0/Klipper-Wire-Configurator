"""Phase 2 tests: the approval gate (suspend -> decide -> resume).

Covers the plan's Phase 2 requirements:
- validated write SUSPENDS in-request; GET /ai/chat/approval surfaces
  the card; approve commits (re-validated against the frontend's latest
  contextFiles) and the loop continues;
- decline reverts (nothing staged) and the model gets an honest result;
- timeout auto-declines with the honest 'did not respond' reason;
- NEVER a card for a call with new validation errors (kickback is
  identical to the auto-approve path);
- approve-after-manual-edit: clean re-apply vs anchor-miss invalidation;
- double decision rejected; decision on unknown id -> not_found;
- multi-call serialization (second card only after the first decision);
- autoApproveEdits bypasses the wait but not validation.

Concurrency pattern: the chat request runs in a helper thread while the
main thread polls/decides, mirroring the real frontend.
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
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', lambda *a, **k: scripted)
    return scripted


@pytest.fixture()
def edit_flag(monkeypatch):
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use


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
    """Poll until the card appears; return its payload."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f'/ai/chat/approval?requestId={request_id}')
        body = r.json()
        if body.get('pending'):
            return body
        time.sleep(0.05)
    raise AssertionError('approval card never appeared')


# ── suspend / approve ────────────────────────────────────────────────────

def test_validated_write_suspends_and_approve_commits(edit_flag, monkeypatch):
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Set max_accel to 3000.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-approve-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-approve-1')
    assert card['file'] == 'printer.cfg'
    assert card['op'] == 'set_param'
    assert card['timeoutSeconds'] > 0
    assert 'approvalId' in card

    # Nothing is staged until the decision lands.
    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx(),
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    assert body['pendingEdits'][0]['file'] == 'printer.cfg'
    assert 'max_accel: 3000' in body['pendingEdits'][0]['newText']
    # The approved result re-entering model context is honest about
    # approval (not 'saved').
    followup = json.dumps(scripted.payloads[-1])
    assert 'APPROVED' in followup


def test_decline_reverts_and_model_gets_honest_result(edit_flag, monkeypatch):
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Understood, leaving it as is.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-decline-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-decline-1')
    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline',
        'reason': 'I want to keep the stock value',
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    body = result['body']
    # NOTHING staged — a declined op never enters pendingEdits.
    assert not body['pendingEdits']
    assert body['editAttempts'] == 1


def test_no_card_for_invalid_call(edit_flag, monkeypatch):
    """Plan law: a call with new validation errors kicks back
    immediately — no card, no wait, identical lean error."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'ghost', 'key': 'x', 'value': '1'}),
        _final_reply('That section does not exist.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set x in [ghost]'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-invalid-1', 'autoApproveEdits': False,
    }
    resp = client.post('/ai/chat', json=payload, timeout=30)
    assert resp.status_code == 200
    body = resp.json()
    assert not body['pendingEdits']
    # No card ever existed for the invalid op.
    assert client.get('/ai/chat/approval?requestId=gate-invalid-1').json() == {'pending': False}


def test_double_decision_rejected(edit_flag, monkeypatch):
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('OK.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-double-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-double-1')
    url = '/ai/chat/approval'
    d1 = client.post(url, json={'approvalId': card['approvalId'], 'decision': 'decline'})
    d2 = client.post(url, json={'approvalId': card['approvalId'], 'decision': 'approve'})
    assert d1.json()['status'] == 'ok'
    assert d2.json()['status'] == 'already_decided'
    t.join(timeout=10)
    assert not result['body']['pendingEdits']  # decline won; approve ignored


def test_unknown_approval_id():
    r = client.post('/ai/chat/approval', json={
        'approvalId': 'nope', 'decision': 'approve'})
    assert r.json()['status'] == 'not_found'


def test_manual_edit_during_pending_invalidates_anchor(edit_flag, monkeypatch):
    """Approve carries the frontend's LATEST files; if the anchor died,
    the decision is NOT accepted and the card stays open for decline."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'patch_gcode',
                                        'section': 'gcode_macro PARK',
                                        'old_text': 'G1 Z5', 'new_text': 'G1 Z10'}),
        _final_reply('Waiting on your review.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'raise PARK to Z10'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-stale-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-stale-1')

    # User manually edits the macro body in the editor during the window.
    edited = PRINTER_CFG.replace('G1 Z5', 'G1 Z7')
    stale_ctx = {'printer.cfg': {'content': edited, 'label': 'printer.cfg'}}

    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': stale_ctx,
    })
    body = dec.json()
    assert body['status'] == 'invalidated'
    # Card is STILL open (user can decline or fix and retry).
    again = client.get('/ai/chat/approval?requestId=gate-stale-1').json()
    assert again['pending'] is True
    # Decline closes it honestly; nothing was staged.
    dec2 = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline',
        'reason': 'anchor moved', 'contextFiles': stale_ctx,
    })
    assert dec2.json()['status'] == 'ok'
    t.join(timeout=10)
    assert not result['body']['pendingEdits']


def test_manual_edit_clean_reapply(edit_flag, monkeypatch):
    """Same window, but the manual edit does NOT touch the anchor:
    approve re-applies cleanly to the LATEST text (never clobbers)."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Done.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-merge-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-merge-1')
    # Manual edit elsewhere in the file (velocity), anchor intact.
    edited = PRINTER_CFG.replace('max_velocity: 200', 'max_velocity: 250')
    dec = client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': {'printer.cfg': {'content': edited, 'label': 'printer.cfg'}},
    })
    assert dec.json()['status'] == 'ok'
    t.join(timeout=10)
    new_text = result['body']['pendingEdits'][0]['newText']
    assert 'max_accel: 3000' in new_text      # approved op applied
    assert 'max_velocity: 250' in new_text    # manual edit preserved


def test_timeout_auto_declines(edit_flag, monkeypatch):
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('No response received.'),
    ])
    monkeypatch.setattr(ai_routes, 'APPROVAL_TIMEOUT_SECONDS', 0.4)
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-timeout-1', 'autoApproveEdits': False,
    }
    resp = client.post('/ai/chat', json=payload, timeout=30)
    assert resp.status_code == 200
    body = resp.json()
    assert not body['pendingEdits']
    assert 'did not respond' in json.dumps(body['toolCalls'])


def test_multi_call_serializes_cards(edit_flag, monkeypatch):
    """Two write calls in one assistant message: the second suspends
    only after the first is decided (one pending card at a time)."""
    _install(monkeypatch, [
        {'choices': [{'message': {'content':
            '```tool\n' + json.dumps({'name': 'config_edit', 'arguments': {
                k: str(v) for k, v in SET_ACCEL.items()}}) + '\n```\n'
            '```tool\n' + json.dumps({'name': 'config_edit', 'arguments': {
                'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
                'key': 'max_velocity', 'value': '300'}}) + '\n```'}}]},
        _final_reply('Both staged.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'accel 3000, velocity 300'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-multi-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card1 = _wait_card('gate-multi-1')
    assert card1['summary']
    # Only ONE unresolved card exists while card1 is pending.
    from services.ai_edit_tools import _pending_approvals
    only = [a for a in _pending_approvals.values()
            if a.request_id == 'gate-multi-1']
    assert len(only) == 1
    client.post('/ai/chat/approval', json={
        'approvalId': card1['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx()})
    card2 = _wait_card('gate-multi-1')
    assert card2['approvalId'] != card1['approvalId']
    client.post('/ai/chat/approval', json={
        'approvalId': card2['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx()})
    t.join(timeout=10)
    body = result['body']
    edits = body['pendingEdits']
    assert len(edits) == 1  # same file, cumulative
    assert 'max_accel: 3000' in edits[0]['newText']
    assert 'max_velocity: 300' in edits[0]['newText']


def test_auto_approve_skips_wait_but_not_validation(edit_flag, monkeypatch):
    """autoApproveEdits=True: no card ever appears, invalid ops still
    kick back (the override bypasses ONLY the human wait)."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'ghost', 'key': 'x', 'value': '1'}),
        _final_reply('Not found.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set x in [ghost]'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-auto-1', 'autoApproveEdits': True,
    }
    resp = client.post('/ai/chat', json=payload, timeout=30)
    assert resp.status_code == 200
    assert not resp.json()['pendingEdits']
    assert client.get('/ai/chat/approval?requestId=gate-auto-1').json() == {'pending': False}


def test_poll_without_request_id_is_harmless():
    assert client.get('/ai/chat/approval').json() == {'pending': False}


# ── unit-level: no auto_approve default anywhere in the write path ──────

def test_no_auto_approve_default_in_gate():
    """Gate-2 audit: the production default is human-only. The ONLY
    bypass is the explicit request-level harness field."""
    import inspect
    src = inspect.getsource(ai_routes.chat_proxy)
    assert 'autoApproveEdits' in src
    # The gate helper itself never consults an env default for approval.
    gate_src = inspect.getsource(ai_routes._run_approval_gate)
    assert 'environ' not in gate_src


def test_duplicate_target_never_opens_second_card(edit_flag, monkeypatch):
    """Live smoke evidence (2026-09-14): after the user APPROVED
    set_param max_accel=3200, gemma copied the nudge example and re-sent
    the SAME (file, section, key) with a hallucinated 12000 — opening
    card #2, taxing the human another 90s. The guard blocks repeats of
    an already-approved target with an honest kickback, no card."""
    repeat = {'file': 'printer.cfg', 'op': 'set_param',
              'section': 'printer', 'key': 'max_accel', 'value': '12000'}
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _text_tool_call('config_edit', repeat),
        _final_reply('All set.'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3200'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-dupe-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-dupe-1')
    client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve',
        'contextFiles': _ctx()})
    # The repeat must NOT open a card (2s window — scripted provider is
    # instant, so a would-be card appears well within it).
    deadline = time.time() + 2.0
    while time.time() < deadline:
        assert not client.get(
            '/ai/chat/approval?requestId=gate-dupe-1').json().get('pending')
        time.sleep(0.05)
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    staged = json.dumps(body['pendingEdits'])
    assert 'max_accel: 3000' in staged
    assert '12000' not in staged
    from services.ai_edit_tools import _pending_approvals
    assert not [a for a in _pending_approvals.values()
                if a.request_id == 'gate-dupe-1' and not a.resolved]


def test_decline_shields_cfg_block_nudge(edit_flag, monkeypatch):
    """After a DECLINE the answer is user-gated: a trailing ```cfg block
    must not pull the model into a nudge retry of the same target (the
    r6 inert-draft rule yields to an explicit user decision)."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('Leaving it. For reference:\n\n'
                     '```cfg\n[printer]\nmax_accel: 1000\n```\n'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-shield-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-shield-1')
    client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline',
        'reason': 'keep stock'})
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    # The declined-turn prose came back UN nudged: a fired nudge would
    # have popped another scripted reply ('Done.') as the final content.
    assert 'For reference' in body['content']
    assert not body['pendingEdits']


def test_approve_then_cfg_echo_not_nudged(edit_flag, monkeypatch):
    """Native-mode traces 2026-09-17: right after an APPROVED write,
    gemma re-quotes the staged section in a ```cfg block to show it.
    That is a display echo, not an inert draft — the prose nudge must
    NOT fire (it gaslit the model into 'which parameter would you like
    to change?' after it had staged the only parameter)."""
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        # post-approve summary quoting the STAGED value (structural echo:
        # every config line already exists in the working state)
        _final_reply('I have added the change to your printer.cfg. I used:\n\n'
                     '```cfg\n# file: printer.cfg\n[printer]\nmax_accel: 3000\n```\n'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-echo-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-echo-1')
    client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve'})
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    # A fired nudge would have consumed another scripted reply and
    # replaced this one; the echo must come back untouched.
    assert 'I have added the change' in body['content']
    assert body['pendingEdits']
    # Branch-identity assert: NO nudge text entered any provider payload.
    assert not any('Call the tool NOW' in str(p) for p in scripted.payloads)


def test_multipart_giveup_after_staged_first_half_still_nudged(edit_flag, monkeypatch):
    """Negative control for the echo guard: after a staged (approved)
    first edit, a ```cfg block containing lines ABSENT from the project
    is the r5 multi-part give-up shape — still inert, still nudged."""
    ctx = {'printer.cfg': {'content': PRINTER_CFG + '\n[fan]\npin: PA0\ncycle_time: 0.01\n'}}
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        # first half staged; second half drafted as prose with a NEW value
        _final_reply('max_accel staged. And for the fan:\n\n'
                     '```cfg\n[fan]\ncycle_time: 0.02\n```\n'),
        # after nudge: the model stages the second half properly
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'fan', 'key': 'cycle_time',
                                        'value': '0.02'}),
        _final_reply('Both changes staged.'),
    ])
    payload = {
        'messages': [{'role': 'user',
                      'content': 'set max_accel to 3000 and fan cycle_time to 0.02'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': ctx,
        'requestId': 'gate-echo-2', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-echo-2')
    client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'approve'})
    # the nudge-driven second write opens its own card
    card2 = _wait_card('gate-echo-2')
    client.post('/ai/chat/approval', json={
        'approvalId': card2['approvalId'], 'decision': 'approve'})
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    assert body['pendingEdits']
    assert any('cycle_time' in (e.get('newText') or '')
               or e.get('summary', '').find('cycle_time') >= 0
               for e in body['pendingEdits']), body['pendingEdits']


# ── Decline-result wording (dogfood 2026-09-20: passive "DECLINED by the
# user (no reason given)" + blanket confab note made gemma report a plain
# decline as "the system declined it" and ramble without asking) ──────

def test_decline_result_wording_and_user_gated_note(edit_flag, monkeypatch):
    """Decline tool result names the human as decider, states NOT
    staged, forbids retry, and demands a direct closing question; the
    trace-truth note for a user-gated turn says 'user chose not to
    apply', never the validation-conflating blanket text."""
    _install(monkeypatch, [
        _text_tool_call('config_edit', SET_ACCEL),
        _final_reply('ok then'),
    ])
    payload = {
        'messages': [{'role': 'user', 'content': 'set max_accel to 3000'}],
        'apiKey': 'k', 'model': 'm',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt', 'contextFiles': _ctx(),
        'requestId': 'gate-wording-1', 'autoApproveEdits': False,
    }
    t, result = _post_chat_bg(payload)
    card = _wait_card('gate-wording-1')
    client.post('/ai/chat/approval', json={
        'approvalId': card['approvalId'], 'decision': 'decline'})
    t.join(timeout=10)
    assert result['status'] == 200
    body = result['body']
    out = next(tc['output'] for tc in body['toolCalls']
               if tc['name'] == 'config_edit')
    assert 'NOT APPROVED' in out
    assert 'the user reviewed the change and chose' in out
    assert 'not an error on your' in out
    assert 'END WITH A DIRECT QUESTION' in out
    assert 'no reason given' not in out        # empty reason is silence, not noise
    assert 'Reason given' not in out
    # user-gated trace-truth note (blanket validation text must be gone)
    assert 'the user chose not to apply' in body['content']
    assert 'failed validation, was declined, or timed out' not in body['content']
    assert not body['pendingEdits']


def test_decline_reason_and_timeout_note_wording(edit_flag, monkeypatch):
    """A supplied decline reason rides the result verbatim under a
    neutral label; the timeout result keeps the honest 'did not respond'
    phrasing."""
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
