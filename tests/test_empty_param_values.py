"""
3g (F16): a present-but-empty value on a typed parameter must be an error.

Ground truth (Klipper source, verified 2026-08-25):
  - stepper.py:  step_pin = config.get('step_pin'); ppins.lookup_pin(step_pin, ...)
      pins.py parse_pin('') -> chip_name='mcu', pin='' -> lookup_pin fails with a
      traceback, NOT a clean config error.
  - configfile.getint('') / getfloat('') / getboolean('') raise ValueError /
    error because the option IS present (a present option never falls back to
    the code's default), so an empty INT/FLOAT/BOOL param is a startup hard-fail.

KWC gap: _validate_param_value only errors an empty value for ENUM; a
`step_pin:` with nothing after the colon returned silently and Klipper died
later with a confusing traceback.

Scope: only KNOWN (schema-typed) params — unknown params already get their own
'unknown_param' warning and must not be double-flagged. STRING and MULTI_LINE
params may legitimately be empty, so they are never flagged.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _errors(cfg_text: str) -> list:
    return validate_config(parse_config(cfg_text, 'printer.cfg')).errors


# --- each typed param type flags an empty value ----------------------------

def test_empty_pin_is_error():
    errors = _errors(
        "[stepper_x]\n"
        "step_pin:\n"
        "dir_pin: PB1\n"
        "enable_pin: !PB2\n"
        "microsteps: 16\n"
        "rotation_distance: 40\n"
        "position_endstop: ^PA0\n"
        "position_max: 250\n"
        "position_min: 0\n"
        "homing_speed: 50\n"
    )
    empty = [e for e in errors if e.param == "step_pin" and e.severity == "error" and "empty" in e.message.lower()]
    assert empty, f"empty step_pin must be an error, got: {[e.message for e in errors if e.param == 'step_pin']}"


def test_empty_int_is_error():
    errors = _errors(
        "[stepper_x]\n"
        "step_pin: PB0\n"
        "dir_pin: PB1\n"
        "enable_pin: !PB2\n"
        "microsteps:\n"
        "rotation_distance: 40\n"
        "position_endstop: ^PA0\n"
        "position_max: 250\n"
        "position_min: 0\n"
        "homing_speed: 50\n"
    )
    empty = [e for e in errors if e.param == "microsteps" and e.severity == "error" and "empty" in e.message.lower()]
    assert empty, f"empty microsteps must be an error, got: {[e.message for e in errors if e.param == 'microsteps']}"


def test_empty_float_is_error():
    errors = _errors(
        "[stepper_x]\n"
        "step_pin: PB0\n"
        "dir_pin: PB1\n"
        "enable_pin: !PB2\n"
        "microsteps: 16\n"
        "rotation_distance:\n"
        "position_endstop: ^PA0\n"
        "position_max: 250\n"
        "position_min: 0\n"
        "homing_speed: 50\n"
    )
    empty = [e for e in errors if e.param == "rotation_distance" and e.severity == "error" and "empty" in e.message.lower()]
    assert empty, f"empty rotation_distance must be an error, got: {[e.message for e in errors if e.param == 'rotation_distance']}"


def test_empty_bool_is_error():
    # [stepper_x] 'homing_positive_dir' is BOOL-typed — a present-but-empty
    # value must be flagged (Klipper getboolean('') with a present option raises).
    errors = _errors(
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
        "homing_positive_dir:\n"
    )
    empty = [e for e in errors if e.param == "homing_positive_dir" and e.severity == "error" and "empty" in e.message.lower()]
    assert empty, f"empty homing_positive_dir (BOOL) must be an error, got: {[e.message for e in errors if e.param == 'homing_positive_dir']}"


# --- existing behavior must not regress ------------------------------------

def test_empty_enum_still_errors():
    # 'kinematics' is STRING, not enum; use bed_mesh 'algorithm' (ENUM).
    errors = _errors(
        "[bed_mesh]\n"
        "algorithm: \n"
        "speed: 100\n"
    )
    empty = [e for e in errors if e.param == "algorithm" and e.severity == "error"]
    assert empty, f"empty enum must still error, got: {[e.message for e in errors if e.param == 'algorithm']}"


def test_nonempty_typed_params_clean():
    errors = _errors(
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
    empty = [e for e in errors if "empty" in e.message.lower()]
    assert not empty, f"valid stepper must have no empty-value errors, got: {[e.message for e in empty]}"


def test_empty_string_param_not_flagged():
    # A present-but-empty STRING param is legal in Klipper (getstring returns
    # ''). [respond].default_prefix is STRING — must NOT be flagged.
    errors = _errors(
        "[respond]\n"
        "default_type: echo\n"
        "default_prefix: \n"
    )
    empty = [e for e in errors if e.param == "default_prefix" and e.severity == "error"]
    assert not empty, f"empty string param must not be an error, got: {[e.message for e in empty]}"
