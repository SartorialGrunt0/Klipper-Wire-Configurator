"""
3a (F7): cross-file exact-header duplicates for multi-instance section types.

Ground truth (klippy/configfile.py:172-173): Klipper reads the whole
project with RawConfigParser(strict=False) — duplicate section headers are
MERGED (later file wins) and never hard-fail. The existing project check
covers only singleton TYPES (max_instances=1, e.g. two [probe]); it skips
every type with max_instances=0, so an exact-header duplicate like two
[gcode_macro FOO] (or [tmc2209 stepper_x]) across included files was
uncaught.

These tests pin: warning severity, one warning per occurrence, both files
flagged, ack-gating by section type, case-insensitive header matching, and
no double-flagging of singleton types.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_project_configs  # noqa: E402


def _project(text_a: str, text_b: str) -> dict:
    return validate_project_configs({
        'printer.cfg': parse_config(text_a, 'printer.cfg'),
        'extra.cfg': parse_config(text_b, 'extra.cfg'),
    })


def _dup_warnings(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if e.code == 'project_duplicate'
    ]


def test_cross_file_macro_header_duplicate_is_warning():
    a = (
        "[include extra.cfg]\n"
        "\n"
        "[gcode_macro FOO]\n"
        "gcode: G28\n"
    )
    b = (
        "[gcode_macro FOO]\n"
        "gcode: G1 X10\n"
    )
    results = _project(a, b)
    dups = _dup_warnings(results)
    assert dups, "cross-file exact-header duplicate of a multi-instance section must be flagged"
    assert all(e.severity == 'warning' for e in dups)
    # One warning per occurrence, in the file that owns it.
    assert len(dups) == 2
    files = {fr for fr, res in results.items() for e in res.errors if e.code == 'project_duplicate'}
    assert files == {'printer.cfg', 'extra.cfg'}
    assert all(e.section == 'gcode_macro FOO' for e in dups)


def test_cross_file_named_driver_duplicate_is_warning():
    a = (
        "[stepper_x]\n"
        "step_pin: PB0\n"
        "\n"
        "[include extra.cfg]\n"
        "\n"
        "[tmc2209 stepper_x]\n"
        "run_current: 0.9\n"
    )
    b = (
        "[tmc2209 stepper_x]\n"
        "run_current: 1.2\n"
    )
    results = _project(a, b)
    dups = _dup_warnings(results)
    assert any('tmc2209 stepper_x' in e.message for e in dups)


def test_distinct_macro_headers_not_flagged():
    a = "[include extra.cfg]\n\n[gcode_macro FOO]\ngcode: G28\n"
    b = "[gcode_macro BAR]\ngcode: G1 X10\n"
    assert _dup_warnings(_project(a, b)) == []


def test_case_insensitive_header_matching():
    a = "[include extra.cfg]\n\n[gcode_macro FOO]\ngcode: G28\n"
    b = "[gcode_macro foo]\ngcode: G1 X10\n"
    dups = _dup_warnings(_project(a, b))
    assert len(dups) == 2


def test_single_file_header_duplicate_not_flagged_by_project_check():
    # 3a scope is CROSS-file duplicates; a single-file exact-header dup is
    # not the concern of the project pass.
    a = (
        "[gcode_macro FOO]\n"
        "gcode: G28\n"
        "\n"
        "[gcode_macro FOO]\n"
        "gcode: G28\n"
    )
    b = ""
    assert _dup_warnings(_project(a, b)) == []


def test_singleton_type_not_double_flagged():
    a = (
        "[include extra.cfg]\n"
        "\n"
        "[printer]\n"
        "kinematics: cartesian\n"
    )
    b = (
        "[printer]\n"
        "kinematics: delta\n"
    )
    dups = _dup_warnings(_project(a, b))
    # Exactly the singleton-type warning (one per occurrence) — the
    # exact-header pass must not add a second warning for the same pair.
    assert len(dups) == 2


def test_acknowledged_type_suppresses_header_duplicates(tmp_path, monkeypatch):
    monkeypatch.setenv('KWC_LAYOUT_DIR', str(tmp_path))
    from services.warning_acknowledgments import acknowledge_duplicate_section_type
    acknowledge_duplicate_section_type('gcode_macro')

    a = "[include extra.cfg]\n\n[gcode_macro FOO]\ngcode: G28\n"
    b = "[gcode_macro FOO]\ngcode: G1 X10\n"
    assert _dup_warnings(_project(a, b)) == []


def test_inactive_file_duplicates_ignored():
    # extra.cfg is not included by printer.cfg → not in the active project.
    a = "[gcode_macro FOO]\ngcode: G28\n"
    b = "[gcode_macro FOO]\ngcode: G1 X10\n"
    results = validate_project_configs({
        'printer.cfg': parse_config(a, 'printer.cfg'),
        'orphan.cfg': parse_config(b, 'orphan.cfg'),
    })
    assert _dup_warnings(results) == []
