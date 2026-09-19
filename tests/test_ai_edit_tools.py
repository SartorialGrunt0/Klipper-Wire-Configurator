"""Phase 1 tests: config_edit/config_write in the chat loop (KWC_EDIT_TOOLS).

Covers the plan's Phase 1 requirements:
- tool specs advertised on BOTH surfaces (native + text snippet parity),
- write calls routed request-scoped through EditSession (never the MCP
  server), kickback -> re-attempt converges in <=2 with a scripted model,
- validation failure does NOT stop the loop,
- pendingEdits + editAttempts on the response,
- flag off (default): tools absent everywhere, unknown-tool behavior
  unchanged (prose path untouched),
- no contextFiles -> no session, no advertisement even with the flag on.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from services.ai_edit_tools import (  # noqa: E402
    EDIT_TOOL_NAMES,
    EDIT_TOOL_SPECS,
    EditSession,
)

client = TestClient(app)

PRINTER_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100

[stepper_x]
step_pin: PF13
dir_pin: PF12
rotation_distance: 40
microsteps: 16

[stepper_y]
step_pin: PF11
dir_pin: PB3
rotation_distance: 40
microsteps: 16

[stepper_z]
step_pin: PB5
dir_pin: BB5
rotation_distance: 8
microsteps: 16

[gcode_macro PRINT_START]
gcode:
    G28
    M104 S200
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
        # Phase 2: validated writes now suspend for a human card. These
        # tests exercise the tool LOOP, not the gate; the gate has its own
        # suite (test_ai_approval_gate.py). Tests that want the real gate
        # pass autoApproveEdits=False explicitly.
        'autoApproveEdits': True,
    }
    payload.update(over)
    return payload


def _text_tool_call(name, arguments):
    """Model reply in the text protocol shape."""
    args = {k: str(v) for k, v in arguments.items()}
    block = f"```tool\n{json.dumps({'name': name, 'arguments': args})}\n```"
    return {'choices': [{'message': {'content': f'Sure.\n\n{block}'}}]}


def _final_reply(text='Done — I adjusted the config.'):
    return {'choices': [{'message': {'content': text}}]}


@pytest.fixture()
def edit_flag(monkeypatch):
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')


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


def _install(monkeypatch, replies):
    from api.printer_memory_routes import PrinterMemory
    scripted = _ScriptedClient(replies)

    def factory(*args, **kwargs):
        return scripted

    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)
    monkeypatch.setattr(ai_routes.httpx, 'AsyncClient', factory)
    return scripted


# ── advertisement parity + gating ───────────────────────────────────────

def test_write_tools_not_advertised_by_default():
    ctx = ai_routes._build_mcp_tool_context()
    assert 'config_edit' not in ctx
    native = ai_routes._build_native_tools()
    names = {t['function']['name'] for t in native}
    assert EDIT_TOOL_NAMES.isdisjoint(names)


def test_write_tools_advertised_on_both_surfaces():
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True)
    assert '- config_edit:' in ctx
    assert '- config_write:' in ctx
    native = ai_routes._build_native_tools(edit_capable=True)
    by_name = {t['function']['name']: t['function'] for t in native}
    assert EDIT_TOOL_NAMES <= set(by_name)
    # Parity: every schema param of the edit specs appears in its text
    # snippet (same lock as test_tool_context_snippets_cover_schema_params).
    for spec in EDIT_TOOL_SPECS:
        snippet = ai_routes._EDIT_TOOL_SNIPPETS[spec['name']]
        for param in spec['inputSchema']['properties']:
            assert param in snippet, f"{spec['name']}.{param} missing from snippet"
    # Enum values in the native schema must be mentioned in the snippet too.
    op_enum = by_name['config_edit']['parameters']['properties']['op']['enum']
    snippet = ai_routes._EDIT_TOOL_SNIPPETS['config_edit']
    for value in op_enum:
        assert value in snippet


def test_edit_protocol_prompt_only_when_capable(monkeypatch):
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    plain = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    assert 'config_edit' not in plain[0]['content']
    edit = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}],
                                       edit_capable=True)
    assert 'Config Edit' in edit[0]['content'] or 'config_edit' in edit[0]['content']
    assert 'display-only' in edit[0]['content']


# ── Phase 3: model-triggered edit skill (KWC_EDIT_SKILL_GATE) ──────────

_SKILL_RESULT_MSG = ('[Tool result: load_skill(name=config-editing)]\n\n'
                     'ok\n\n[End tool result. Use this information to answer '
                     'the user\u2019s latest (last) request above. Earlier '
                     'messages are history and context. Do not repeat the tool call.]')


def test_load_skill_active_predicate():
    from api.ai_routes import _load_skill_active
    assert not _load_skill_active([{'role': 'user', 'content': 'set max_accel'}])
    assert not _load_skill_active([{'role': 'user', 'content': 'load_skill'}])
    assert _load_skill_active([
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': _SKILL_RESULT_MSG},
    ])
    assert _load_skill_active([{'role': 'user', 'content': _SKILL_RESULT_MSG}])
    # native echo shape: assistant message with tool_calls list
    assert _load_skill_active([{
        'role': 'assistant', 'content': '',
        'tool_calls': [{'function': {'name': 'load_skill', 'arguments': '{}'}}],
    }])
    # system prompt mentions the tool but must not count as activation
    assert not _load_skill_active([
        {'role': 'system', 'content': 'available_skills load_skill config-editing'}])


def test_skill_gate_hides_write_tools_until_loaded():
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True, skill_gate=True,
                                            skill_active=False)
    assert '- config_edit:' not in ctx
    assert '- config_write:' not in ctx
    assert 'load_skill' in ctx and 'config-editing' in ctx
    assert '<available_skills>' in ctx
    on = ai_routes._build_mcp_tool_context(edit_capable=True, skill_gate=True,
                                           skill_active=True)
    assert '- config_edit:' in on and '- config_write:' in on


def test_skill_gate_native_parity():
    off = ai_routes._build_native_tools(edit_capable=True, skill_gate=True,
                                        skill_active=False)
    names = {t['function']['name'] for t in off}
    assert 'load_skill' in names
    assert EDIT_TOOL_NAMES.isdisjoint(names)
    on = ai_routes._build_native_tools(edit_capable=True, skill_gate=True,
                                       skill_active=True)
    names_on = {t['function']['name'] for t in on}
    assert EDIT_TOOL_NAMES <= names_on


def test_edit_law_not_in_prompt_until_skill_loaded():
    monkey = __import__('pytest').MonkeyPatch()
    monkey.delenv('KWC_NO_SYSTEM', raising=False)
    monkey.delenv('KWC_MINIMAL_PROMPT', raising=False)
    msgs = [{'role': 'user', 'content': 'hi'}]
    gated = ai_routes._prepare_messages(msgs, edit_capable=True,
                                        skill_gate=True, skill_active=False)
    sys_txt = gated[0]['content']
    assert 'MUST call config_edit' not in sys_txt
    assert 'config-editing' in sys_txt  # index block IS present
    # Status quo (no gate): the law stays in the system prompt verbatim.
    legacy = ai_routes._prepare_messages(msgs, edit_capable=True)
    assert 'MUST call config_edit' in legacy[0]['content']
    monkey.undo()


def test_load_skill_returns_body_with_law_and_tools():
    body = ai_routes._edit_skill_body()
    assert 'config_edit' in body and 'MUST call' in body
    assert 'STAGED' in body
    # text-protocol models need the arg shapes (no schema is sent)
    assert 'set_param' in body and 'patch_gcode' in body


def test_gate_off_preserves_status_quo():
    # No gate: write tools advertised immediately, no skill index.
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True)
    assert '- config_edit:' in ctx and '<available_skills>' not in ctx


# ── session semantics (unit) ────────────────────────────────────────────

def test_session_edit_kickback_then_converge():
    session = EditSession(_ctx())
    # 1) bad kinematics value -> kickback
    content, details = session.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                      'section': 'printer', 'key': 'kinematics', 'value': 'hologate'},
    })
    assert details is None
    assert 'FAILED' in content and 'hologate' in content
    assert session.pending_edits == []
    # 2) corrected -> staged
    content2, details2 = session.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                      'section': 'printer', 'key': 'max_accel', 'value': '3000'},
    })
    assert details2 is not None and 'STAGED' in content2
    assert session.edit_attempts == 2
    payload = session.pending_edits_payload()
    assert payload[0]['file'] == 'printer.cfg'
    assert 'max_accel: 3000' in payload[0]['newText']


def test_session_stacked_edits_same_file_collapse():
    session = EditSession(_ctx())
    session.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
        'key': 'max_accel', 'value': '2000'}})
    session.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param', 'section': 'printer',
        'key': 'max_velocity', 'value': '250'}})
    payload = session.pending_edits_payload()
    assert len(payload) == 1
    assert 'max_accel: 2000' in payload[0]['newText']
    assert 'max_velocity: 250' in payload[0]['newText']


def test_session_anchor_miss_returns_section_text():
    session = EditSession(_ctx())
    content, details = session.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'patch_gcode',
                      'section': 'gcode_macro PRINT_START',
                      'old_text': '    G29 ; not present', 'new_text': 'X'},
    })
    assert details is None
    assert 'G28' in content  # current section text returned for re-quote
    assert 'FAILED' in content


def test_session_config_write_new_file_plus_include():
    session = EditSession(_ctx())
    content, details = session.execute({
        'name': 'config_write',
        'arguments': {'file': 'extra.cfg',
                      'content': '[gcode_macro EXTRA]\ngcode:\n    M117 x\n'},
    })
    assert details is not None
    content2, details2 = session.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'add_include',
                      'target_file': 'extra.cfg'},
    })
    assert details2 is not None
    files = {e['file'] for e in session.pending_edits_payload()}
    assert files == {'extra.cfg', 'printer.cfg'}


# ── route-level loop behavior ───────────────────────────────────────────

def test_flag_off_write_tool_is_unknown(monkeypatch):
    monkeypatch.setenv('KWC_EDIT_TOOLS', '0')
    # Default env (flag off): a hallucinated config_edit call is handled by
    # the pre-existing unknown-tool path; response has no edit keys set.
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'max_accel',
                                        'value': '3000'}),
        _final_reply('I could not apply that.'),
    ])
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 3000'}]))
    assert response.status_code == 200
    body = response.json()
    assert body['pendingEdits'] is None
    assert body['editAttempts'] is None
    # Flag off: config_edit is not a known tool, and the reply carries
    # prose alongside the call, so the hallucinated-tool guard keeps the
    # text and breaks — the write tool NEVER executes.
    assert body['toolCalls'] == []
    assert 'Unknown tool' not in json.dumps(body)


def test_flag_on_edit_applies_and_returns_pending_edits(edit_flag, monkeypatch):
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'max_accel',
                                        'value': '3000'}),
        _final_reply('Set max_accel to 3000 — staged for your review.'),
    ])
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 3000'}]))
    assert response.status_code == 200
    body = response.json()
    assert body['editAttempts'] == 1
    assert body['pendingEdits'][0]['file'] == 'printer.cfg'
    assert 'max_accel: 3000' in body['pendingEdits'][0]['newText']
    # The tool result that re-enters context is the lean success line.
    followup = scripted.payloads[-1]['messages']
    result_msgs = [m for m in followup if 'config_edit applied' in str(m.get('content', ''))]
    assert result_msgs
    # Diff payload never enters the model-facing result.
    assert '"diff"' not in str(result_msgs[0]['content'])


def test_flag_on_kickback_loop_converges_in_two(edit_flag, monkeypatch):
    scripted = _install(monkeypatch, [
        # attempt 1: new error -> kickback as a tool result, loop CONTINUES
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'kinematics',
                                        'value': 'hologate'}),
        # attempt 2: corrected
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'max_accel',
                                        'value': '3000'}),
        _final_reply('max_accel is now 3000.'),
    ])
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set kinematics hologate then max_accel 3000'}]))
    assert response.status_code == 200
    body = response.json()
    assert body['editAttempts'] == 2
    assert body['pendingEdits'][0]['summary'].startswith('set [printer] max_accel')
    # The kickback text entered context with exact validator errors.
    followup = scripted.payloads[1]['messages']
    kickbacks = [m for m in followup if 'FAILED' in str(m.get('content', ''))]
    assert kickbacks and 'hologate' in str(kickbacks[0]['content'])


def test_flag_on_without_context_files_and_empty_mirror_no_session(monkeypatch):
    # No contextFiles AND no mirror content (nothing on disk to seed
    # from): session stays unarmed, edit tools stay unadvertised.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setattr(ai_routes, '_mirror_user_config_files', lambda: {})
    scripted = _install(monkeypatch, [
        _final_reply('no files loaded'),
    ])
    payload = _chat_payload([{'role': 'user', 'content': 'hi'}])
    payload['contextFiles'] = {}
    response = client.post('/ai/chat', json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body['pendingEdits'] is None and body['editAttempts'] is None
    # Edit tools were NOT advertised on the native surface (chatgpt = native).
    assert 'config_edit' not in json.dumps(scripted.payloads[0])


def test_flag_on_without_context_files_seeds_from_mirror(monkeypatch):
    # TRIDENT-16: editTools requested with no contextFiles must still arm
    # the session from the backend user-config mirror — an un-armed
    # request silently loses the whole write path (model correctly falls
    # back to prose when it has no tools).
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    mirror = {'printer.cfg': {'content': '[printer]\nmax_accel: 3000\n'}}
    monkeypatch.setattr(ai_routes, '_mirror_user_config_files', lambda: mirror)
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'max_accel',
                                        'value': '3200'}),
        _final_reply('max_accel staged at 3200.'),
    ])
    payload = _chat_payload([{'role': 'user', 'content': 'set max_accel 3200'}])
    payload['contextFiles'] = {}
    response = client.post('/ai/chat', json=payload)
    assert response.status_code == 200
    body = response.json()
    # Write tools armed from the mirror: the edit stages normally.
    assert body['pendingEdits'] and body['pendingEdits'][0]['summary'].startswith(
        'set [printer] max_accel')
    assert 'config_edit' in json.dumps(scripted.payloads[0])


def test_flag_on_mirror_failure_disables_edit_tools(monkeypatch):
    # A raising mirror must not 500 the chat: edit tools disable for the
    # request and the plain chat path answers.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')

    def boom():
        raise RuntimeError('disk on fire')

    monkeypatch.setattr(ai_routes, '_mirror_user_config_files', boom)
    scripted = _install(monkeypatch, [_final_reply('ok plain answer')])
    payload = _chat_payload([{'role': 'user', 'content': 'hi'}])
    payload['contextFiles'] = {}
    response = client.post('/ai/chat', json=payload)
    assert response.status_code == 200
    assert response.json()['content'] == 'ok plain answer'
    assert 'config_edit' not in json.dumps(scripted.payloads[0])


def test_flag_on_system_prompt_carries_edit_protocol(edit_flag, monkeypatch):
    scripted = _install(monkeypatch, [_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'tweak my config'}]))
    system_msg = scripted.payloads[0]['messages'][0]['content']
    assert 'display-only' in system_msg
    # And the text-protocol surface advertises the write tools.
    assert '- config_edit:' in system_msg


def test_flag_off_system_prompt_lean(edit_flag, monkeypatch):
    # Explicit flag-off parity check (defaults-flip gotcha: set to 0, not delenv).
    monkeypatch.setenv('KWC_EDIT_TOOLS', '0')
    scripted = _install(monkeypatch, [_final_reply('ok')])
    client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'tweak my config'}]))
    system_msg = scripted.payloads[0]['messages'][0]['content']
    assert '- config_edit:' not in system_msg
    assert 'display-only' not in system_msg


def test_prose_edit_response_gets_nudged_into_tool_call(monkeypatch):
    """Edit request answered with a ```cfg block and no tool call: the
    loop must nudge (max 2) and then execute the tool the model emits."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    scripted = [
        # 1st: prose draft, zero tool calls (the old silent path)
        '```cfg\n# file: printer.cfg\n[printer]\n-max_accel: 9000\n+max_accel: 12000\n```\n'
        'I updated max_accel for you.',
        # 2nd (after nudge): the actual tool call
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "printer", "key": "max_accel", "value": "12000"}}\n```',
        # 3rd: final prose after execution
        'Staged the max_accel change for your review.',
    ]
    seen_queries = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        seen_queries.append(json)
        content = scripted[min(len(seen_queries) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 12000 in [printer]'}]))
    assert response.status_code == 200
    body = response.json()
    assert body.get('pendingEdits'), f"expected staged edit, got {body}"
    assert body['pendingEdits'][0]['file'] == 'printer.cfg'
    assert 'max_accel: 12000' in body['pendingEdits'][0]['newText']
    assert len(seen_queries) >= 2  # the nudge re-query happened


def test_qa_response_not_nudged(monkeypatch):
    """Pure Q&A (no edit verb+target) must NOT be prodded by the nudge."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    calls = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        calls.append(json)
        return _Resp({'choices': [{'message': {
            'content': 'pressure_advance compensates for extruder lag...'},
            'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'what is pressure advance?'}]))
    assert response.status_code == 200
    assert len(calls) == 1  # no nudge re-query for Q&A
    assert response.json().get('pendingEdits') in (None, [])


def test_read_then_prose_still_nudged(monkeypatch):
    """r6b qwen3.5-9b EDIT-01 pattern: legitimate read_user_config turn,
    THEN a ```cfg prose draft. The in-loop nudge must catch prose at any
    turn and drive the model to stage the change."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    scripted = [
        # turn 1: legit read call
        'Let me read the section first.\n```tool\n{"name": "read_user_config", '
        '"arguments": {"filename": "printer.cfg", "section": "printer"}}\n```',
        # turn 2: prose draft instead of the write tool (the r6b failure)
        '```cfg\n# file: printer.cfg\n[printer]\n-max_accel: 15500\n+max_accel: 12000\n```',
        # turn 3 (after nudge): the actual write tool call
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "printer", "key": "max_accel", "value": "12000"}}\n```',
        # turn 4: final answer
        'Staged the max_accel change.',
    ]
    seen = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        seen.append(json)
        content = scripted[min(len(seen) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'change [printer] max_accel to 12000'}]))
    assert response.status_code == 200
    body = response.json()
    assert body.get('pendingEdits'), f"expected staged edit after read+prose nudge, got {body}"
    assert 'max_accel: 12000' in body['pendingEdits'][0]['newText']


def test_honest_refusal_not_nudged(monkeypatch):
    """An edit request where the model already TRIED a write tool (rejected
    commented param) and honestly explained: the nudge must NOT poke it
    into forcing the change (edit_attempts>0 gate)."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    calls = []
    scripted = [
        # write tool attempt -> rejected (commented param via real session)
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "stepper_x", "key": "enable_pin", "value": "PF16"}}\n```',
        # honest explanation referencing the refusal -> must NOT be nudged
        ('The enable_pin in [stepper_x] is commented out in your config. '
         'Would you like me to uncomment it?'),
    ]

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        calls.append(json)
        content = scripted[min(len(calls) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    # Refusal premise: enable_pin exists ONLY commented-out, so the real
    # session refuses the set_param (shared fixture lacks it — own context).
    cfg_with_commented = PRINTER_CFG.replace(
        '[stepper_x]\nstep_pin: PF13',
        '[stepper_x]\nstep_pin: PF13\n#enable_pin: !PE9', 1)
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set enable_pin to PF16 on [stepper_x]'}],
        contextFiles={'printer.cfg': {'content': cfg_with_commented}}))
    assert response.status_code == 200
    body = response.json()
    # exactly the initial call + one tool-round re-query; no nudge call
    assert len(calls) == 2, f"nudge fired on honest refusal: {len(calls)} provider calls"
    assert body.get('pendingEdits') in (None, [])


