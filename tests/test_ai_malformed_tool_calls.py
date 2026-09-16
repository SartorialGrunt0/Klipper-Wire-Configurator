"""Tests for the malformed tool-call guard in api.ai_routes.

Small local models (qwen3.5-4B class) frequently malform the ```tool text
protocol: unescaped quotes inside argument values, single/smart-quoted
pseudo-JSON, python-style calls in the fence, or a truncated (unterminated)
fence. Before the guard, the loop saw "no tool calls, non-empty text",
terminated, and the raw broken markup leaked into the chat bubble.
"""
import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402
from api.printer_memory_routes import PrinterMemory  # noqa: E402
from tests.test_ai_chat_routes import DummyResponse, FakeAsyncClient  # noqa: E402

client = TestClient(app)


# ── extractor-level recovery ─────────────────────────────────────────


def test_extract_parses_same_line_closing_fence():
    # qwen3.5-4b constantly closes the fence on the SAME line as the JSON:
    # ```tool\n{"name": ...}``` — the newline-then-backticks requirement made
    # these calls undetectable AND un-strippable (live 2026-09-09 bank).
    text = '```tool\n{"name": "get_klippy_status", "arguments": {}}```'
    calls = ai_routes._extract_tool_calls(text)
    assert calls == [{"name": "get_klippy_status", "arguments": {}}]
    # And the fence must not leak into cleaned content.
    assert "```" not in ai_routes.MCP_TOOL_BLOCK_RE.sub("", text).strip()


def test_extract_recovers_python_call_inside_tool_fence():
    # name(k=v) inside an explicit ```tool fence is unambiguous tool
    # intent — recovered mechanically, no re-prompt needed.
    text = (
        'Checking:\n\n```tool\n'
        'call read_user_config(filename="printer.cfg", section="printer")\n'
        '```'
    )
    calls = ai_routes._extract_tool_calls(text)
    assert calls == [{
        'name': 'read_user_config',
        'arguments': {'filename': 'printer.cfg', 'section': 'printer'},
    }]


def test_extract_recovers_single_quoted_json_fence():
    text = "```tool\n{'name': 'list_user_configs', 'arguments': {}}\n```"
    calls = ai_routes._extract_tool_calls(text)
    assert calls == [{'name': 'list_user_configs', 'arguments': {}}]


def test_extract_recovers_smart_quoted_json_fence():
    text = (
        '```tool\n'
        '{\u201cname\u201d: \u201csearch_klipper_docs\u201d, '
        '\u201carguments\u201d: {\u201cquery\u201d: \u201cbed mesh\u201d}}\n'
        '```'
    )
    calls = ai_routes._extract_tool_calls(text)
    assert calls == [{'name': 'search_klipper_docs', 'arguments': {'query': 'bed mesh'}}]


def test_extract_recovers_raw_newlines_in_json_string():
    # gemma-4-12b repeatedly emits config_write with the macro body as
    # LITERAL newlines inside the JSON string (AMBI-02 r4 2026-09-15:
    # three nudge rounds emitted the same unparseable fence, then
    # truncated at 31k tokens). strict=False recovery keeps the write.
    # Note: unescaped double-quotes inside values are still NOT recovered
    # (ambiguous) — control characters only.
    body_fence = (
        '```tool\n{"name": "config_write", "arguments": {"file": '
        '"macros.cfg", "content": "[gcode_macro X]\ngcode:\n  G90\n"}}\n```'
    )
    calls = ai_routes._extract_tool_calls(body_fence)
    assert len(calls) == 1, calls
    assert calls[0]["name"] == "config_write"
    assert calls[0]["arguments"]["content"] == "[gcode_macro X]\ngcode:\n  G90\n"


