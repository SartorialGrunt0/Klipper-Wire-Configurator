"""Validator integration tests for the gcode command registry scan."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from parser.config_parser import parse_config
from parser.validator import validate_config, validate_project_configs


def _codes(result, filename=None):
    return [e.code for e in result.errors if e.code.startswith(("unknown_gcode", "gcode_command"))]


def test_single_file_unknown_command_warning():
    cfg = parse_config(
        "[gcode_macro BAD]\ngcode:\n  SET_NEOPIXEL_COLOR LED=x\n",
        "printer.cfg")
    result = validate_config(cfg)
    assert "unknown_gcode_command" in _codes(result)
    finding = next(e for e in result.errors
                   if e.code == "unknown_gcode_command")
    assert finding.severity == "warning"   # never error
    assert "SET_LED" in finding.message    # suggestion embedded
    assert finding.line_number == 3


def test_single_file_valid_macro_no_finding():
    cfg = parse_config(
        "[neopixel base]\npin: PA0\n"
        "[gcode_macro GOOD]\ngcode:\n  SET_LED LED=base RED=0 GREEN=0 BLUE=0\n",
        "printer.cfg")
    result = validate_config(cfg)
    assert _codes(result) == []


def test_cross_file_macro_call_not_flagged():
    a = parse_config(
        "[include b.cfg]\n[gcode_macro OUTER]\ngcode:\n  INNER\n",
        "printer.cfg")
    b = parse_config("[gcode_macro INNER]\ngcode:\n  M114\n", "b.cfg")
    results = validate_project_configs({"printer.cfg": a, "b.cfg": b})
    assert _codes(results["printer.cfg"]) == []


def test_cross_file_conditional_gate_satisfied_elsewhere():
    a = parse_config(
        "[include b.cfg]\n[gcode_macro LEDY]\ngcode:\n  SET_LED LED=x RED=0\n",
        "printer.cfg")
    b = parse_config("[neopixel x]\npin: PA1\n", "b.cfg")
    results = validate_project_configs({"printer.cfg": a, "b.cfg": b})
    assert _codes(results["printer.cfg"]) == []


def test_project_mode_still_flags_true_unknown():
    a = parse_config(
        "[include b.cfg]\n[gcode_macro BAD]\ngcode:\n  RESONANCE_TEST\n",
        "printer.cfg")
    b = parse_config("[gcode_macro OTHER]\ngcode:\n  M114\n", "b.cfg")
    results = validate_project_configs({"printer.cfg": a, "b.cfg": b})
    codes = _codes(results["printer.cfg"])
    assert codes == ["unknown_gcode_command"]


def test_conditional_out_warning_message():
    cfg = parse_config(
        "[gcode_macro NOLED]\ngcode:\n  SET_LED LED=x RED=0\n",
        "printer.cfg")
    result = validate_config(cfg)
    finding = next(e for e in result.errors
                   if e.code == "gcode_command_section_missing")
    assert finding.severity == "warning"
    assert "neopixel" in finding.message


def test_delayed_gcode_scanned():
    cfg = parse_config(
        "[delayed_gcode wiggle]\ngcode:\n  FAKE_COMMAND_XYZ\n",
        "printer.cfg")
    result = validate_config(cfg)
    assert "unknown_gcode_command" in _codes(result)


def test_commented_macro_body_not_flagged():
    cfg = parse_config(
        "[gcode_macro OLD]\n#gcode:\n#  FAKE_COMMAND_XYZ\n",
        "printer.cfg")
    result = validate_config(cfg)
    assert _codes(result) == []


def test_ack_granularity_one_command_one_ack(monkeypatch, tmp_path):
    """Acking one unknown command must NOT silence a second unknown command
    in the same macro body: same file|code|section|param, so the command
    name (finding.extra) is the only discriminator."""
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from services.warning_acknowledgments import (
        acknowledge_warning_identities, finding_identity,
    )
    cfg = parse_config(
        "[gcode_macro TWO_BAD]\n"
        "gcode:\n"
        "  SET_NEOPIXEL_COLOR RED=1\n"
        "  SET_RAINBOW_EFFECT\n")
    res = validate_config(cfg)
    assert [e.extra for e in res.errors] == [
        "SET_NEOPIXEL_COLOR", "SET_RAINBOW_EFFECT"]

    acknowledge_warning_identities([
        finding_identity("printer.cfg", "unknown_gcode_command",
                         "gcode_macro TWO_BAD", "gcode",
                         "SET_NEOPIXEL_COLOR")])
    after = validate_config(cfg)
    assert [e.extra for e in after.errors] == ["SET_RAINBOW_EFFECT"]


def test_jinja_guards_and_params_no_noise():
    cfg = parse_config(
        "[gcode_macro SMART]\n"
        "variable_foo: 1\n"
        "description: runs stuff\n"
        "gcode:\n"
        "  {% if printer.extruder.can_extrude %}\n"
        "    G1 E1 F300\n"
        "  {% endif %}\n"
        "  {% set x = 1 %}\n"
        "  RESPOND TYPE=echo MSG='hi {x}'\n",
        "printer.cfg")
    result = validate_config(cfg)
    assert _codes(result) == []


# ── AI-loop scope exclusion (branch contract) ──────────────────────────


def test_gcode_registry_false_suppresses_scan():
    cfg = parse_config(
        "[gcode_macro BAD]\ngcode:\n  SET_NEOPIXEL_COLOR LED=x\n",
        "printer.cfg")
    result = validate_config(cfg, gcode_registry=False)
    assert _codes(result) == []
    # the ON path still flags it (flag is per-call, not global)
    assert "unknown_gcode_command" in _codes(validate_config(cfg))


def test_project_gcode_registry_false_suppresses_everywhere():
    a = parse_config(
        "[include b.cfg]\n[gcode_macro BAD]\ngcode:\n  RESONANCE_TEST\n",
        "printer.cfg")
    b = parse_config(
        "[gcode_macro NOLED]\ngcode:\n  SET_LED LED=x RED=0\n", "b.cfg")
    results = validate_project_configs(
        {"printer.cfg": a, "b.cfg": b}, gcode_registry=False)
    assert _codes(results["printer.cfg"]) == []
    assert _codes(results["b.cfg"]) == []
