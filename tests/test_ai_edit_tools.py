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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use


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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use

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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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


def test_commented_param_edit_stages_end_to_end(monkeypatch):
    """2026-09-20: the commented-param guard was REMOVED. A set_param
    targeting a commented-only param now applies directly (uncommenting
    in place) and stages — the card/diff is the user's confirmation. The
    old flow refused and produced a prose ask with no tool call, which
    read to users as 'asked for permission but never fired the edit'."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
    calls = []
    scripted = [
        # write tool attempt on a commented param -> stages now
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "stepper_x", "key": "enable_pin", "value": "PF16"}}\n```',
        'I set enable_pin to PF16 on [stepper_x], which uncommented it.',
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

    cfg_with_commented = PRINTER_CFG.replace(
        '[stepper_x]\nstep_pin: PF13',
        '[stepper_x]\nstep_pin: PF13\n#enable_pin: !PE9', 1)
    response = client.post('/ai/chat', json=_chat_payload(
        [{'role': 'user', 'content': 'set enable_pin to PF16 on [stepper_x]'}],
        contextFiles={'printer.cfg': {'content': cfg_with_commented}}))
    assert response.status_code == 200
    body = response.json()
    assert body.get('pendingEdits'), f"edit did not stage: {body}"
    new_text = body['pendingEdits'][0]['newText']
    assert 'enable_pin: PF16' in new_text
    assert '#enable_pin' not in new_text


def test_giveup_after_correctable_kickback_gets_nudged(monkeypatch):
    """r4 9b EDIT-01 pattern: write tool refuses with a CORRECTABLE error
    (replace_section fed old_text; missing text), model explains and stops
    without retrying. Giving up on a fixable kickback must be nudged
    (unlike a user-gated commented-param refusal)."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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


def test_duplicate_after_commented_param_stage_is_kicked_back(monkeypatch):
    """2026-09-20: with the commented-param refusal gone, the first
    set_param on '#enable_pin' STAGES. The model's old second move —
    retrying the same target (with or without the removed
    allow_comment_change flag) — is caught by the DUPLICATE TARGET
    guard: the user must ask for a different value in a new message.
    Locks the one remaining user_gated write path in the loop."""
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
    calls = []
    scripted = [
        # 1: set_param on the commented param -> stages
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "stepper_x", "key": "enable_pin", '
        '"value": "!PF16"}}\n```',
        # 2: old r9 self-grant shape -> now a duplicate-target kickback
        '```tool\n{"name": "config_edit", "arguments": {"file": "printer.cfg", '
        '"op": "set_param", "section": "stepper_x", "key": "enable_pin", '
        '"value": "!PF16", "allow_comment_change": true}}\n```',
        'Set enable_pin to !PF16 on [stepper_x] (staged, uncommented).',
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
    assert body.get('pendingEdits'), f"first edit did not stage: {body}"
    new_text = body['pendingEdits'][0]['newText']
    assert 'enable_pin: !PF16' in new_text
    assert '#enable_pin' not in new_text
    # the duplicate retry must NOT have opened a second stage or nudged
    assert len(calls) == 3, f"unexpected round-trips: {len(calls)}"


# ── Confabulated-completion guard (TRIDENT-15) ──────────────────────

def test_confab_note_appended_when_writes_all_failed(monkeypatch):
    # Every config_edit got a correctable kickback (unknown section) and
    # the model still claimed the change was staged. The trace is ground
    # truth: the reply must carry the trace-truth note, and pendingEdits
    # stays null.
    monkeypatch.setenv('KWC_EDIT_TOOLS', '1')
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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
    monkeypatch.setenv('KWC_EDIT_SKILL_GATE', '0')  # gate default ON since Phase-5 A/B; these tests script direct write-tool use
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


# ── commented-param editing (guard REMOVED 2026-09-20) ────────────────


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


def test_set_param_on_commented_param_stages_directly():
    """2026-09-20: the commented-param refusal + self-grant lock were
    removed. set_param on a commented-only param uncomments it in place
    and STAGES immediately — the approval card's diff (red '#enable_pin'
    line, green 'enable_pin' line) is the user's confirmation. The old
    refusal produced prose-ask replies with no tool call, which users
    read as a broken edit flow."""
    ses = _stepper_session()
    content, details = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'set_param', 'file': 'printer.cfg',
                      'section': 'stepper_x', 'key': 'enable_pin',
                      'value': 'PF16'}})
    assert details is not None, content
    assert 'uncommented' in content
    assert ses.last_write_outcome == 'success'
    assert len(ses.pending_edits) == 1
    assert 'enable_pin: PF16' in ses.pending_edits[0]['newText']
    assert '#enable_pin' not in ses.pending_edits[0]['newText']