def test_giveup_after_correctable_kickback_gets_nudged(monkeypatch):
    """r4 9b EDIT-01 pattern: write tool refuses with a CORRECTABLE error
    (replace_section fed old_text; missing text), model explains and stops
    without retrying. Giving up on a fixable kickback must be nudged
    (unlike a user-gated commented-param refusal)."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    calls = []
    scripted = [
        # replace_section with wrong args (text missing) -> correctable error
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "replace_section", "section": "printer", "old_text": "max_accel: 1000", '
        '"new_text": "max_accel: 12000"}}\n```',
        # give-up prose (the r4 failure) -> nudge fires
        'I could not apply that change to your config.',
        # after the nudge: the corrected call
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "printer", "key": "max_accel", "value": "12000"}}\n```',
        'Staged the change.',
    ]

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        calls.append(json)
        content = scripted[min(len(calls) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'change [printer] max_accel to 12000'}]))
    assert response.status_code == 200
    body = response.json()
    assert body.get('pendingEdits'), f"expected staged edit after kickback-nudge, got {body}"
    assert 'max_accel: 12000' in body['pendingEdits'][0]['newText']


def _edit_ctx_with_commented():
    cfg = PRINTER_CFG.replace(
        '[stepper_x]\nstep_pin: PF13',
        '[stepper_x]\nstep_pin: PF13\n#enable_pin: !PE9')
    assert '#enable_pin: !PE9' in cfg
    return {'printer.cfg': {'content': cfg}}


def test_multi_refusal_shield_persists_after_boundary_refusal(monkeypatch):
    """r9 9b EDIT-06: after the set_param refusal armed the user-gated
    shield, a SECOND refusal (patch_gcode comment boundary) was
    classified 'correctable', which overwrote the shield; the nudge read
    as permission and the model self-granted allow_comment_change.
    ANY commented refusal keeps the shield: honest prose must go
    unanswered (no nudge)."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    calls = []
    scripted = [
        # 1: set_param -> refused (exists but is commented out)
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "stepper_x", "key": "enable_pin", '
        '"value": "!PF16"}}\n```',
        # 2: patch_gcode un-commenting -> boundary refusal
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "patch_gcode", "section": "stepper_x", "old_text": '
        '"#enable_pin: !PE9", "new_text": "enable_pin: !PE9"}}\n```',
        # 3: honest refusal surface (must NOT be nudged)
        'The enable_pin line is commented out (`#enable_pin: !PE9`), so it is '
        'not active config. Uncommenting it would enable the motor driver pin '
        'unexpectedly — do you want me to uncomment and set it to !PF16?',
    ]

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        calls.append(json)
        content = scripted[min(len(calls) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'Set enable_pin to PF16 on my [stepper_x] in printer.cfg.'}],
        contextFiles=_edit_ctx_with_commented()))
    assert response.status_code == 200
    body = response.json()
    assert not body.get('pendingEdits'), f"shield broken: {body}"
    assert len(calls) == 3, f"expected no nudge round-trips, got {len(calls)} calls"


