"""Flag-gated commands (2026-09-29): [force_move] only registers FORCE_MOVE
and SET_KINEMATIC_POSITION when `enable_force_move: true` is set INSIDE the
section (reference klipper force_move.py:42-57).

Section-existence alone is not the gate: a config with `[force_move]` and no
`enable_force_move` still errors at runtime ("Unknown command"), which is the
same runtime-failure class as the G2/[gcode_arcs] advisory — but silent
before this gate.
"""
from __future__ import annotations

from pathlib import Path

from backend.parser.config_parser import ConfigFile, ConfigParam, ConfigSection
from backend.services.gcode_registry import (
    STATUS_CONDITIONAL_OUT,
    STATUS_VALID,
    ProjectGcodeContext,
    available_commands,
    build_project_context,
    classify_command,
)

REPO = Path(__file__).resolve().parent.parent


def _ctx(section_types=(), macros=(), flags=()):
    return ProjectGcodeContext(
        section_types=frozenset(section_types),
        user_macros=frozenset(macros),
        flag_values=frozenset(f.casefold() for f in flags))


# ── classify: the flag is the gate, not the section ─────────────────────


def test_force_move_needs_the_section_at_all():
    v = classify_command("FORCE_MOVE", _ctx())
    assert v.status == STATUS_CONDITIONAL_OUT
    assert "force_move" in v.required_sections


def test_force_move_section_without_the_enable_flag_is_still_a_problem():
    v = classify_command("FORCE_MOVE", _ctx(section_types=["force_move"]))
    assert v.status == STATUS_CONDITIONAL_OUT, (
        "bare [force_move] does not register FORCE_MOVE — the module "
        "registers it only inside `if self._enable_force_move`")


def test_force_move_with_enable_flag_is_valid():
    v = classify_command(
        "FORCE_MOVE",
        _ctx(section_types=["force_move"], flags=["force_move.enable_force_move"]))
    assert v.status == STATUS_VALID


def test_set_kinematic_position_has_the_same_gate():
    assert classify_command(
        "SET_KINEMATIC_POSITION", _ctx()).status == STATUS_CONDITIONAL_OUT
    assert classify_command(
        "SET_KINEMATIC_POSITION",
        _ctx(section_types=["force_move"])).status == STATUS_CONDITIONAL_OUT
    assert classify_command(
        "SET_KINEMATIC_POSITION",
        _ctx(section_types=["force_move"],
             flags=["force_move.enable_force_move"])).status == STATUS_VALID


def test_ungated_commands_unaffected_by_flag_plumbing():
    # A plain builtin stays valid, and a section-gated command is decided by
    # its section alone (no flag involvement).
    assert classify_command("G28", _ctx()).status == STATUS_VALID
    assert classify_command(
        "MANUAL_STEPPER", _ctx(section_types=["manual_stepper"])).status == STATUS_VALID
    assert classify_command(
        "MANUAL_STEPPER", _ctx()).status == STATUS_CONDITIONAL_OUT


# ── context builder reads the flag off the parsed config ────────────────


def _config_with_force_move(value: str | None) -> ConfigFile:
    cfg = ConfigFile(filename="printer.cfg")
    params = []
    if value is not None:
        params.append(ConfigParam(key="enable_force_move", value=value))
    cfg.sections.append(ConfigSection(
        section_type="force_move", section_name="", full_header="force_move",
        params=params))
    return cfg


def test_context_collects_truthy_flag():
    ctx = build_project_context(
        {"printer.cfg": _config_with_force_move("true")})
    assert "force_move.enable_force_move" in ctx.flag_values


def test_context_ignores_false_and_absent_flag():
    for value in ("false", None):
        ctx = build_project_context(
            {"printer.cfg": _config_with_force_move(value)})
        assert "force_move.enable_force_move" not in ctx.flag_values
        assert "force_move" in ctx.section_types


def test_context_ignores_commented_out_flag():
    cfg = _config_with_force_move("true")
    cfg.sections[0].params[0].is_commented_out = True
    ctx = build_project_context({"printer.cfg": cfg})
    assert "force_move.enable_force_move" not in ctx.flag_values


# ── available_commands honours the flag too ─────────────────────────────


def test_available_commands_hides_force_move_until_enabled():
    assert "FORCE_MOVE" not in available_commands(
        {"printer.cfg": _config_with_force_move(None)})
    assert "FORCE_MOVE" not in available_commands(
        {"printer.cfg": _config_with_force_move("false")})
    assert "FORCE_MOVE" in available_commands(
        {"printer.cfg": _config_with_force_move("true")})