def test_patch_gcode_uncomment_stages_directly():
    """patch_gcode '#' flips stage too — same card-diff rationale."""
    ses = _stepper_session()
    content, details = ses.execute({
        'name': 'config_edit',
        'arguments': {'op': 'patch_gcode', 'file': 'printer.cfg',
                      'section': 'stepper_x',
                      'old_text': '#enable_pin: !PE9',
                      'new_text': 'enable_pin: !PE9'}})
    assert details is not None, content
    assert ses.last_write_outcome == 'success'
    assert 'enable_pin: !PE9\n' in ses.pending_edits[0]['newText']


def test_commented_param_prepares_card_after_prior_edit():
    """Approval path (prepare): a commented-param edit opens a card
    exactly like any other write — no refusal, no self-grant lock."""
    ses = _stepper_session()
    c1, r1, _ = ses.prepare({
        'name': 'config_edit',
        'arguments': {'op': 'patch_gcode', 'file': 'printer.cfg',
                      'section': 'stepper_x',
                      'old_text': '#enable_pin: !PE9',
                      'new_text': 'enable_pin: PF16'}})
    assert r1 is not None, c1
    assert r1['diff']['before'].count('#enable_pin') == 1


# ── printer-memory skill + new fields (buildVolume/extruderType) ──────


def test_memory_skill_body_playbook():
    body = ai_routes._memory_skill_body()
    assert 'buildVolume' in body and 'position_max' in body
    assert "'direct' or 'bowden'" in body
    assert 'printer-memory' in body
    # must NOT unlock or mention edit tools
    assert 'config_edit' not in body


def test_skill_index_advertises_both_skills():
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True,
                                            skill_gate=True)
    assert '- config-editing:' in ctx
    assert '- printer-memory:' in ctx


def test_load_skill_active_is_name_anchored():
    """A printer-memory skill load must NOT count as the edit skill
    being active — the gate is per-skill, not per-loader-call."""
    from api.ai_routes import _load_skill_active
    mem_msg = ('[Tool result: load_skill(name=printer-memory)]\n\n'
               'Skill \'printer-memory\' loaded.\n\n[End tool result. '
               'Use this information to answer the user\'s latest '
               '(last) request above.]')
    assert not _load_skill_active(
        [{'role': 'user', 'content': 'hi'},
         {'role': 'assistant', 'content': mem_msg}])
    # the edit-skill marker still activates
    assert _load_skill_active(
        [{'role': 'user', 'content': 'hi'},
         {'role': 'assistant', 'content': _SKILL_RESULT_MSG}])
    # native echo with name=printer-memory must not activate either
    assert not _load_skill_active([{
        'role': 'assistant', 'content': '',
        'tool_calls': [{'function': {
            'name': 'load_skill',
            'arguments': '{"name": "printer-memory"}'}}],
    }])
    assert _load_skill_active([{
        'role': 'assistant', 'content': '',
        'tool_calls': [{'function': {
            'name': 'load_skill',
            'arguments': '{"name": "config-editing"}'}}],
    }])