# ── Confabulated-completion guard (TRIDENT-15) ──────────────────────

def test_confab_note_appended_when_writes_all_failed(monkeypatch):
    # Every config_edit got a correctable kickback (unknown section) and
    # the model still claimed the change was staged. The trace is ground
    # truth: the reply must carry the trace-truth note, and pendingEdits
    # stays null.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    scripted = _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'ghost_section', 'key': 'k',
                                        'value': '1'}),
        _final_reply('The change has been staged and is ready for review.'),
        _final_reply('The change has been staged and is ready for review.'),
        _final_reply('The change has been staged and is ready for review.'),
        _final_reply('The change has been staged and is ready for review.'),
    ])
    payload = _chat_payload([{'role': 'user',
                              'content': 'set max_accel 3200 in printer.cfg'}])
    response = client.post('/ai/chat', json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body['pendingEdits'] is None
    assert body['editAttempts'] and body['editAttempts'] >= 1
    assert 'no changes from this reply are staged' in body['content']


def test_confab_note_absent_when_edit_staged(monkeypatch):
    # A staged edit means the cards show the truth — no note.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    _install(monkeypatch, [
        _text_tool_call('config_edit', {'file': 'printer.cfg', 'op': 'set_param',
                                        'section': 'printer', 'key': 'max_accel',
                                        'value': '3200'}),
        _final_reply('max_accel staged at 3200.'),
    ])
    payload = _chat_payload([{'role': 'user',
                              'content': 'set max_accel 3200 in printer.cfg'}])
    response = client.post('/ai/chat', json=payload)
    body = response.json()
    assert body['pendingEdits']
    assert 'no changes from this reply are staged' not in body['content']


