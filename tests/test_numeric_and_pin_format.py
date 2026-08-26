"""
3o (F22, user-reported 2026-08-24): tighten numeric validation and PIN format.

Ground truth (klippy/configfile.py, verified 2026-08-25):
  - getfloat/getint delegate to RawConfigParser (configparser). There is NO
    formula/eval support anywhere in config parsing — 'homing_speed/2'
    hard-fails with "Unable to parse option", and 'hello' hard-fails the
    same way. Verified empirically: getfloat('1e3')=1000.0, getint('16')=16,
    getint('16.0') raises.
  - But the validator's ceiling is config-load validation and the real world
    contains idiom the parser would reject only later (position_endstop:
    ^PA0 pin references, community formula shapes). Per plan F22(a) the rule
    is: reject the lone bare identifier ('hello' — the user's bug), tolerate
    numbers, pin references, and expression shapes. That catches the reported
    bug with zero false positives (real Trident: 0 non-numeric numeric params).

Severity: the plan proposed warning "pending Trident confirmation before
promoting to error". Confirmation ran 2026-08-25: the real Trident has ZERO
bare-identifier numeric values and zero bare no-digit pins, so the FLOAT
bare-word case is promoted to error (Klipper hard-fails 'hello') and the PIN
bare-word case stays a warning (exotic-but-legal board pin names possible).
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


def _errors_for(text: str) -> list:
    return validate_config(parse_config(text, 'printer.cfg')).errors


def _type_errors(errors: list, param: str) -> list:
    return [e for e in errors
            if e.param == param and e.severity == "error"
            and ("Expected" in e.message or "number" in e.message or "integer" in e.message)]


def _pin_warnings(errors: list, param: str) -> list:
    return [e for e in errors
            if e.param == param and e.severity == "warning"
            and ("Pin format" in e.message or "does not look like a valid pin" in e.message)]


# ── FLOAT: bare identifiers are rejected; numbers/pins/formulas tolerated ──

def test_float_formula_passes():
    # Plan F22(a) spec: "allow homing_speed/2 but reject hello". Formula
    # shapes are tolerated (29 test fixtures + community configs rely on it),
    # even though Klipper's parser would hard-fail them — the validator
    # errs on the lenient side for expression-shaped values.
    errors = _errors_for(STEPPER_BASE.replace("rotation_distance: 40\n", "rotation_distance: homing_speed/2\n"))
    assert not _type_errors(errors, "rotation_distance"), \
        "formula value must stay tolerated per plan F22(a)"


def test_float_pin_reference_passes():
    # position_endstop: ^PA0 is a common Klipper idiom (endstop object
    # supplies the position). The old alpha-skip existed for this — it must
    # keep passing.
    errors = _errors_for(STEPPER_BASE)  # position_endstop: ^PA0
    assert not _type_errors(errors, "position_endstop"), \
        "pin reference in a FLOAT param must stay tolerated"


def test_float_bare_identifier_is_error():
    # The user's bug (2026-08-24): position_max: hello passed clean.
    # A lone bare word is not a number, pin, or expression — hard error.
    errors = _errors_for(STEPPER_BASE.replace("position_max: 250\n", "position_max: hello\n"))
    assert _type_errors(errors, "position_max"), "bare identifier in a FLOAT param must be an error"


def test_float_valid_values_pass():
    for value in ("40", "40.5", "1e3", "-1.5", ".5", "5.", "4e-2"):
        errors = _errors_for(STEPPER_BASE.replace("rotation_distance: 40\n", f"rotation_distance: {value}\n"))
        assert not _type_errors(errors, "rotation_distance"), \
            f"'{value}' is a valid float but was flagged"


# ── INT: mirror configparser getint = int(value) exactly ──────────────────

def test_int_float_string_is_error():
    # Ground truth: configparser.getint does int(value) — '16.0' RAISES
    # (verified empirically 2026-08-25), so the existing int(value) check is
    # already correct and microsteps: 16.0 must stay an error.
    errors = _errors_for(STEPPER_BASE.replace("microsteps: 16\n", "microsteps: 16.0\n"))
    assert _type_errors(errors, "microsteps"), "getint('16.0') raises — must be an error"


def test_int_plain_values_pass():
    for value in ("16", "-1", "007"):
        errors = _errors_for(STEPPER_BASE.replace("microsteps: 16\n", f"microsteps: {value}\n"))
        assert not _type_errors(errors, "microsteps"), \
            f"'{value}' is a valid int but was flagged"


def test_int_formula_is_error():
    errors = _errors_for(STEPPER_BASE.replace("microsteps: 16\n", "microsteps: homing_speed/2\n"))
    assert _type_errors(errors, "microsteps"), "formula value must be an error for INT"


def test_int_garbage_is_error():
    errors = _errors_for(STEPPER_BASE.replace("microsteps: 16\n", "microsteps: xyz\n"))
    assert _type_errors(errors, "microsteps"), "non-numeric INT must be an error"


# ── PIN: bare non-pin identifiers are flagged, real shapes pass ─────────────

def test_bare_identifier_pin_is_warning():
    # 'abcd' is not a pin shape (no digits, not a device path) and is not in
    # any schema enum — Klipper would look for a pin literally named 'abcd'
    # and fail at connect/identify. Warning per plan (exotic-board risk).
    errors = _errors_for(STEPPER_BASE.replace("step_pin: PB0\n", "step_pin: abcd\n"))
    assert _pin_warnings(errors, "step_pin"), "bare identifier pin must warn"


def test_valid_pin_shapes_pass():
    # (Device paths like /dev/ttyACM0 are not GPIO pins — they belong in
    # serial: (a string param) — so they are not valid step_pin values.)
    for value in ("PB0", "PE11", "gpio20", "AA1", "^PA5", "~PB3", "!PE9",
                  "EBBCan:gpio20", "tmc2209_stepper_x:virtual_endstop",
                  "probe:z_virtual_endstop", "<my_pin>",
                  "PE7, PE8"):
        cfg = STEPPER_BASE.replace("step_pin: PB0\n", f"step_pin: {value}\n")
        errors = _errors_for(cfg)
        assert not _pin_warnings(errors, "step_pin"), \
            f"'{value}' is a valid pin shape but was flagged"


def test_pin_warning_not_error():
    # Severity stays warning — the plan's ceiling, and the frontend ack gate
    # already treats pin-format warnings as acknowledgeable.
    errors = _errors_for(STEPPER_BASE.replace("step_pin: PB0\n", "step_pin: abcd\n"))
    pin = _pin_warnings(errors, "step_pin")
    assert pin and pin[0].severity == "warning"