def test_native_memory_load_still_locks_write_tools():
    """End-to-end shape: after a printer-memory load in history, the
    edit tools stay gated; a config-edit call gets the load-first
    kickback. (Verified at the predicate level above; here the context
    built from a memory-only history still advertises the skill index.)"""
    ctx = ai_routes._build_mcp_tool_context(edit_capable=True,
                                            skill_gate=True,
                                            skill_active=False)
    assert '- config_edit:' not in ctx
    assert '<available_skills>' in ctx


def test_printer_memory_new_fields_in_model_and_context():
    from api.printer_memory_routes import (PrinterMemory,
                                           printer_memory_to_context)
    m = PrinterMemory(kinematics='CoreXY', buildVolume='250x250x210',
                      extruderType='direct')
    ctx = printer_memory_to_context(m)
    assert 'Build Volume' in ctx and '250x250x210' in ctx
    assert 'Extruder Type' in ctx
    # blank memory carries the 9-field law + closed-set note
    blank = printer_memory_to_context(PrinterMemory())
    assert 'Only these 9 fields' in blank
    assert "ONLY 'direct' or 'bowden'" in blank
    assert 'buildVolume, extruderType' in blank


def test_extruder_type_closed_set():
    from api.printer_memory_routes import PrinterMemory
    import pydantic
    assert PrinterMemory(extruderType='direct').extruderType == 'direct'
    # accepted spellings canonicalize
    assert PrinterMemory(extruderType='Direct Drive').extruderType == 'direct'
    assert PrinterMemory(extruderType=' bowden ').extruderType == 'bowden'
    # everything else rejected at the API edge
    try:
        PrinterMemory(extruderType='direct drive mk2')
        raise AssertionError('closed set not enforced')
    except pydantic.ValidationError:
        pass


def test_blank_autofill_prompt_lists_9_fields(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory())
    msgs = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True, skill_gate=True)
    sys_text = '\n'.join(str(m.get('content', ''))
                         for m in msgs if m.get('role') == 'system')
    assert 'Printer Memory Auto-Fill' in sys_text
    assert 'Only these 9 fields' in sys_text
    assert 'buildVolume, extruderType' in sys_text
    # gate ON -> pointer into the skill playbook
    assert "load_skill(name='printer-memory')" in sys_text


# ── mechanical machine-fact derivation (Macro Designer parity) ────────


def test_derive_machine_facts_cartesian_and_delta():
    from api.printer_memory_routes import derive_machine_facts
    corexy = (
        '[printer]\nkinematics: corexy\nmax_velocity: 500\n'
        '[stepper_x]\nposition_max: 250\n'
        '[stepper_y]\nposition_max: 250\nposition_min: -5\n'
        '[stepper_z]\nposition_max: 210\n')
    assert derive_machine_facts([corexy]) == {
        'kinematics': 'corexy', 'buildVolume': '250x255x210'}
    delta = ('[printer]\nkinematics: delta\nprint_radius: 130\n'
             '[stepper_a]\nposition_max: 420\n')
    assert derive_machine_facts([delta]) == {
        'kinematics': 'delta', 'buildVolume': 'round Ø260'}


def test_derive_machine_facts_conservative():
    from api.printer_memory_routes import derive_machine_facts
    # no stepper data -> kinematics only, no invented volume
    assert derive_machine_facts(
        ['[printer]\nkinematics: corexy\n']) == {'kinematics': 'corexy'}
    # partial steppers -> no volume
    partial = ('[printer]\nkinematics: cartesian\n'
               '[stepper_x]\nposition_max: 220\n'
               '[stepper_y]\nposition_max: 220\n')
    assert derive_machine_facts([partial]) == {'kinematics': 'cartesian'}
    assert derive_machine_facts([]) == {}
    assert derive_machine_facts(['']) == {}
    # commented params don't count
    commented = ('[printer]\n#kinematics: corexy\n'
                 '[stepper_x]\n#position_max: 250\n')
    assert derive_machine_facts([commented]) == {}