def test_confab_note_absent_for_pure_qa(monkeypatch):
    # No write attempts at all: guard must not touch Q&A replies.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    _install(monkeypatch, [_final_reply('max_accel is in the [printer] section.')])
    payload = _chat_payload([{'role': 'user',
                              'content': 'where is max_accel configured?'}])
    response = client.post('/ai/chat', json=payload)
    body = response.json()
    assert body['content'] == 'max_accel is in the [printer] section.'


def test_native_mode_nudge_drops_fence_law(monkeypatch):
    """Native-first flip 2026-09-17: the fence format law in
    EDIT_NUDGE_TEXT is text-protocol only. Under native function calling
    it breaks template-trained models (live gemma-4-12b traces: 'I cannot
    use that specific fence format... my instructions require me to use
    the internal tool calling system'). The native nudge keeps the
    argument shapes but never mentions the ```tool fence."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setattr(ai_routes, '_mirror_user_config_files', lambda: {})
    seen = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    scripted = [
        # inert draft (value NOT in the project -> echo guard does not
        # suppress; this is the nudge-worthy shape)
        '```cfg\n[printer]\nmax_accel: 4321\n```\nI set it for you.',
        'Staged now.',
    ]

    async def fake_post(url, json=None, headers=None, **kwargs):
        seen.append(json)
        content = scripted[min(len(seen) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    # chatgpt provider over https -> native tools resolved
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 4321'}]))
    assert response.status_code == 200
    assert len(seen) >= 2, 'nudge did not fire'
    nudge_payload = seen[1]
    nudges = [m for m in nudge_payload['messages']
              if 'Call the tool NOW' in str(m.get('content', ''))]
    assert nudges, 'nudge text not in provider payload'
    text = str(nudges[0]['content'])
    assert '```tool' not in text, f'fence law leaked into native nudge: {text}'
    assert 'tool-calling interface' in text
    # and the native tools array is actually present in that payload
    assert nudge_payload.get('tools')


def test_text_mode_nudge_keeps_fence_law(monkeypatch):
    """toolProtocol='text' escape hatch keeps the fence-format nudge —
    text-mode models have no other way to learn the call envelope."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    seen = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            return None
        def json(self):
            return self._payload

    scripted = [
        '```cfg\n[printer]\nmax_accel: 4321\n```\nI set it for you.',
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "printer", "key": "max_accel", '
        '"value": "4321"}}\n```',
        'Staged now.',
    ]

    async def fake_post(url, json=None, headers=None, **kwargs):
        seen.append(json)
        content = scripted[min(len(seen) - 1, len(scripted) - 1)]
        return _Resp({'choices': [{'message': {'content': content},
                                   'finish_reason': 'stop'}]})

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))

    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set max_accel to 4321'}],
        toolProtocol='text'))
    assert response.status_code == 200
    nudges = [m for m in seen[1]['messages']
              if 'Call the tool NOW' in str(m.get('content', ''))]
    assert nudges, 'nudge did not fire in text mode'
    assert '```tool' in str(nudges[0]['content'])


