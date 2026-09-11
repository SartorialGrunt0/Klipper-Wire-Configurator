"""Tests for backend/services/gcode_registry.py (loader, verdicts, resolver)."""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.parser.config_parser import ConfigFile, ConfigSection, ConfigParam
from backend.services.gcode_registry import (
    STATUS_CONDITIONAL_OUT,
    STATUS_UNKNOWN,
    STATUS_VALID,
    ProjectGcodeContext,
    available_commands,
    build_project_context,
    classify_command,
    iter_gcode_command_tokens,
    load_registry,
    normalize_name,
    scan_gcode_body,
)

REPO = Path(__file__).resolve().parent.parent
TRIDENT = REPO / "reference" / "Trident_backup" / "printer_data" / "config"


def _ctx(section_types=(), macros=()):
    return ProjectGcodeContext(
        section_types=frozenset(section_types), user_macros=frozenset(macros))


# ── normalize ───────────────────────────────────────────────────────────


def test_normalize():
    assert normalize_name("  set_led ") == "SET_LED"
    assert normalize_name("G1 X10") == "G1"
    assert normalize_name("") == ""


# ── classify, registry-only ─────────────────────────────────────────────


def test_registry_only_valid_names():
    for name in ["SET_LED", "G1", "TEST_RESONANCES", "HELP", "M104"]:
        assert classify_command(name).status == STATUS_VALID


def test_registry_only_unknown_gets_suggestions():
    v = classify_command("SET_NEOPIXEL_COLOR")
    assert v.status == STATUS_UNKNOWN
    assert "SET_LED" in v.suggestions or "SET_PIN" in v.suggestions


def test_registry_only_no_context_skips_gates():
    # Without a project context, gated commands are still name-valid.
    assert classify_command("SET_LED").status == STATUS_VALID


# ── classify, with project gates ────────────────────────────────────────


def test_conditional_out_when_gate_absent():
    v = classify_command("SET_LED", _ctx(section_types=["extruder"]))
    assert v.status == STATUS_CONDITIONAL_OUT
    assert "neopixel" in v.required_sections


def test_valid_when_gate_present():
    v = classify_command("SET_LED", _ctx(section_types=["neopixel"]))
    assert v.status == STATUS_VALID


def test_user_macro_valid_and_unknown_suggested_from_macros():
    ctx = _ctx(macros=["PRINT_START", "RESET_ACCEL"])
    assert classify_command("PRINT_START", ctx).status == STATUS_VALID
    assert classify_command("PRINT_START", ctx).source == "user_macro"
    v = classify_command("PRINT_STAR", ctx)
    assert v.status == STATUS_UNKNOWN
    assert "PRINT_START" in v.suggestions


def test_always_ok_never_flagged():
    assert classify_command("M115", _ctx()).status == STATUS_VALID
    assert classify_command("HELP", _ctx()).status == STATUS_VALID


def test_unknown_suggestions_capped():
    v = classify_command("XYZZY_PLUGH")
    assert len(v.suggestions) <= 3


# ── project context builder ─────────────────────────────────────────────


def _mk_config(filename, sections):
    return ConfigFile(filename=filename, sections=sections)


def _macro(name, rename=""):
    params = [ConfigParam(key="gcode", value="M114")]
    if rename:
        params.append(ConfigParam(key="rename_existing", value=rename))
    return ConfigSection(section_type="gcode_macro", section_name=name,
                         full_header=f"gcode_macro {name}", params=params)


def test_build_context_sections_and_macros():
    cfg = _mk_config("printer.cfg", [
        ConfigSection(section_type="neopixel", section_name="base",
                      full_header="neopixel base"),
        _macro("PRINT_START"),
        ConfigSection(section_type="include", section_name="",
                      full_header="include extras.cfg"),
    ])
    ctx = build_project_context({"printer.cfg": cfg})
    assert "neopixel" in ctx.section_types
    assert "PRINT_START" in ctx.user_macros


def test_build_context_skips_commented_sections():
    cfg = _mk_config("a.cfg", [
        ConfigSection(section_type="neopixel", section_name="b",
                      full_header="neopixel b", is_commented_out=True),
    ])
    ctx = build_project_context({"a.cfg": cfg})
    assert "neopixel" not in ctx.section_types


def test_rename_existing_keeps_original_valid():
    # [gcode_macro G28] rename_existing:_PRINT_G28 — G28 remains a registry
    # command; the macro name itself (G28) is registry-valid regardless.
    cfg = _mk_config("a.cfg", [
        ConfigSection(section_type="gcode_macro", section_name="G28",
                      full_header="gcode_macro G28",
                      params=[
                          ConfigParam(key="rename_existing",
                                      value="_PRINT_G28"),
                          ConfigParam(key="gcode", value="M114")]),
    ])
    ctx = build_project_context({"a.cfg": cfg})
    assert classify_command("G28", ctx).status == STATUS_VALID