def test_autofill_prompt_injects_derived_facts(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory())
    ctx = {'printer.cfg': {'content': (
        '[printer]\nkinematics: corexy\n'
        '[stepper_x]\nposition_max: 250\n'
        '[stepper_y]\nposition_max: 250\n'
        '[stepper_z]\nposition_max: 210\n'), 'label': 'printer.cfg'}}
    msgs = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True, skill_gate=True, context_files=ctx)
    sys_text = '\n'.join(str(m.get('content', ''))
                         for m in msgs if m.get('role') == 'system')
    assert 'DERIVED MACHINE FACTS' in sys_text
    assert 'kinematics=corexy' in sys_text
    assert 'buildVolume=250x250x210' in sys_text
    # no contextFiles -> no facts section (model derives via tools)
    msgs2 = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True, skill_gate=True)
    sys2 = '\n'.join(str(m.get('content', ''))
                     for m in msgs2 if m.get('role') == 'system')
    assert 'DERIVED MACHINE FACTS' not in sys2


def test_memory_skill_body_documents_mechanical_derivation():
    body = ai_routes._memory_skill_body()
    assert 'MECHANICALLY DERIVABLE' in body
    assert 'position_max' in body
    assert 'print_radius' in body
    # the old wrong claim must stay gone
    assert 'max_x:' not in body


def test_derive_machine_facts_mainboard_chip():
    from api.printer_memory_routes import derive_machine_facts
    serial = ('[mcu]\nserial: /dev/serial/by-id/usb-Klipper_'
              'stm32f446xx_3D002B000E50505734393820-if00\n'
              '[printer]\nkinematics: corexy\n')
    facts = derive_machine_facts([serial])
    assert facts['mainboard'] == 'STM32F446 board (model unconfirmed)'
    # canbus uuid reveals no chip -> no mainboard claim
    can = ('[mcu]\ncanbus_uuid: aabbccddee\n'
           '[printer]\nkinematics: corexy\n')
    assert 'mainboard' not in derive_machine_facts([can])


# ── derived hardware inventory (graph-parity board roster) ────────────


_TRIDENT_MAIN = (
    '[mcu]\n'
    'serial: /dev/serial/by-id/usb-Klipper_stm32f446xx_'
    '3D002B000E50505734393820-if00\n'
    '[printer]\nkinematics: corexy\n'
    '[probe]\npin: PIS:PB2\n')
_TRIDENT_EBB = (
    '[mcu EBBCan]\ncanbus_uuid: 42152a9d2f1e\n'
    '[adxl345]\ncs_pin: EBBCan:PB12\nspi_bus: spi1\n'
    '[resonance_tester]\naccel_chip: adxl345\n')
_TRIDENT_EXP = (
    '[mcu PIS]\ncanbus_uuid: 421c0f9d1a22\n'
    '[mcu hotkey]\ncanbus_uuid: 442d2b1c9e0f\n')


def test_derive_hardware_inventory_trident_roster():
    from api.printer_memory_routes import (derive_hardware_inventory,
                                           format_hardware_inventory)
    inv = derive_hardware_inventory(
        [_TRIDENT_MAIN, _TRIDENT_EBB, _TRIDENT_EXP])
    boards = inv['boards']
    assert boards['mainboard'][0]['chip'] == 'STM32F446'
    assert [b['name'] for b in boards['toolhead']] == ['EBBCan']
    assert [b['name'] for b in boards['expander']] == ['PIS', 'hotkey']
    assert inv['probes'] == [{'kind': 'generic [probe]', 'mcu': 'PIS'}]
    assert inv['accelerometers'] == [
        {'kind': 'adxl345', 'mcu': 'EBBCan'}]
    line = format_hardware_inventory(inv)
    assert 'toolhead board(s): EBBCan' in line
    assert 'expander board(s): PIS, hotkey' in line
    assert 'adxl345 on EBBCan' in line
    assert 'resonance_tester' in line