def test_extract_recovers_unescaped_quotes_in_write_content():
    # Macro bodies are quote-heavy (SET_LED LED="x", Jinja comparisons) and
    # gemma-4-12b emits those quotes RAW inside the config_write JSON
    # string (AMBI-02 r6 2026-09-15: the same unparseable fence across 3
    # nudge rounds + 2 empty re-prompts, nothing staged). The lenient
    # scanner is gated to the write tools; short-value tools still route
    # to the re-prompt. Strings built from chr() to keep raw quote and
    # backslash shapes out of this source file.
    Q = chr(34)  # double-quote
    B = chr(92)  # backslash
    # Body as the model sends it: newlines escaped to \n, quotes raw.
    sent = (
        "[gcode_macro RESUME]" + B + "n"
        + "gcode:" + B + "n"
        + "  SET_LED LED=" + Q + "Chamber_LEDs" + Q + " RED=1" + B + "n"
        + "  {% if " + Q + "xyz" + Q + " not in printer.toolhead %}" + B + "n"
        + "  G28" + B + "n  {% endif %}" + B + "n"
    )
    fence = (
        "```tool" + chr(10)
        + "{" + Q + "name" + Q + ": " + Q + "config_write" + Q + ", "
        + Q + "arguments" + Q + ": {" + Q + "file" + Q + ": "
        + Q + "macros.cfg" + Q + ", " + Q + "content" + Q + ": " + Q
        + sent + Q + "}}" + chr(10) + "```"
    )
    calls = ai_routes._extract_tool_calls(fence)
    assert len(calls) == 1, calls
    expected = sent.replace(B + "n", chr(10))
    assert calls[0]["arguments"]["content"] == expected
    assert calls[0]["arguments"]["file"] == "macros.cfg"

    # The same corruption in a READ tool must NOT be guessed: extraction
    # yields nothing so the malformed guard routes it to the
    # format-correction re-prompt instead of executing corrupted args.
    read_fence = (
        "```tool" + chr(10)
        + "{" + Q + "name" + Q + ": " + Q + "read_user_config" + Q + ", "
        + Q + "arguments" + Q + ": {" + Q + "filename" + Q + ": "
        + Q + "printer.cfg" + Q + ", " + Q + "section" + Q + ": "
        + Q + "probe" + Q + " pin: PB4" + Q + "}}" + chr(10) + "```"
    )
    assert ai_routes._extract_tool_calls(read_fence) == []


def test_extract_completes_truncated_write_fence():
    # Model hits max_tokens mid-fence: the content string closes but the
    # outer object brace never arrives (captured live 2026-09-15, AMBI-02
    # r8: `...rear"}` at char 9257 of a 9257-char fence). The scanner
    # appends the missing closers so the write extracts; the delta
    # validator still gates the partial body.
    Q = chr(34)
    B = chr(92)
    fence = (
        "```tool" + chr(10)
        + "{" + Q + "name" + Q + ": " + Q + "config_write" + Q + ", "
        + Q + "arguments" + Q + ": {" + Q + "file" + Q + ": "
        + Q + "macros.cfg" + Q + ", " + Q + "content" + Q + ": "
        + Q + "[gcode_macro PARK]" + B + "n  G0 X175" + Q + "}"
        + chr(10) + "```"
    )
    calls = ai_routes._extract_tool_calls(fence)
    assert len(calls) == 1, calls
    assert calls[0]["name"] == "config_write"
    assert "G0 X175" in calls[0]["arguments"]["content"]

    # A structurally hopeless fence (string never even closes AND braces
    # imbalanced beyond the object depth) must still route to the
    # re-prompt path, not a half-parsed write.
    hopeless = (
        "```tool" + chr(10)
        + "{" + Q + "name" + Q + ": " + Q + "config_write" + Q + ", "
        + Q + "arguments" + Q + ": {" + Q + "content" + Q + ": " + Q
        + "truncated mid string never closes"
        + chr(10) + "```"
    )
    # string closes + closers appended -> parses with partial content;
    # assert extraction at least does not produce a corrupt call:
    res = ai_routes._extract_tool_calls(hopeless)
    assert len(res) <= 1
    if res:
        assert res[0]["name"] == "config_write"


# ── detection gate ───────────────────────────────────────────────────


def test_malformed_detection_fires_only_on_fence_intent():
    broken = (
        '```tool\n{"name": "read_user_config", "arguments": '
        '{"section": "probe" pin: PB4"}}\n```'
    )
    assert ai_routes._malformed_tool_call_detected(broken, [])
    unterminated = 'Let me look:\n\n```tool\n{"name": "search_klipper'
    assert ai_routes._malformed_tool_call_detected(unterminated, [])
    # Prose that merely mentions tools must never trigger the guard.
    assert not ai_routes._malformed_tool_call_detected(
        'You can call the BED_MESH_CALIBRATE macro after homing.', []
    )
    # A successfully parsed call also disables it.
    assert not ai_routes._malformed_tool_call_detected(
        broken, [{'name': 'x', 'arguments': {}}]
    )


# ── route-level guard behavior ───────────────────────────────────────


