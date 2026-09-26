"""Column-0 garbage lines the tolerant parser absorbs (Klipper hard-fails).

Ground truth (fixture-proven with real klippy, 2026-09-25):
  rename_existing: <newline>PROBE_ACCURACY  (unindented wrap)
  '=======', bare prose, Jinja at column 0 after a param
all raise configparser.ParsingError / MissingSectionHeaderError at load:
the config never starts. KWC's tolerant parser folded them into the
previous param's multi-line value and validated CLEAN.

Severity: error — every shape is a Klipper startup failure, same class as
unclosed_section_header.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import find_malformed_lines, parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402

PROBE_HEAD = """[mcu]
serial: /dev/nonexistent-zzz
[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 10
max_z_accel: 100
[stepper_x]
step_pin: PF0
dir_pin: PF1
enable_pin: !PD7
rotation_distance: 40
microsteps: 16
endstop_pin: ^PE5
position_min: 0
position_endstop: 0
position_max: 200
homing_speed: 50
[stepper_y]
step_pin: PF6
dir_pin: PF7
enable_pin: !PF2
rotation_distance: 40
microsteps: 16
endstop_pin: ^PJ1
position_min: 0
position_endstop: 0
position_max: 200
homing_speed: 50
[stepper_z]
step_pin: PL3
dir_pin: PL1
enable_pin: !PK0
rotation_distance: 8
microsteps: 16
endstop_pin: ^PD3
position_min: -5
position_endstop: 0
position_max: 200
homing_speed: 2
[probe]
pin: ^PG1
z_offset: 2.0
speed: 5.0

"""


def _bad(text):
    return [e for e in validate_config(parse_config(text, "t.cfg")).errors
            if e.code == "malformed_config_line"]


# ── detector unit ──────────────────────────────────────────────────────

def test_flags_unindented_value_wrap():
    text = "[gcode_macro PROBE_ACCURACY]\nrename_existing: \nPROBE_ACCURACY\ngcode:\n  M114\n"
    hits = find_malformed_lines(text)
    assert hits == [(3, "PROBE_ACCURACY")]


def test_flags_separatorless_column0_line():
    hits = find_malformed_lines("[stepper_x]\nmicrosteps: 16\n=======\n[printer]\n")
    assert hits == [(3, "=======")]


def test_flags_bare_jinja_at_column0():
    hits = find_malformed_lines("[gcode_macro F]\ngcode:\n  M114\n{% if true %}\n  M115\n")
    assert hits == [(4, "{% if true %}")]


def test_flags_content_before_first_section():
    hits = find_malformed_lines("Ok great, lets add some logic now.\n[printer]\n")
    assert len(hits) == 1 and hits[0][0] == 1


def test_indented_wrap_not_flagged():
    # configparser legal (Klipper fails later at connect — separate check)
    assert find_malformed_lines(
        "[gcode_macro FOO]\nrename_existing: \n    _FOO\n") == []


def test_comment_section_include_param_not_flagged():
    text = (
        "# leading comment\n"
        "[include mainsail.cfg]\n"
        "[gcode_macro FOO]\n"
        "gcode:\n"
        "  M114\n"
        "  # indented comment inside value\n"
        "  {% if true %}\n"
        "    M115\n"
        "  {% endif %}\n"
        "description: a macro\n"
    )
    assert find_malformed_lines(text) == []


def test_semicolon_comment_at_column0_not_flagged():
    assert find_malformed_lines("[printer]\n; note\nmax_velocity: 300\n") == []


def test_keyed_line_with_hyphen_not_flagged():
    # configparser accepts hyphen keys; unknown_param handles semantics
    assert find_malformed_lines("[foo_bar]\nsome-key: 1\n") == []


# ── validator wiring ───────────────────────────────────────────────────

def test_rename_wrap_shape_errors():
    text = (PROBE_HEAD +
            "[gcode_macro PROBE_ACCURACY]\nrename_existing: \nPROBE_ACCURACY\ngcode:\n  M114\n")
    findings = _bad(text)
    assert len(findings) == 1
    f = findings[0]
    assert f.severity == "error"
    assert f.line_number == len(PROBE_HEAD.splitlines()) + 3
    assert "column 0" in f.message or "unindented" in f.message


def test_valid_rename_still_clean():
    text = PROBE_HEAD + "[gcode_macro PROBE_ACCURACY]\nrename_existing: _PROBE_ACCURACY\ngcode:\n  M114\n"
    assert _bad(text) == []


def test_finding_survives_project_validation():
    from parser.validator import validate_project_configs
    text = (PROBE_HEAD +
            "[gcode_macro PROBE_ACCURACY]\nrename_existing: \nPROBE_ACCURACY\ngcode:\n  M114\n")
    cfg = parse_config(text, "printer.cfg")
    other = parse_config("[gcode_macro OTHER]\ngcode:\n  M115\n", "macros.cfg")
    results = validate_project_configs({"printer.cfg": cfg, "macros.cfg": other})
    codes = [e.code for e in results["printer.cfg"].errors]
    assert "malformed_config_line" in codes