def test_derive_hardware_inventory_sbc_and_empty():
    from api.printer_memory_routes import derive_hardware_inventory
    inv = derive_hardware_inventory(
        ['[mcu host]\nserial: /tmp/klipper_host_mcu\n'
         '[mcu]\nserial: /dev/tty0\n'])
    assert [b['name'] for b in inv['boards']['sbc']] == ['host']
    assert derive_hardware_inventory(['']) == {}
    assert derive_hardware_inventory(['[extruder]\nheaters: 1\n']) == {}


def test_autofill_prompt_injects_board_roster(monkeypatch):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory())
    ctx = {
        'printer.cfg': {'content': _TRIDENT_MAIN, 'label': 'printer.cfg'},
        'ebb.cfg': {'content': _TRIDENT_EBB, 'label': 'ebb.cfg'},
        'exp.cfg': {'content': _TRIDENT_EXP, 'label': 'exp.cfg'},
    }
    msgs = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}],
        edit_capable=True, skill_gate=True, context_files=ctx)
    sys_text = '\n'.join(str(m.get('content', ''))
                         for m in msgs if m.get('role') == 'system')
    assert 'DERIVED HARDWARE INVENTORY' in sys_text
    assert 'EBBCan' in sys_text and 'PIS' in sys_text
    assert 'toolhead board(s)' in sys_text


# ── list_hardware: class-first discovery (chat layer) ─────────────────


_HW_LEDS = (
    '[neopixel caselight]\npin: PIS:GP17\n'
    '[output_pin led_strips]\npin: PB5\npwm: True\n'
    '[dotstar status_strip]\ndata_pin: PA1\n'
    '#[neopixel removed_led]\n#pin: PB6\n')
_HW_MAIN = (
    '[mcu]\nserial: /dev/serial/by-id/usb-Klipper_stm32f446xx_'
    'AABBCC-if00\n'
    '[printer]\nkinematics: corexy\n'
    '[stepper_x]\nstep_pin: PA0\n'
    '[tmc2240 stepper_x]\ncs_pin: PG4\n'
    '[idle_timeout]\ntimeout: 600\n')


def test_list_hardware_led_class_is_structural():
    from services.hardware_lookup import list_hardware
    out = list_hardware({'printer.cfg': _HW_MAIN, 'leds.cfg': _HW_LEDS},
                        'led')
    # every LED-family type + the name-token output_pin hit
    for header in ('neopixel caselight', 'output_pin led_strips',
                   'dotstar status_strip'):
        assert f"[{header}]" in out
    # suppressed header never renders AS a section (it may survive as a
    # verbatim comment line inside the previous section's body — patch
    # old_text needs bodies verbatim)
    assert '## [neopixel removed_led]' not in out
    assert '3 matches' in out
    # file+line location present for edits
    assert 'leds.cfg (line 1)' in out
    # completeness law rides the result
    assert 'EVERY match above' in out


def test_list_hardware_stepper_suffix_and_literal_type():
    from services.hardware_lookup import list_hardware
    files = {'printer.cfg': _HW_MAIN}
    steppers = list_hardware(files, 'stepper')
    assert '[stepper_x]' in steppers
    # driver prefixed onto the class matches via the name suffix
    assert '[tmc2240 stepper_x]' in steppers
    literal = list_hardware(files, 'idle_timeout')
    assert '[idle_timeout]' in literal
    assert 'timeout: 600' in literal


def test_list_hardware_unknown_type_and_summary():
    from services.hardware_lookup import list_hardware
    files = {'printer.cfg': _HW_MAIN}
    bad = list_hardware(files, 'flux_capacitor')
    assert 'No hardware class' in bad and 'led' in bad
    summary = list_hardware(files, '')
    assert 'mcu (' in summary and 'stepper (' in summary
    assert 'gcode (' in summary  # idle_timeout is gcode group