def test_chat_proxy_malformed_tool_call_gets_one_format_reprompt(monkeypatch):
    # Unescaped quotes inside an argument make json.loads fail; without the
    # guard the loop terminates and the raw ```tool markup leaks into the
    # chat bubble.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_execute_tool_call', lambda call: f"result for {call['name']}")
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) == 1:
            return DummyResponse(
                {'choices': [{'message': {'content': (
                    '```tool\n{"name": "read_user_config", "arguments": '
                    '{"filename": "printer.cfg", "section": "probe" pin: PB4"}}\n```'
                )}}]},
                url=url,
            )
        if len(calls) == 2:
            # After the format correction the model emits a valid call.
            return DummyResponse(
                {'choices': [{'message': {'content': (
                    '```tool\n{"name": "read_user_config", "arguments": '
                    '{"filename": "printer.cfg", "section": "probe"}}\n```'
                )}}]},
                url=url,
            )
        return DummyResponse(
            {'choices': [{'message': {'content': 'Your probe pin is PB4.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'what probe pin do I have?'}],
            'apiKey': 'openai-token',
            'model': 'qwen3.5-4b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['content'] == 'Your probe pin is PB4.'
    assert '```tool' not in body['content']
    # The second request must be the format-correction re-prompt, and it
    # must NOT quote the broken call (REPAIR-01: models copy broken drafts).
    second_messages = [str(m.get('content', '')) for m in calls[1]['messages']]
    assert any('could not be parsed' in m and 'Do not copy' in m for m in second_messages)
    assert not any('could not be parsed' in m and 'pin: PB4' in m for m in second_messages)


def test_chat_proxy_malformed_reprompt_is_bounded(monkeypatch):
    # A model that keeps emitting broken fences must not loop forever:
    # exactly ONE format correction, then the markup-stripped reply stands
    # (empty after stripping → the existing empty-response backstop takes
    # over, which never leaks markup either).
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        return DummyResponse(
            {'choices': [{'message': {'content': '```tool\n{"name": broken broken\n```'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'hi'}],
            'apiKey': 'openai-token',
            'model': 'qwen3.5-4b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    # Boundedness: 1 initial + exactly ONE format correction. After that the
    # guard is spent, the loop terminates, fence stripping leaves the reply
    # empty, and only the pre-existing empty-response backstop (limit 2)
    # runs. Total provider requests must therefore be 1 + 1 + 2 = 4.
    assert len(calls) == 4
    assert body['mcpToolTurns'] == 1
    assert body['repromptCount'] == 2
    assert '```tool' not in body.get('content', '')
    # The feedback phrase appears in the history exactly once (one feedback
    # message, merged-forward in later payloads — never duplicated).
    occurrences = sum(
        str(m.get('content', '')).count('could not be parsed')
        for m in calls[-1]['messages']
    )
    assert occurrences == 1


def test_unterminated_fence_never_reaches_the_bubble(monkeypatch):
    # A truncated stream (fence opened, never closed) must not leak markup
    # even if every recovery path fails.
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    calls = []

    def fake_post(url, headers, payload):
        calls.append(payload)
        if len(calls) == 1:
            return DummyResponse(
                {'choices': [{'message': {'content': 'Sure:\n\n```tool\n{"name": "search_klipper'}}]},
                url=url,
            )
        return DummyResponse(
            {'choices': [{'message': {'content': 'The docs say horizontal_move_z is the Z hop.'}}]},
            url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'horizontal_move_z?'}],
            'apiKey': 'openai-token',
            'model': 'qwen3.5-4b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert '```tool' not in body.get('content', '')


def test_unterminated_fence_preserves_answer_text_after_blank_line(monkeypatch):
    """Review finding #11: the strip regex consumed to end-of-content, so a
    model that opened a broken ```tool fence and then RECOVERED with real
    prose lost the answer. Fence bodies never contain blank lines, so the
    strip is bounded at the first blank line and trailing prose survives.
    Every provider turn stays malformed so the recovery-prose cleanup path
    (not the successful re-prompt path) produces the final bubble."""
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_auto_search_context', lambda query: None)

    broken = (
        'Sure:\n\n```tool\n{"name": "search_klipper\n\n'
        'The docs say horizontal_move_z is the Z hop between probed points.'
    )

    def fake_post(url, headers, payload):
        return DummyResponse(
            {'choices': [{'message': {'content': broken}}]}, url=url,
        )

    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **k: FakeAsyncClient(post_handler=fake_post))

    response = client.post(
        '/ai/chat',
        json={
            'messages': [{'role': 'user', 'content': 'horizontal_move_z?'}],
            'apiKey': 'openai-token',
            'model': 'qwen3.5-4b',
            'apiUrl': 'http://localhost:1234/v1/chat/completions',
            'apiProvider': 'chatgpt',
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert '```tool' not in body.get('content', '')
    # The recovery prose that followed the fence must NOT be silently eaten.
    assert 'Z hop between probed points' in body.get('content', '')