# ── has_inert_draft: comment-line draft shape (r4b TRIDENT-04) ─────────


def _draft_session():
    from services.ai_edit_tools import EditSession
    return EditSession({'printer.cfg': {'content': (
        '[include mainsail.cfg]\n'
        '[include sensorless.cfg]\n'
        '[printer]\n'
        'kinematics: cartesian\n'
        'max_velocity: 200\n'
        '#enable_pin: PF16\n'
    )}})


def test_has_inert_draft_comment_out_is_draft():
    """r4b TRIDENT-04 regression: the 'comment this line out' draft shape
    (line absent, comment-stripped body present) MUST be treated as an
    inert draft. The 0170e82 skip-all-'#' rule called it an echo and
    shipped the inert draft with no nudge."""
    ses = _draft_session()
    assert ses.has_inert_draft([
        '# file: printer.cfg\n'
        '[include mainsail.cfg]\n'
        '#[include sensorless.cfg]\n'
    ]) is True


def test_has_inert_draft_echoes_stay_quiet():
    ses = _draft_session()
    # post-approve display echo incl. '# file:' hint + a genuine project
    # comment (the '#' line exists verbatim in the file)
    assert ses.has_inert_draft([
        '# file: printer.cfg\n'
        '#enable_pin: PF16\n'
        '[printer]\n'
        'kinematics: cartesian\n'
        'max_velocity: 200\n'
    ]) is False
    # brand-new content still drafts
    assert ses.has_inert_draft(['[fan]\ncycle_time: 0.02\n']) is True
    # comment-out of a NONEXISTENT body (plain comment prose) stays quiet
    assert ses.has_inert_draft(['# nothing config-like here\n']) is False