def test_list_hardware_working_state_not_disk():
    # dispatch reads the EditSession's live files: an approved-unsaved
    # edit must be visible to the next list_hardware call
    from api import ai_routes as ar
    import asyncio
    es = ar.EditSession({'printer.cfg': {'content': _HW_LEDS}})
    result_text, details = es.execute({
        'name': 'config_write',
        'arguments': {'file': 'extra.cfg',
                      'content': '[neopixel new_bar]\npin: PC5\n'}})
    assert details is not None
    out = __import__('services.hardware_lookup',
                     fromlist=['list_hardware']
                     ).list_hardware(es.state.files, 'led')
    assert 'new_bar' in out and 'extra.cfg' in out


def test_list_hardware_advertised_on_both_protocols():
    native = ai_routes._build_native_tools(edit_capable=False)
    names = {t['function']['name'] for t in native}
    assert 'list_hardware' in names
    # text protocol parity: the same tool appears in the prompt surface
    text_ctx = ai_routes._build_mcp_tool_context(native_mode=False)
    assert 'list_hardware' in text_ctx
    native_ctx = ai_routes._build_mcp_tool_context(native_mode=True)
    assert 'list_hardware' in native_ctx


def test_extract_text_call_recognises_list_hardware():
    calls = ai_routes._extract_tool_calls(
        '```tool\n{"name": "list_hardware", "arguments": '
        '{"type": "led"}}\n```')
    assert calls and calls[0]['name'] == 'list_hardware'


# ── identical-failure repetition guard (TRIDENT-15 r1 loop) ───────────


def _repetition_session():
    from services.ai_edit_tools import EditSession
    cfg = ('[idle_timeout]\ntimeout: 1800\n'
           '[printer]\nkinematics: corexy\nmax_accel: 4000\n')
    return EditSession({'printer.cfg': {'content': cfg}})


def test_identical_failure_escalates_then_blocks():
    es = _repetition_session()
    # 'section' present but key missing => correctable failure, twice
    bad = {'name': 'config_edit',
           'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                         'section': 'idle_timeout'}}
    c1, d1 = es.execute(bad)
    assert d1 is None and 'SECOND' not in c1
    c2, d2 = es.execute(bad)
    assert d2 is None and 'SECOND IDENTICAL' in c2
    c3, d3 = es.execute(bad)
    assert d3 is None and 'failed 3 times' in c3
    # 4th: hard-stopped BEFORE touching state
    c4, d4 = es.execute(bad)
    assert d4 is None and 'BLOCKED' in c4
    assert es.pending_edits == []


def test_changed_call_clears_repeat_pressure():
    es = _repetition_session()
    bad = {'name': 'config_edit',
           'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                         'section': 'idle_timeout'}}
    es.execute(bad)
    es.execute(bad)
    good = {'name': 'config_edit',
            'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                          'section': 'idle_timeout',
                          'key': 'timeout', 'value': '300'}}
    content, details = es.execute(good)
    assert details is not None
    # the corrected call succeeding means a later IDENTICAL failure of
    # the OLD call is not treated as a fresh 2nd strike loop
    assert 'BLOCKED' not in content


def test_repetition_guard_applies_to_approval_path():
    es = _repetition_session()
    bad = {'name': 'config_edit',
           'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                         'section': 'nonexistent_zzz'}}
    p1 = es.prepare(bad)
    p2 = es.prepare(bad)
    assert p1[1] is None and 'SECOND IDENTICAL' not in p1[0]
    assert p2[1] is None and 'SECOND IDENTICAL' in p2[0]
    p3 = es.prepare(bad)
    assert p3[1] is None
    p4 = es.prepare(bad)
    assert p4[1] is None and 'BLOCKED' in p4[0]


# ── field-synonym normalization (r3 TRIDENT-15: new_text for value) ───


def test_set_param_new_text_synonym_stages():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 1800\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'set_param',
                      'section': 'idle_timeout', 'key': 'timeout',
                      'new_text': '300'}})
    assert details is not None, content
    assert '300' in es.state.files['printer.cfg']


def test_replace_section_new_text_synonym_stages():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 1800\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'replace_section',
                      'section': 'idle_timeout',
                      'new_text': 'timeout: 300\ngcode:\n  M106'}})
    assert details is not None, content
    assert 'M106' in es.state.files['printer.cfg']


