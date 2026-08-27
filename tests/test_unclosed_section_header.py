"""
F20: a section header with an opening '[' but no closing ']' (e.g. "[mcu")
is a Klipper syntax hard-fail. KWC's parser previously SILENTLY swallowed
such a line (it matched no regex and was folded into the previous
multi-line value or stashed as a comment), dropping the whole section and
its params with no finding. Now the parser records each malformed header
line at parse time and the validator reports it as an ERROR with a stable
code, so the user sees exactly which line Klipper would refuse to load.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402

CODE = "unclosed_section_header"


def _errors(result):
    return [e for e in result.errors if e.code == CODE]


def test_unclosed_header_is_error_with_line():
    text = (
        "[printer]\n"
        "kinematics: corexy\n"
        "\n"
        "[mcu\n"
        "status_timeout: 500\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    errs = _errors(result)
    assert errs, "an unclosed section header must be flagged"
    assert len(errs) == 1, f"exactly one finding, got {[e.message for e in errs]}"
    assert errs[0].severity == "error", \
        f"Klipper hard-fails on this — error, got {errs[0].severity!r}"
    assert errs[0].line_number == 4, \
        f"finding must point at the bad line, got {errs[0].line_number}"
    assert "mcu" in errs[0].section


def test_unclosed_header_blocks_save():
    # An error sets has_errors so the save button / gate treats it as fatal,
    # matching Klipper's startup failure.
    text = "[mcu\nstatus_timeout: 500\n"
    result = validate_config(parse_config(text, "printer.cfg"))
    assert result.has_errors


def test_project_validation_reports_unclosed_header():
    # The finding must also surface in project (multi-file) validation, which
    # is the source the center editor's gutter renders from.
    results = validate_project_configs({
        "printer.cfg": parse_config("[include a.cfg]\n[printer]\nkinematics: cartesian\n", "printer.cfg"),
        "a.cfg": parse_config("[mcu mainboard\nserial: /dev/ttyUSB0\n", "a.cfg"),
    })
    all_errs = [e for r in results.values() for e in r.errors if e.code == CODE]
    assert any(e.section and "mainboard" in e.section for e in all_errs), \
        f"project validation must flag the unclosed header, got {[e.section for e in all_errs]}"


def test_valid_headers_not_flagged():
    text = (
        "[printer]\n"
        "kinematics: corexy\n"
        "[mcu mainboard]\n"
        "serial: /dev/ttyUSB0\n"
        "[gcode_macro FOO]\n"
        "gcode: G28\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    assert not _errors(result), "well-formed headers must not be flagged"


def test_indented_open_bracket_is_not_a_header():
    # A '[' line indented under a multi-line value is a continuation in
    # Klipper, not a section header — must not be flagged.
    text = (
        "[gcode_macro FOO]\n"
        "gcode: G28\n"
        "  # a comment with [ an unclosed bracket in a continuation\n"
        "  M104 S50\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    assert not _errors(result), "indented bracket lines are not headers"


def test_commented_open_bracket_not_flagged():
    # A commented-out header is legal in Klipper — never flag it.
    text = (
        "[printer]\n"
        "kinematics: corexy\n"
        "#[mcu\n"
        "#status_timeout: 500\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    assert not _errors(result), "commented-out headers must not be flagged"


def test_bare_open_bracket_flagged():
    # A lone '[' at column 0 is a broken header too.
    text = "[printer]\nkinematics: corexy\n\n[\nfoo: 1\n"
    result = validate_config(parse_config(text, "printer.cfg"))
    assert _errors(result), "a bare '[' at column 0 must be flagged"


def test_multiple_unclosed_headers_each_flagged():
    text = (
        "[printer]\n"
        "kinematics: corexy\n"
        "[mcu\n"
        "[stepper_x\n"
        "step_pin: PA0\n"
    )
    result = validate_config(parse_config(text, "printer.cfg"))
    errs = _errors(result)
    lines = sorted(e.line_number for e in errs)
    assert lines == [3, 4], f"each malformed line flagged, got {lines}"
