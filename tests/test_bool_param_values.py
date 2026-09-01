"""
3p (F23): BOOL params are never value-checked.

`_validate_param_value` has branches for INT/FLOAT/ENUM/PIN but none for
ParamType.BOOL, so all 65 BOOL params accept anything (`tmc2209.interpolate:
maybe` passed clean).

Ground truth: Klipper's getboolean delegates to RawConfigParser.getboolean
(klippy/configfile.py:73), which is Python's configparser. The accepted set
is BOOLEAN_STATES = true/false/yes/no/on/off/1/0 (case-insensitive); anything
else raises ValueError -> startup hard-fail.

The plan listed only true/false/yes/no/1/0 — 'on' and 'off' are also valid
and must NOT be flagged (verified against configparser.BOOLEAN_STATES,
2026-08-25).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402

STEPPER_BASE = (
    "[stepper_x]\n"
    "step_pin: PB0\n"
    "dir_pin: PB1\n"
    "enable_pin: !PB2\n"
    "microsteps: 16\n"
    "rotation_distance: 40\n"
    "position_endstop: ^PA0\n"
    "position_max: 250\n"
    "position_min: 0\n"
    "homing_speed: 50\n"
)


def _errors_for_bool(value: str) -> list:
    cfg = STEPPER_BASE + f"homing_positive_dir: {value}\n"
    errors = validate_config(parse_config(cfg, 'printer.cfg')).errors
    return [e for e in errors if e.param == "homing_positive_dir"]


# --- every value in configparser.BOOLEAN_STATES must pass -----------------

def test_all_valid_boolean_values_pass():
    for value in ("true", "false", "yes", "no", "1", "0", "on", "off",
                  "TRUE", "Off", "YES"):
        bad = _errors_for_bool(value)
        assert not bad, f"'{value}' is a valid boolean but was flagged: {[e.message for e in bad]}"


# --- everything else is a Klipper hard-fail --------------------------------

def test_invalid_bool_values_error():
    # NOTE: whitespace is stripped by configparser before getboolean, so
    # ' true ' is VALID — these are all genuinely unparseable.
    for value in ("maybe", "xyz", "1.0", "2", "truefalse", "tru", "truex"):
        errors = _errors_for_bool(value)
        assert any(e.severity == "error" for e in errors), \
            f"'{value}' is not a valid boolean but passed clean"


def test_bool_error_is_on_the_param():
    errors = _errors_for_bool("maybe")
    assert errors, "invalid bool must produce an error"
    assert errors[0].severity == "error"


def test_empty_bool_still_covered():
    # Empty value is already handled by the F16 present-but-empty check —
    # it must still be an error (not silently dropped by the new branch).
    errors = _errors_for_bool("")
    assert any(e.severity == "error" for e in errors), \
        f"empty bool must be an error, got: {[e.message for e in errors]}"


def test_no_bool_errors_on_clean_config():
    cfg = STEPPER_BASE  # homing_positive_dir absent entirely
    errors = validate_config(parse_config(cfg, 'printer.cfg')).errors
    assert not [e for e in errors if e.param == "homing_positive_dir"], \
        "absent optional bool must not be flagged"