def test_explicit_value_beats_new_text_synonym():
    op = __import__('services.ai_edit_tools',
                    fromlist=['EditSession']).EditSession.tool_call_to_op(
        'config_edit', {'file': 'p.cfg', 'op': 'set_param',
                        'section': 's', 'key': 'k',
                        'value': 'good', 'new_text': 'bad'})
    assert op['value'] == 'good'
    # patch_gcode keeps new_text as new_text (no aliasing)
    op2 = __import__('services.ai_edit_tools',
                     fromlist=['EditSession']).EditSession.tool_call_to_op(
        'config_edit', {'file': 'p.cfg', 'op': 'patch_gcode',
                        'section': 's', 'old_text': 'a',
                        'new_text': 'b'})
    assert op2['new_text'] == 'b' and 'value' not in op2


# ── replace_section dropped-parameter warning (tnf-s1 r2) ─────────────


def test_replace_section_warns_on_dropped_param():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 300\ngcode:\n  M18\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'replace_section',
                      'section': 'idle_timeout',
                      'text': 'gcode:\n  M106'}})
    # applied as told, but the summary names the vanished key
    assert details is not None
    assert 'WARNING' in content and 'timeout' in content
    body = es.state.files['printer.cfg']
    assert '\ntimeout:' not in body  # param gone; header name irrelevant


def test_replace_section_no_warning_when_body_complete():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 300\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'replace_section',
                      'section': 'idle_timeout',
                      'text': 'timeout: 300\ngcode:\n  M106'}})
    assert details is not None
    assert 'WARNING' not in content


def test_replace_section_indented_lines_are_not_keys():
    from services.ai_edit_tools import ProjectState
    st = ProjectState({'printer.cfg': (
        '[gcode_macro X]\ngcode:\n  M104\n  M140\ndescription: d\n')})
    _, res = st.apply_no_gate({
        'op': 'replace_section', 'file': 'printer.cfg',
        'section': 'gcode_macro X',
        'text': 'gcode:\n  M106\n  M107\ndescription: d'})
    assert res['status'] == 'ok'
    assert 'WARNING' not in res['summary']


# ── patch_gcode anchor-drop warning (Sir's approval-gate diff report) ──


def test_patch_gcode_warns_when_anchor_param_dropped():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 1800\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'patch_gcode',
                      'section': 'idle_timeout',
                      'old_text': 'timeout: 1800',
                      'new_text': 'gcode:\n  M106'}})
    assert details is not None  # applied as told
    assert 'WARNING' in content and 'timeout' in content


def test_patch_gcode_anchor_kept_no_warning():
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content':
        '[idle_timeout]\ntimeout: 1800\n'}})
    content, details = es.execute({
        'name': 'config_edit',
        'arguments': {'file': 'printer.cfg', 'op': 'patch_gcode',
                      'section': 'idle_timeout',
                      'old_text': 'timeout: 1800',
                      'new_text': 'timeout: 300\ngcode:\n  M106'}})
    assert details is not None
    assert 'WARNING' not in content
    assert 'timeout: 300' in es.state.files['printer.cfg']


def test_patch_gcode_indent_tolerant_path_warns_too():
    from services.ai_edit_tools import ProjectState
    st = ProjectState({'printer.cfg': (
        '[idle_timeout]\n    timeout: 1800\n')})
    _, res = st.apply_no_gate({
        'op': 'patch_gcode', 'file': 'printer.cfg',
        'section': 'idle_timeout',
        'old_text': 'timeout: 1800',
        'new_text': 'gcode:\n  STOP_ALL'})
    assert res['status'] == 'ok'
    assert 'WARNING' in res['summary']


