"""Tests for the pythonic native-template tool-call format (llama.cpp).

When a served model's chat template has native tool tokens, llama.cpp can
render the model's TRAINED template into message content even though we
advertise the ```tool text protocol (fullbank ON 2026-09-14, AMBI-02):

    <|tool_call>call:config_write{content:<|"|>...multiline macro...<|"|>,
        file: 'macros.cfg'}<tool_call|>

The line-bounded extractors saw nothing (multi-line value) and the
line-bounded cleanup ate the first line, silently losing a real write.
`_extract_tool_calls` Format 0 recognizes the sentinel-quoted region and
`_strip_template_pythonic_calls` removes it from the visible reply.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402

# The literal template sentinel. Built from chr() so this source never
# embeds the raw quote-token (editors/patch tools corrupt that sequence).
_SENT = "<|" + chr(34) + "|>"

_MACRO_BODY = (
    "[gcode_macro RESET_ACCEL]\n"
    "gcode:\n"
    "  {% set MAX_ACCEL = printer.configfile.settings['printer'].max_accel|int %}\n"
    "  SET_VELOCITY_LIMIT ACCEL={MAX_ACCEL}\n"
)


def test_extract_pythonic_template_config_write_multiline():
    # Exact shape captured from live traffic (AMBI-02): multi-line
    # sentinel value + bare-comma trailing arg + terminator token.
    text = (
        "<|tool_call>call:config_write{content:" + _SENT + _MACRO_BODY
        + _SENT + ",file: 'macros.cfg'}<tool_call|>"
    )
    calls = ai_routes._extract_tool_calls(text)
    assert len(calls) == 1, calls
    assert calls[0]["name"] == "config_write"
    assert calls[0]["arguments"]["content"] == _MACRO_BODY
    assert calls[0]["arguments"]["file"] == "macros.cfg"


def test_extract_pythonic_template_canonical_multi_arg():
    # Canonical Hermes join shape: sentinel-delimited quoting re-opens
    # before each key: {file:<S>v<S>,<S>content:<S>v2<S>}.
    text = (
        "<|tool_call|>call:tool_call:config_write{file:" + _SENT
        + "macros.cfg" + _SENT + "," + _SENT + "content:" + _SENT
        + _MACRO_BODY + _SENT + "}"
    )
    calls = ai_routes._extract_template_pythonic_calls(text)
    assert len(calls) == 1
    assert calls[0]["arguments"]["file"] == "macros.cfg"
    assert calls[0]["arguments"]["content"] == _MACRO_BODY


def test_extract_pythonic_template_json_quoted_values():
    # llama.cpp also emits JSON-style quoted values inside the template.
    text = (
        '<|tool_call>call:config_write{"file": <|"|>macros.cfg<|"|>, '
        '"content": <|"|>' + _MACRO_BODY + _SENT + "}"
    )
    calls = ai_routes._extract_template_pythonic_calls(text)
    assert len(calls) == 1
    assert calls[0]["arguments"]["file"] == "macros.cfg"
    assert calls[0]["arguments"]["content"] == _MACRO_BODY


def test_pythonic_template_region_stripped_from_visible_text():
    # The old line-bounded cleanups ate only the FIRST line of the region
    # and leaked the rest of the macro body into the chat bubble.
    text = (
        "Sure!\n<|tool_call>call:config_write{content:" + _SENT + _MACRO_BODY
        + _SENT + ",file: 'm.cfg'}\nDone."
    )
    stripped = ai_routes._strip_template_pythonic_calls(text)
    assert "gcode_macro" not in stripped
    assert "<|" not in stripped
    assert "Sure!" in stripped and "Done." in stripped


def test_pythonic_template_needs_sentinel_and_known_name():
    # No sentinel => path fully inert (Klipper text with braces is safe).
    prose = "[gcode_macro FOO]\ngcode:\n  call:config_write{content: hi}\n"
    assert ai_routes._extract_template_pythonic_calls(prose) == []
    # Sentinel but unknown tool name => not extracted through the main
    # extractor (name-gated like the bracket-call format). The strip is
    # still sentinel+head gated, so unknown-name regions are consumed,
    # not executed — leaking template tokens is never useful output.
    unknown = "<|tool_call>call:not_a_tool{a:" + _SENT + "v" + _SENT + "}"
    assert ai_routes._extract_tool_calls(unknown) == []


def test_pythonic_template_no_duplicate_extraction():
    # Format 0 + Format 2 must not double-extract the same head: Format 2
    # is line-bounded and would otherwise emit a truncated twin call.
    text = (
        "<|tool_call>call:config_write{content:" + _SENT + _MACRO_BODY
        + _SENT + ",file: 'm.cfg'}"
    )
    calls = ai_routes._extract_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["arguments"]["content"] == _MACRO_BODY


def test_pythonic_template_gcode_key_inside_value_not_reread_as_arg():
    # 'gcode:' inside a sentinel-quoted macro body is DATA. A start-scanning
    # parser that treats every 'key:' as an argument corrupts the value.
    text = (
        "<|tool_call>call:config_write{content:" + _SENT + _MACRO_BODY
        + _SENT + "}"
    )
    calls = ai_routes._extract_template_pythonic_calls(text)
    assert len(calls) == 1
    assert calls[0]["arguments"] == {"content": _MACRO_BODY}


def test_nonsentinel_template_head_still_extracts_and_strips():
    # The non-sentineled variant (single-line values) was already
    # extractable via Formats 2/4 — regression-lock extraction AND the
    # new head/tail token strip (23k+ occurrences in live logs).
    text = (
        '<|tool_call>call:tool_call:get_config_reference_section'
        '{section_name: "bed_mesh"}<tool_call|>'
    )
    calls = ai_routes._extract_tool_calls(text)
    assert calls == [{"name": "get_config_reference_section",
                      "arguments": {"section_name": "bed_mesh"}}]
    assert ai_routes._strip_template_pythonic_calls(text).strip() == ""