# ── allow_comment_change self-grant lock (r4b EDIT-06) ─────────────────


COMMENTED_CFG = (
    '[stepper_x]\n'
    'step_pin: PE11\n'
    'dir_pin: PE10\n'
    '#enable_pin: !PE9\n'
    'rotation_distance: 40\n'
)


def _stepper_session():
    from services.ai_edit_tools import EditSession
    return EditSession({'printer.cfg': {'content': COMMENTED_CFG}})


def test_allow_comment_change_after_refusal_is_self_grant_blocked():
    """r4b EDIT-06 live trace: set_param refused (commented), the model
    IMMEDIATELY retried with allow_comment_change=true. A user message
    cannot exist between two tool calls in one request, so that flag is
    provably self-granted. The second call must be blocked with an
    honest SELF-GRANT kickback — nothing staged, outcome user_gated."""
    ses = _stepper_session()
    content, _ = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'set_param', 'file': 'printer.cfg',
                      'section': 'stepper_x', 'key': 'enable_pin',
                      'value': 'PF16'}})
    assert 'commented out' in content
    assert ses.last_write_outcome == 'user_gated'

    content2, details2 = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'set_param', 'file': 'printer.cfg',
                      'section': 'stepper_x', 'key': 'enable_pin',
                      'value': 'PF16', 'allow_comment_change': True}})
    assert 'SELF-GRANT' in content2
    assert details2 is None
    assert ses.pending_edits == []
    assert ses.last_write_outcome == 'user_gated'
    # and the patch_gcode flavor of the same self-grant (exact r4b shape)
    content3, details3 = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'patch_gcode', 'file': 'printer.cfg',
                      'section': 'stepper_x',
                      'old_text': 'enable_pin: !PE9',
                      'new_text': 'enable_pin: PF16',
                      'allow_comment_change': True}})
    assert 'SELF-GRANT' in content3
    assert details3 is None
    assert ses.pending_edits == []