def test_patch_gcode_intentional_deletion_warns_once_only():
    # Deleting a param IS legal — the warning is informational,
    # not an error; status stays ok.
    from services.ai_edit_tools import ProjectState
    st = ProjectState({'printer.cfg': (
        '[idle_timeout]\ntimeout: 1800\nslow_to_down: true\n')})
    _, res = st.apply_no_gate({
        'op': 'patch_gcode', 'file': 'printer.cfg',
        'section': 'idle_timeout',
        'old_text': 'slow_to_down: true', 'new_text': ''})
    assert res['status'] == 'ok'
    assert 'slow_to_down' in res['summary']


# ── unknown-gcode one-shot kickback (Sir 2026-09-20) ──────────────────
# A hallucinated command (SET_LED_COLOR) is invalid at runtime; the
# model must get ONE correction round before any card/stage. The second
# identical send is its honest plugin claim and passes, advisory riding
# the card. NEVER a second kick (loop risk).


def _led_cfg():
    return {'printer.cfg': {'content': (
        '[output_pin led_strip]\npin: PB0\n\n'
        '[gcode_macro PARK]\ngcode:\n    G91\n')}}


def _set_color_call(cmd='SET_LED_COLOR'):
    return {'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'patch_gcode',
        'section': 'gcode_macro PARK',
        'old_text': '    G91',
        'new_text': f'    G91\n    {cmd} LED=led_strip RED=1 GREEN=0 BLUE=0'}}


def test_unknown_gcode_kicked_back_once_not_staged():
    from services.ai_edit_tools import EditSession
    es = EditSession(_led_cfg())
    content, details = es.execute(_set_color_call())
    assert details is None                      # NOT staged
    assert 'NOT STAGED' in content
    assert 'SET_LED_COLOR' in content
    assert 'SET_LED' in content                 # did-you-mean carried
    assert 'SET_LED_COLOR' not in es.state.files['printer.cfg']
    assert es.pending_edits == []
    assert es.last_write_outcome == 'correctable'


def test_identical_resend_passes_as_plugin_claim():
    from services.ai_edit_tools import EditSession
    es = EditSession(_led_cfg())
    call = _set_color_call()
    first, details = es.execute(call)
    assert details is None
    content, details = es.execute(call)
    # Second send = deliberate plugin claim: stages, advisory rides along.
    assert details is not None
    assert 'applied' in content
    assert any(a['code'] == 'unknown_gcode_command'
               for a in details['advisories'])
    assert 'SET_LED_COLOR' in es.state.files['printer.cfg']


def test_corrected_command_needs_no_second_round():
    from services.ai_edit_tools import EditSession
    es = EditSession(_led_cfg())
    _, details = es.execute(_set_color_call())
    assert details is None
    content, details = es.execute(_set_color_call(cmd='SET_PIN'))
    assert details is not None
    assert 'SET_LED_COLOR' not in es.state.files['printer.cfg']
    assert 'SET_PIN' in es.state.files['printer.cfg']


def test_prepare_unknown_gcode_no_card_first_round():
    """Gate path: prepare() must return the kickback (result None) so
    _run_approval_gate never opens a card without the correction round."""
    from services.ai_edit_tools import EditSession
    es = EditSession(_led_cfg())
    call = _set_color_call()
    content, result, preview = es.prepare(call)
    assert result is None and preview is None
    assert 'NOT STAGED' in content
    content, result, preview = es.prepare(call)
    assert result is not None                   # resend: card may open
    assert any(a['code'] == 'unknown_gcode_command'
               for a in result['advisories'])


def test_preexisting_unknown_command_still_silent():
    """Baseline cancellation: an unknown command already in the user's
    config must not earn a kickback on an unrelated edit."""
    from services.ai_edit_tools import EditSession
    es = EditSession({'printer.cfg': {'content': (
        '[idle_timeout]\ntimeout: 300\ngcode:\n    SET_LED_COLOR LED=x RED=1\n'
    )}})
    content, details = es.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'set_param',
        'section': 'idle_timeout', 'key': 'timeout', 'value': '600'}})
    assert details is not None   # no NEW unknown -> no kick
    assert 'NOT STAGED' not in content
