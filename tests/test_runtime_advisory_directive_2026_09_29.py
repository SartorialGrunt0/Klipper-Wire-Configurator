"""Runtime-failure advisory nudge (2026-09-29).

Live report: a model asked to "add a macro that homes, travels a 100mm
circle three times, then homes again" stages a macro using G2/G3, receives
`gcode_command_section_missing` ("needs a [gcode_arcs] section — it will
error at runtime without one"), confidently ignores it, and never adds the
section. The advisory rides the card, so the user gets a macro that cannot
run.

Fix: when a staged op's advisories include the runtime-blocking class, the
tool result says so in the strongest terms AND orders the follow-up edit in
the same request. Other advisory classes keep the existing neutral tail —
this is a conditional escalation, not a general rewording.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from services.ai_edit_tools import (  # noqa: E402
    EditSession,
    _runtime_section_directive,
)

CTX_NO_ARCS = {"printer.cfg": {"content": (
    "[printer]\nkinematics: corexy\nmax_velocity: 300\n\n"
    "[gcode_macro PARK]\ngcode:\n    G28\n")}}

CIRCLE_MACRO = (
    "gcode:\n    G28\n"
    "    G2 X100 I50 J50\n    G2 X100 I50 J50\n"
    "    G2 X100 I50 J50\n    G28")


def _stage_circle_macro(session):
    return session.execute({"name": "config_edit", "arguments": {
        "file": "printer.cfg", "op": "add_section",
        "section": "gcode_macro CIRCLE_HOME", "text": CIRCLE_MACRO}})


# ── the escalation appears exactly when the runtime class does ──────────


def test_runtime_advisory_escalates_and_orders_the_fix():
    content, result = _stage_circle_macro(EditSession(CTX_NO_ARCS))
    assert "gcode_arcs" in content, "the advisory itself must still be shown"
    assert "RUNTIME" in content.upper(), (
        "a change that cannot run must be labelled as such, not filed "
        "under a generic 'advisory' the model reads as cosmetic")
    assert "[gcode_arcs]" in content
    assert "THIS request" in content or "this request" in content


def test_escalation_drops_the_dismissive_tail():
    content, _ = _stage_circle_macro(EditSession(CTX_NO_ARCS))
    assert "Advisories do not block the staged change." not in content, (
        "the dismissed-as-cosmetic wording must not survive next to a "
        "runtime-failure advisory")


def test_no_escalation_once_the_section_exists():
    session = EditSession(CTX_NO_ARCS)
    session.execute({"name": "config_edit", "arguments": {
        "file": "printer.cfg", "op": "add_section",
        "section": "gcode_arcs", "text": ""}})
    content, _ = _stage_circle_macro(session)
    assert "RUNTIME" not in content.upper()
    assert "gcode_command_section_missing" not in content


# ── helper contract: other advisory classes are untouched ───────────────


def test_directive_skips_other_advisory_classes():
    result = {"advisories": [{"code": "unknown_gcode_command",
                              "message": "'FOO' is not a Klipper command.",
                              "section": "gcode_macro X"}]}
    assert _runtime_section_directive(result) == ""


def test_directive_ignores_advisory_without_code():
    result = {"advisories": [{"severity": "warning", "message": "something"}]}
    assert _runtime_section_directive(result) == ""


def test_directive_fires_on_the_runtime_class():
    result = {"advisories": [{"code": "gcode_command_section_missing",
                              "message": "'G2' needs a [gcode_arcs] section "
                                         "in the configuration — it will "
                                         "error at runtime without one.",
                              "section": "gcode_macro CIRCLE_HOME"}]}
    directive = _runtime_section_directive(result)
    assert directive
    assert "runtime" in directive.casefold()


def test_directive_is_empty_for_a_clean_result():
    assert _runtime_section_directive({}) == ""
    assert _runtime_section_directive({"advisories": []}) == ""