def test_allow_comment_change_prepares_blocked_after_refusal():
    """Approval path (prepare) carries the identical lock: a self-granted
    flag never opens a card."""
    ses = _stepper_session()
    c1, r1, _ = ses.prepare({
        'name': 'config_edit',
        'arguments': {'op': 'set_param', 'file': 'printer.cfg',
                      'section': 'stepper_x', 'key': 'enable_pin',
                      'value': 'PF16'}})
    assert r1 is None and 'commented out' in c1
    c2, r2, _ = ses.prepare({
        'name': 'config_edit',
        'arguments': {'op': 'set_param', 'file': 'printer.cfg',
                      'section': 'stepper_x', 'key': 'enable_pin',
                      'value': 'PF16', 'allow_comment_change': True}})
    assert r2 is None and 'SELF-GRANT' in c2


def test_allow_comment_change_fresh_session_still_works():
    """A NEW request (fresh EditSession) after the user confirmed is a
    new session — the flag works there (the lock is per-request, not a
    ban)."""
    ses = _stepper_session()
    content, details = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'patch_gcode', 'file': 'printer.cfg',
                      'section': 'stepper_x',
                      'old_text': '#enable_pin: !PE9',
                      'new_text': 'enable_pin: PF16',
                      'allow_comment_change': True}})
    assert details is not None
    assert 'STAGED' in content