def test_rename_existing_alias_is_valid():
    # mainsail idiom: [gcode_macro PAUSE] rename_existing:PAUSE_BASE —
    # PAUSE_BASE is callable at runtime and must not flag unknown.
    cfg = _mk_config("mainsail.cfg", [
        ConfigSection(section_type="gcode_macro", section_name="PAUSE",
                      full_header="gcode_macro PAUSE",
                      params=[
                          ConfigParam(key="rename_existing",
                                      value="PAUSE_BASE"),
                          ConfigParam(key="gcode", value="PAUSE_BASE")]),
    ])
    ctx = build_project_context({"mainsail.cfg": cfg})
    assert classify_command("PAUSE_BASE", ctx).status == STATUS_VALID
    assert classify_command("PAUSE_BASE", ctx).source == "user_macro"


def test_available_commands_gate_filtering():
    cfg = _mk_config("a.cfg", [
        ConfigSection(section_type="probe", section_name="",
                      full_header="probe"),
        _macro("MYS"),
    ])
    names = available_commands({"a.cfg": cfg})
    assert "MYS" in names
    assert "PROBE" in names           # gate satisfied
    assert "SET_LED" not in names     # led family absent
    assert "G1" in names              # ungated


# ── token scanning ──────────────────────────────────────────────────────


def test_iter_tokens_basic():
    body = """
M104 S200
SET_LED LED=base RED=0 GREEN=0 BLUE=0
; comment M105
    ; indented comment
{action_respond_info("hi")}
"""
    toks = [t for _, t in iter_gcode_command_tokens(body)]
    assert toks == ["M104", "SET_LED"]


def test_iter_tokens_jinja_control_flow_skipped():
    body = """
{% if params.T is defined %}
M104 S{params.T}
{% endif %}
"""
    toks = [t for _, t in iter_gcode_command_tokens(body)]
    assert toks == ["M104"]


def test_iter_tokens_jinja_inline_command_name_only():
    body = "SET_LED LED={led_name} RED={r}\n"
    toks = [t for _, t in iter_gcode_command_tokens(body)]
    assert toks == ["SET_LED"]


def test_iter_tokens_key_value_lines_skipped():
    # scanning a whole section, not just the body
    body = "variable_foo: 1\ndescription: does things\n"
    toks = [t for _, t in iter_gcode_command_tokens(body)]
    assert toks == []


def test_scan_body_reports_only_problems():
    body = "M104 S200\nSET_NEOPIXEL_COLOR X\nSET_LED LED=a\n"
    ctx = _ctx(section_types=["extruder"])  # no led family
    found = list(scan_gcode_body(body, ctx))
    assert [v.status for _, v in found] == [STATUS_UNKNOWN,
                                            STATUS_CONDITIONAL_OUT]
    assert found[0][0] == 2  # line numbers
    assert found[0][1].name == "SET_NEOPIXEL_COLOR"


def test_scan_body_jinja_guarded_conditional_suppressed():
    # mainsail Test_Speed idiom: QGL inside an if-printer guard
    body = (
        "{% if printer.configfile.settings.quad_gantry_level %}\n"
        "    QUAD_GANTRY_LEVEL\n"
        "{% endif %}\n"
        "QUAD_GANTRY_LEVEL\n"
    )
    ctx = _ctx()  # no quad_gantry_level section
    found = list(scan_gcode_body(body, ctx))
    assert len(found) == 1          # only the UNGUARDED call flags
    assert found[0][0] == 4         # line number of the unguarded one


def test_scan_body_guard_on_other_section_does_not_suppress():
    body = (
        "{% if printer.save_variables %}\n"
        "    QUAD_GANTRY_LEVEL\n"
        "{% endif %}\n"
    )
    ctx = _ctx()
    found = list(scan_gcode_body(body, ctx))
    assert len(found) == 1          # guard is unrelated to QGL's gate


def test_scan_body_unguarded_e_gcode_macro_valid():
    body = ("{% if printer['gcode_macro FAN_BEEP'] %}\n"
            "FAN_BEEP\n"
            "{% endif %}\n")
    ctx = _ctx(macros=["FAN_BEEP"])
    assert list(scan_gcode_body(body, ctx)) == []


def test_scan_body_egcode_macro_undefined_still_flags():
    body = ("{% if printer['gcode_macro NOPE'] %}\n"
            "NOPE\n"
            "{% endif %}\n")
    ctx = _ctx()
    found = list(scan_gcode_body(body, ctx))
    assert len(found) == 1          # undefined macro: real problem


# ── real Trident fixture ────────────────────────────────────────────────


@pytest.mark.skipif(
    not (TRIDENT / "printer.cfg").is_file(),
    reason="Trident backup config not present")
def test_trident_project_context():
    from backend.parser.config_parser import parse_config_file

    configs = {p.name: parse_config_file(p) for p in TRIDENT.glob("*.cfg")}
    assert configs
    ctx = build_project_context(configs)
    assert ctx.user_macros  # Trident backup defines macros
    # the TRIDENT-16 confabulation must be unknown even on the real machine
    v = classify_command("SET_NEOPIXEL_COLOR", ctx)
    assert v.status == STATUS_UNKNOWN
    assert classify_command("PRINT_START", ctx).status == STATUS_VALID
