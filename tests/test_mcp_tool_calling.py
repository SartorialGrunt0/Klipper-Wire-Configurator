"""Tests for the native MCP tool-calling helpers in api.ai_routes.

These helpers were introduced when the LM Studio-specific MCP integration
was refactored into a native MCP server (mcp_server.py) with OpenAI/Anthropic
compatible tool-calling formats. The previous LM Studio helper tests were
stale and were replaced by this suite.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from api.ai_routes import (  # noqa: E402
    ALT_TOOL_CALL_CONTENT_RE,
    CALL_SYNTAX_CLEANUP_RE,
    DSML_CLEANUP_RE,
    DSML_INVOKE_RE,
    DSML_PARAM_RE,
    FUNC_CALL_CLEANUP_RE,
    MCP_TOOL_BLOCK_RE,
    XML_INVOKE_RE,
    XML_PARAM_RE,
    XML_TOOL_CALLS_CLEANUP_RE,
    _build_native_tool_followup,
    _build_native_tools,
    _build_tool_result_message,
    _collect_tool_names,
    _execute_tool_call,
    _extract_native_tool_calls,
    _extract_tool_calls,
    _parse_kwargs,
)


# ── _extract_tool_calls ─────────────────────────────────────────────────


def test_extract_tool_calls_fenced_json_block():
    text = (
        "Here is the lookup:\n"
        "```tool\n"
        '{"name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}}\n'
        "```\n"
    )
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}}]


def test_extract_tool_calls_native_token_json():
    text = 'Model output <|tool_call|>{"name": "read_klipper_doc", "arguments": {"doc": "Config_Reference.md"}}<|tool_call|>'
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "read_klipper_doc", "arguments": {"doc": "Config_Reference.md"}}]


def test_extract_tool_calls_native_token_call_syntax():
    text = '<|tool_call|> call search_klipper_docs{query="bed_mesh"}\n'
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}}]


def test_extract_tool_calls_llamacpp_tool_call_prefix():
    # llama.cpp native tool template (Qwen/Gemma style): the model emits
    # call:tool_call:NAME{...} inside <|tool_call|> tokens. Previously the
    # extra 'tool_call:' segment made the parser drop the call, so the
    # backend treated the response as tool-less, ran the auto-search
    # fallback, re-queried, got the same unparseable call, and finally
    # returned empty content ("No response." in the UI).
    text = (
        '<|tool_call>call:tool_call:get_config_reference_section'
        '{section_name: "bed_mesh"}<tool_call|>'
    )
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "get_config_reference_section",
        "arguments": {"section_name": "bed_mesh"},
    }]
    # The raw call text must also be fully cleanable from output using the
    # same cleanup chain the backend applies to final content.
    cleaned = MCP_TOOL_BLOCK_RE.sub("", text)
    cleaned = ALT_TOOL_CALL_CONTENT_RE.sub("", cleaned)
    cleaned = CALL_SYNTAX_CLEANUP_RE.sub("", cleaned)
    assert cleaned.strip() == ""


def test_extract_tool_calls_llamacpp_tool_call_prefix_with_space():
    text = ('<|tool_call|>call:tool_call: read_klipper_doc'
            '{doc: "Pressure_Advance.md"}<|tool_call|>')
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "read_klipper_doc",
        "arguments": {"doc": "Pressure_Advance.md"},
    }]


def test_extract_tool_calls_ignores_klipper_macro_jinja():
    # Regression (2026-08-02): the brace-style tool-call regex matched
    # "BED_MESH_CALIBRATE\n    {% endif %}" and "G28\n    {% else %}" as
    # tool calls — Klipper Jinja tags were misread as argument braces and
    # the final cleanup stripped the G-code line AND the Jinja tag out of
    # correct model replies ("the model keeps dropping G28 / {% endif %}").
    macro = (
        "[gcode_macro FIX_ME]\ndescription: test\n\ngcode:\n"
        "    {% if printer.bed_mesh %}\n"
        "        BED_MESH_CALIBRATE\n"
        "    {% endif %}\n"
        "    M140 S60\n"
        "    G28\n"
        "    {% else %}\n"
        "    {action_respond_info(\"homed\")}\n"
        "    M117 Heating to {bed_temp}C...\n"
    )
    assert _extract_tool_calls(macro) == []


def test_cleanup_chain_preserves_klipper_macro_content():
    # The full final-content cleanup chain must leave a correct Klipper
    # macro untouched — no stripped G-codes, Jinja tags, or action_respond_info.
    macro = (
        "```cfg\n[gcode_macro PREPARE_BED]\n"
        "gcode:\n"
        "    {% if printer.bed_mesh %}\n"
        "        BED_MESH_CALIBRATE\n"
        "    {% endif %}\n"
        "    M190 S60\n"
        "    G28\n"
        "    {% else %}\n"
        "        {action_respond_info(\"skipped\")}\n"
        "    {% endif %}\n"
        "    M117 Heating to {bed_temp}C...\n"
        "```\n"
    )
    cleaned = MCP_TOOL_BLOCK_RE.sub("", macro)
    cleaned = ALT_TOOL_CALL_CONTENT_RE.sub("", cleaned)
    cleaned = CALL_SYNTAX_CLEANUP_RE.sub("", cleaned)
    cleaned = FUNC_CALL_CLEANUP_RE.sub("", cleaned)
    cleaned = DSML_CLEANUP_RE.sub("", cleaned)
    cleaned = XML_TOOL_CALLS_CLEANUP_RE.sub("", cleaned)
    assert "BED_MESH_CALIBRATE" in cleaned
    assert "{% endif %}" in cleaned
    assert "G28" in cleaned
    assert "action_respond_info" in cleaned
    assert "{bed_temp}" in cleaned


def test_extract_tool_calls_llamacpp_call_tool_json_body():
    # llama.cpp/Gemma text protocol: the model emits call:tool{...} where
    # 'tool' is template decoration and the real name+arguments live in the
    # JSON body. Previously the parser kept name='tool', the hallucinated-tool
    # guard discarded the call, and the response came back empty ("No
    # response." in the UI) after burning both re-prompts.
    text = ('<|tool_call|>call:tool{"arguments":{"query":"adaptive mesh"},'
            '"name":"search_klipper_docs"}<tool_call|>')
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "search_klipper_docs",
        "arguments": {"query": "adaptive mesh"},
    }]


def test_extract_tool_calls_llamacpp_tool_use_prefix():
    # Gemma variant: call:tool_use_<NAME>{...} — the real name is embedded in
    # the decorated token, not the visible token itself.
    text = 'call:tool_use_search_klipper_docs{query: "adaptive mesh"}'
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "search_klipper_docs",
        "arguments": {"query": "adaptive mesh"},
    }]


def test_extract_tool_calls_bare_tool_json_line():
    # Unwrapped 'tool\n{json}' (no <|tool_call|> token) — Format 4 path.
    text = 'tool\n{"name": "read_user_config", "arguments": {"filename": "printer.cfg"}}\n'
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "read_user_config",
        "arguments": {"filename": "printer.cfg"},
    }]


def test_extract_tool_calls_call_tool_json_with_typed_args():
    # JSON body arguments must survive as typed values (limit stays an int).
    text = ('<|tool_call|>call:tool{"name": "search_user_configs", '
            '"arguments": {"query": "KAMP_Settings.cfg", "limit": 1}}<tool_call|>')
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "search_user_configs",
        "arguments": {"query": "KAMP_Settings.cfg", "limit": 1},
    }]


def test_extract_tool_calls_python_style():
    text = 'lookup(query="bed_mesh", limit=5)'
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "lookup", "arguments": {"query": "bed_mesh", "limit": "5"}}]


def test_extract_tool_calls_call_syntax_without_token():
    text = 'call lookup{query="bed_mesh"}\n'
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "lookup", "arguments": {"query": "bed_mesh"}}]


def test_extract_tool_calls_deduplicates_identical_blocks():
    block = '{"name": "lookup", "arguments": {"query": "x"}}'
    text = f"```tool\n{block}\n```\n```tool\n{block}\n```\n"
    calls = _extract_tool_calls(text)
    assert len(calls) == 1


def test_extract_tool_calls_ignores_invalid_json():
    text = "```tool\nthis is not json\n```\n"
    assert _extract_tool_calls(text) == []


def test_extract_tool_calls_no_calls_in_plain_text():
    assert _extract_tool_calls("Just a normal answer about [bed_mesh].") == []


def test_extract_tool_calls_dsml_deepseek_format():
    # DeepSeek V3.2/V4 native DSML markup as returned in message.content by
    # serving stacks that fail to parse it into structured tool_calls.
    text = (
        '<||DSML||tool_calls> <||DSML||invoke name="search_klipper_docs"> '
        '<||DSML||parameter name="limit" string="false">10</||DSML||parameter> '
        '<||DSML||parameter name="query" string="true">bed_mesh BED_MESH_CALIBRATE adaptive</||DSML||parameter> '
        '</||DSML||invoke> </||DSML||tool_calls>'
    )
    calls = _extract_tool_calls(text)
    assert calls == [{
        "name": "search_klipper_docs",
        "arguments": {"limit": "10", "query": "bed_mesh BED_MESH_CALIBRATE adaptive"},
    }]


def test_extract_tool_calls_dsml_multiple_invokes():
    text = (
        '<||DSML||tool_calls>'
        '<||DSML||invoke name="read_klipper_doc">'
        '<||DSML||parameter name="doc" string="true">Config_Reference.md</||DSML||parameter>'
        '</||DSML||invoke>'
        '<||DSML||invoke name="search_klipper_docs">'
        '<||DSML||parameter name="query" string="true">probe offset</||DSML||parameter>'
        '</||DSML||invoke>'
        '</||DSML||tool_calls>'
    )
    calls = _extract_tool_calls(text)
    assert calls == [
        {"name": "read_klipper_doc", "arguments": {"doc": "Config_Reference.md"}},
        {"name": "search_klipper_docs", "arguments": {"query": "probe offset"}},
    ]


def test_extract_tool_calls_dsml_no_params_keeps_call():
    # A tool call with zero parameters must still be executed (not dropped).
    text = '<||DSML||tool_calls><||DSML||invoke name="list_examples"></||DSML||invoke></||DSML||tool_calls>'
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "list_examples", "arguments": {}}]


def test_dsml_cleanup_re_strips_full_block():
    text = (
        'Sure! <||DSML||tool_calls>'
        '<||DSML||invoke name="search_klipper_docs">'
        '<||DSML||parameter name="query" string="true">bed_mesh</||DSML||parameter>'
        '</||DSML||invoke>'
        '</||DSML||tool_calls>'
    )
    stripped = DSML_CLEANUP_RE.sub("", text).strip()
    assert stripped == "Sure!"


def test_dsml_regexes_tolerate_single_pipe_delimiters():
    # Some encoders emit |DSML| (single pipe) instead of ||DSML||.
    text = (
        '<|DSML|tool_calls> <|DSML|invoke name="search_klipper_docs"> '
        '<|DSML|parameter name="query" string="true">bed_mesh</|DSML|parameter> '
        '</|DSML|invoke> </|DSML|tool_calls>'
    )
    invokes = DSML_INVOKE_RE.findall(text)
    assert invokes and invokes[0][0] == "search_klipper_docs"
    params = DSML_PARAM_RE.findall(invokes[0][1])
    assert params == [("query", "bed_mesh")]
    assert DSML_CLEANUP_RE.sub("", text).strip() == ""


def test_extract_tool_calls_xml_format():
    # DeepSeek flash models emit bare <tool_calls> XML as plain text when
    # re-prompted without the tools parameter (observed in accuracy runs).
    text = (
        '<tool_calls>\n'
        '<invoke name="search_example_configs">\n'
        '<parameter name="query" string="true">PC2 PB9 PC3</parameter>\n'
        '</invoke>\n'
        '<invoke name="read_example_config">\n'
        '<parameter name="filename" string="true">generic-fysetc-cheetah-v2.0.cfg</parameter>\n'
        '</invoke>\n'
        '</tool_calls>'
    )
    calls = _extract_tool_calls(text)
    assert calls == [
        {"name": "search_example_configs", "arguments": {"query": "PC2 PB9 PC3"}},
        {"name": "read_example_config", "arguments": {"filename": "generic-fysetc-cheetah-v2.0.cfg"}},
    ]


def test_extract_tool_calls_xml_string_attribute_ignored():
    text = (
        '<tool_calls><invoke name="search_klipper_docs">'
        '<parameter name="query" string="true">bed_mesh</parameter>'
        '<parameter name="limit" string="false">10</parameter>'
        '</invoke></tool_calls>'
    )
    calls = _extract_tool_calls(text)
    assert calls == [{"name": "search_klipper_docs", "arguments": {"query": "bed_mesh", "limit": "10"}}]


def test_xml_cleanup_re_strips_full_block():
    text = 'Sure! <tool_calls><invoke name="search_klipper_docs"><parameter name="query" string="true">bed_mesh</parameter></invoke></tool_calls>'
    stripped = XML_TOOL_CALLS_CLEANUP_RE.sub("", text).strip()
    assert stripped == "Sure!"


# ── _parse_kwargs ───────────────────────────────────────────────────────


def test_parse_kwargs_mixed_separators():
    assert _parse_kwargs('query="bed_mesh", limit=5, speed: 100') == {
        "query": "bed_mesh",
        "limit": "5",
        "speed": "100",
    }


def test_parse_kwargs_empty():
    assert _parse_kwargs("") == {}


# ── _execute_tool_call / _build_tool_result_message ─────────────────────


def test_execute_tool_call_unknown_tool_returns_error():
    result = _execute_tool_call({"name": "definitely_not_a_tool", "arguments": {}})
    assert result == "Error: Unknown tool: definitely_not_a_tool"


def test_build_tool_result_message():
    msg = _build_tool_result_message(
        {"name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}},
        "Found 3 results.",
    )
    assert "[Tool result: search_klipper_docs(query=bed_mesh)]" in msg
    assert "Found 3 results." in msg
    assert "[End tool result." in msg


# ── _collect_tool_names ─────────────────────────────────────────────────


def test_collect_tool_names_unique_in_order():
    messages = [
        {"role": "assistant", "content": "[Tool result: lookup(query=x)]\n\nresult\n\n[End tool result."},
        {"role": "assistant", "content": "[Tool result: read_klipper_doc(doc=y)]\n\nresult\n\n[End tool result."},
        {"role": "assistant", "content": "[Tool result: lookup(query=z)]\n\nresult\n\n[End tool result."},
    ]
    assert _collect_tool_names(messages) == ["lookup", "read_klipper_doc"]


def test_collect_tool_names_empty():
    assert _collect_tool_names([{"role": "user", "content": "hello"}]) == []


# ── _build_native_tools ─────────────────────────────────────────────────


def test_build_native_tools_returns_openai_function_schema():
    tools = _build_native_tools()
    assert isinstance(tools, list)
    assert len(tools) > 0
    assert all(t["type"] == "function" and "name" in t["function"] for t in tools)
    names = {t["function"]["name"] for t in tools}
    assert "search_klipper_docs" in names
    assert "validate_klipper_config" in names


# ── _extract_native_tool_calls ──────────────────────────────────────────


def test_extract_native_tool_calls_openai():
    data = {
        "choices": [{
            "message": {
                "tool_calls": [{
                    "type": "function",
                    "id": "call_1",
                    "function": {"name": "search_klipper_docs", "arguments": '{"query": "bed_mesh"}'},
                }]
            }
        }]
    }
    calls = _extract_native_tool_calls("openai", data)
    assert calls == [{
        "name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}, "id": "call_1",
        "extra_content": None,
    }]


def test_extract_native_tool_calls_anthropic():
    data = {
        "content": [
            {"type": "text", "text": "Looking it up..."},
            {"type": "tool_use", "name": "read_klipper_doc", "input": {"doc": "Config_Reference.md"}, "id": "toolu_1"},
        ]
    }
    calls = _extract_native_tool_calls("anthropic", data)
    assert calls == [{"name": "read_klipper_doc", "arguments": {"doc": "Config_Reference.md"}, "id": "toolu_1"}]


def test_extract_native_tool_calls_none():
    assert _extract_native_tool_calls("openai", {"choices": [{"message": {"content": "plain"}}]}) is None
    assert _extract_native_tool_calls("anthropic", {"content": [{"type": "text", "text": "plain"}]}) is None
    assert _extract_native_tool_calls("openai", {}) is None


def test_extract_native_tool_calls_invalid_arguments_json():
    data = {
        "choices": [{
            "message": {
                "tool_calls": [{
                    "type": "function",
                    "id": "call_2",
                    "function": {"name": "lookup", "arguments": "not-json"},
                }]
            }
        }]
    }
    calls = _extract_native_tool_calls("openai", data)
    assert calls == [{"name": "lookup", "arguments": {}, "id": "call_2", "extra_content": None}]


# ── _build_native_tool_followup ─────────────────────────────────────────


def test_build_native_tool_followup_openai():
    messages = _build_native_tool_followup(
        "openai",
        "Let me check.",
        [{"name": "search_klipper_docs", "arguments": {"query": "bed_mesh"}, "id": "call_1"}],
        ["Found 3 results."],
    )
    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"] == "Let me check."
    assert messages[0]["tool_calls"][0] == {
        "type": "function",
        "id": "call_1",
        "function": {"name": "search_klipper_docs", "arguments": '{"query": "bed_mesh"}'},
    }
    assert messages[1] == {"role": "tool", "tool_call_id": "call_1", "content": "Found 3 results."}


def test_build_native_tool_followup_anthropic():
    messages = _build_native_tool_followup(
        "anthropic",
        "Let me check.",
        [{"name": "read_klipper_doc", "arguments": {"doc": "Config_Reference.md"}, "id": "toolu_1"}],
        ["Full doc contents."],
    )
    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"][0] == {"type": "text", "text": "Let me check."}
    assert messages[0]["content"][1] == {
        "type": "tool_use",
        "id": "toolu_1",
        "name": "read_klipper_doc",
        "input": {"doc": "Config_Reference.md"},
    }
    assert messages[1]["role"] == "user"
    assert messages[1]["content"][0] == {
        "type": "tool_result",
        "tool_use_id": "toolu_1",
        "content": "Full doc contents.",
    }
