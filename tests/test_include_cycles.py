"""Circular [include] detection in project validation.

Klipper resolves [include] recursively with no visited-set guard
(configfile.py reads the target into the same parser), so a cycle never
terminates and the printer fails to start. KWC refused only a file
including ITSELF, at the AI op layer — the two-file cycle (A -> B -> A)
staged clean through the write path and stayed invisible to the save gate.

Found by the Phase-5 text-protocol parity sweep 2026-09-24: a live
gemma-4-12b EDIT-04 trace wrote `[include printer.cfg]` INTO
`park_macros.cfg` (accepted) and later `[include park_macros.cfg]` into
printer.cfg (accepted), and a REPL repro showed `status: ok` with no
findings for the closed loop.

Severity: ERROR — Klipper cannot load such a project at all.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402
from services.ai_draft_project import ProjectState  # noqa: E402

PRINTER = "[printer]\nkinematics: corexy\nmax_velocity: 300\nmax_accel: 3000\n"
PARK = ("[include printer.cfg]\n\n[gcode_macro PARK_Z]\n"
        "gcode:\n  G91\n  G1 Z5 F600\n  G90\n")


def _project(files: dict[str, str]) -> dict:
    return validate_project_configs({
        name: parse_config(text, name) for name, text in files.items()
    })


def _cycle_findings(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if e.code == "include_cycle"
    ]


def test_two_file_cycle_is_an_error():
    results = _project({
        "printer.cfg": "[include park_macros.cfg]\n" + PRINTER,
        "park_macros.cfg": PARK,
    })
    findings = _cycle_findings(results)
    assert findings, "a closed include loop must be flagged"
    assert all(e.severity == "error" for e in findings)
    message = findings[0].message
    assert "Circular include" in message
    assert "printer.cfg" in message and "park_macros.cfg" in message
    # Anchored on the include line that closes the loop, with a real line
    # number — a finding with line 0 never renders in the editor gutter.
    assert findings[0].line_number == 1
    assert findings[0].section == "include park_macros.cfg"


def test_self_include_is_an_error():
    results = _project({
        "printer.cfg": "[include printer.cfg]\n" + PRINTER,
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    findings = _cycle_findings(results)
    assert findings, "a file including itself must be flagged"
    assert "include itself" in findings[0].message
    assert all(e.severity == "error" for e in findings)
    # Single-file validation paths see it too (not just the project pass),
    # and it is reported exactly once.
    assert len(findings) == 1, [e.message for e in findings]
    single = validate_config(parse_config("[include printer.cfg]\n" + PRINTER,
                                          "printer.cfg"))
    assert [e.code for e in single.errors] == ["include_cycle"]


def test_longer_cycle_names_the_whole_chain():
    results = _project({
        "printer.cfg": "[include a.cfg]\n" + PRINTER,
        "a.cfg": "[include b.cfg]\n[gcode_macro A]\ngcode: G28\n",
        "b.cfg": "[include printer.cfg]\n[gcode_macro B]\ngcode: G28\n",
    })
    findings = _cycle_findings(results)
    # One finding per include line taking part in the loop (each is a real
    # defect; removing any one breaks it), all naming the whole chain.
    assert len(findings) == 3, [e.message for e in findings]
    for finding in findings:
        message = finding.message
        for name in ("printer.cfg", "a.cfg", "b.cfg"):
            assert name in message, message


def test_legal_include_graph_is_not_flagged():
    # A diamond (both includes reaching the same file) is a DAG, not a
    # cycle — must stay silent, or every shared include would false-fire.
    results = _project({
        "printer.cfg": "[include a.cfg]\n[include b.cfg]\n" + PRINTER,
        "a.cfg": "[include c.cfg]\n[gcode_macro A]\ngcode: G28\n",
        "b.cfg": "[include c.cfg]\n[gcode_macro B]\ngcode: G28\n",
        "c.cfg": "[gcode_macro C]\ngcode: G28\n",
    })
    assert _cycle_findings(results) == []


def test_commented_and_glob_includes_never_form_a_cycle():
    # A commented include is dormant and a glob can match nothing — neither
    # is an edge Klipper would follow, so neither may be flagged.
    results = _project({
        "printer.cfg": "#[include park_macros.cfg]\n[include *.cfg]\n" + PRINTER,
        "park_macros.cfg": PARK,
    })
    assert _cycle_findings(results) == []


def test_every_file_in_the_loop_is_reported():
    # Both files hold an edge of the loop; the fix may be either line, so
    # the report must not depend on where the walk happened to start.
    results = _project({
        "printer.cfg": "[include park_macros.cfg]\n" + PRINTER,
        "park_macros.cfg": PARK,
    })
    reported_files = {
        name for name, fr in results.items()
        if any(e.code == "include_cycle" for e in fr.errors)
    }
    assert reported_files == {"printer.cfg", "park_macros.cfg"}


def test_ai_edit_gate_refuses_the_cycle_closing_include():
    """The write path must kick back, not stage: this is the exact op pair
    the live EDIT-04 trace produced."""
    st = ProjectState.from_context_files({
        "printer.cfg": {"content": PRINTER},
        "park_macros.cfg": {"content": PARK},
    })
    base = st.validate()
    new_state, result = st.apply(base, {
        "op": "add_include", "file": "printer.cfg",
        "target_file": "park_macros.cfg",
    })
    assert result["status"] == "error", result
    assert any("Circular include" in e["message"] for e in result["newErrors"])
    assert new_state.files == st.files
