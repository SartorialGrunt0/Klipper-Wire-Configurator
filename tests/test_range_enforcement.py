"""
3h (F17): wire min_val/max_val range enforcement in _validate_param_value.

Machinery only — populating bounds on the schema is Phase 6 (data). No
ParamDef currently carries min_val/max_val, so these tests set bounds on a
real schema param at runtime (restored after each test) to exercise the
enforcement branch.

Ground truth (Klipper): getfloat(name, dflt, minval=0., maxval=1.) and
getint(name, dflt, minval=, maxval=) hard-fail out-of-range values
(e.g. led.py:18-21 initial_RED/GREEN/BLUE/WHITE -> 0..1).

Formula guard: a value that is not a plain number (e.g. 'homing_speed/2')
cannot be range-checked and is skipped — matching the existing INT/FLOAT
tolerance (plan F22(a) keeps formula/pin shapes passing), but evaluated
via float() so '1.5e3' IS still checked.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.config_schema import get_section_def  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _errors(cfg_text: str) -> list:
    return validate_config(parse_config(cfg_text, 'printer.cfg')).errors


STEPPER_BASE = (
    "[stepper_x]\n"
    "dir_pin: PB1\n"
    "enable_pin: !PB2\n"
    "microsteps: 16\n"
    "position_endstop: ^PA0\n"
    "position_max: 250\n"
    "position_min: 0\n"
    "homing_speed: 50\n"
)


@pytest.fixture
def bounded_microsteps():
    """Give [stepper_x].microsteps (INT) real bounds 1..256, restore after."""
    pd = get_section_def("stepper_x").params
    micro = next(p for p in pd if p.name == "microsteps")
    saved = (micro.min_val, micro.max_val)
    micro.min_val, micro.max_val = 1, 256
    try:
        yield micro
    finally:
        micro.min_val, micro.max_val = saved


def test_float_below_min_is_error():
    # rotation_distance is FLOAT; bound it to [0.1, 1000].
    pd = get_section_def("stepper_x").params
    rot = next(p for p in pd if p.name == "rotation_distance")
    saved = (rot.min_val, rot.max_val)
    rot.min_val, rot.max_val = 0.1, 1000.0
    try:
        errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
                         .replace("microsteps: 16\n", "microsteps: 16\nrotation_distance: 0.0\n"))
    finally:
        rot.min_val, rot.max_val = saved
    bad = [e for e in errors if e.param == "rotation_distance" and e.severity == "error"]
    assert bad, f"out-of-range float must be an error, got: {[e.message for e in errors if e.param == 'rotation_distance']}"


def test_int_above_max_is_error(bounded_microsteps):
    errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
                     .replace("microsteps: 16\n", "microsteps: 1024\n"))
    bad = [e for e in errors if e.param == "microsteps" and e.severity == "error"]
    assert bad, f"out-of-range int must be an error, got: {[e.message for e in errors if e.param == 'microsteps']}"


def test_value_within_bounds_clean(bounded_microsteps):
    errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1"))
    bad = [e for e in errors if e.param == "microsteps" and e.severity == "error"]
    assert not bad, f"in-range int must not error, got: {[e.message for e in bad]}"


def test_boundaries_inclusive(bounded_microsteps):
    for value in ("1", "256"):
        errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
                         .replace("microsteps: 16\n", f"microsteps: {value}\n"))
        bad = [e for e in errors if e.param == "microsteps" and e.severity == "error"]
        assert not bad, f"boundary value {value} must be allowed, got: {[e.message for e in bad]}"


def test_formula_value_skipped_for_range():
    # Formula-shaped FLOAT values ('homing_speed/2') are tolerated by the
    # type check (plan F22(a)) but cannot be range-checked — the range branch
    # must skip them, not try to parse and crash/flag.
    pd = get_section_def("stepper_x").params
    rot = next(p for p in pd if p.name == "rotation_distance")
    saved = (rot.min_val, rot.max_val)
    rot.min_val, rot.max_val = 0.1, 1000.0
    try:
        errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
                         .replace("microsteps: 16\n", "microsteps: 16\nrotation_distance: homing_speed/2\n"))
    finally:
        rot.min_val, rot.max_val = saved
    bad = [e for e in errors if e.param == "rotation_distance" and e.severity == "error"]
    assert not bad, f"formula value must be skipped for range checks, got: {[e.message for e in bad]}"


def test_unbounded_params_unaffected():
    # step_distance carries no bounds in the real schema — any value passes.
    errors = _errors(STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
                     .replace("microsteps: 16\n", "microsteps: 16\nstep_distance: -999\n"))
    bad = [e for e in errors if e.param == "step_distance" and e.severity == "error"]
    assert not bad, f"unbounded param must not be range-checked, got: {[e.message for e in bad]}"


# ── Regression: real-schema bounds (no fixtures — schema carries them) ──
# These guard the Klipper-derived bounds that a targeted sweep initially missed
# (shared STEPPER/TMC param lists + printer kinematics limits).

def test_rotation_distance_negative_rejected():
    # stepper.py: getfloat('rotation_distance', above=0.) — strictly above 0.
    cfg = STEPPER_BASE.replace("dir_pin: PB1", "step_pin: PB0\ndir_pin: PB1")
    for value, should_error in (("-20", True), ("0", True), ("40", False)):
        errors = _errors(cfg.replace("microsteps: 16\n", f"microsteps: 16\nrotation_distance: {value}\n"))
        bad = [e for e in errors if e.param == "rotation_distance" and e.severity == "error"]
        assert bool(bad) is should_error, \
            f"rotation_distance={value} should_error={should_error}, got: {[e.message for e in bad]}"


def test_printer_velocity_limits_negative_rejected():
    # toolhead.py: max_velocity/max_accel above=0. (strict);
    # square_corner_velocity minval=0. (inclusive — 0 is a valid no-square-corners value).
    base = "[printer]\nkinematics: corexy\nmax_velocity: 300\nmax_accel: 3000\nsquare_corner_velocity: 5\n"
    for param, value, should_error in (
        ("max_velocity", "-500", True), ("max_velocity", "0", True),
        ("max_accel", "-10", True),
        ("square_corner_velocity", "-1", True), ("square_corner_velocity", "0", False),
        ("square_corner_velocity", "5", False),
    ):
        defaults = {"max_velocity": "300", "max_accel": "3000", "square_corner_velocity": "5"}
        cfg = base.replace(f"{param}: {defaults[param]}", f"{param}: {value}")
        errors = _errors(cfg)
        bad = [e for e in errors if e.param == param and e.severity == "error"]
        assert bool(bad) is should_error, \
            f"{param}={value} should_error={should_error}, got: {[e.message for e in bad]}"


def test_tmc_current_and_thresholds_negative_rejected():
    # tmc2130.py TMCCurrentHelper: run_current/hold_current above=0. (strict);
    # tmc.py: stealthchop/coolstep/high_velocity_threshold minval=0. (inclusive).
    for param, value, should_error in (
        ("run_current", "-0.5", True), ("run_current", "0", True), ("run_current", "0.8", False),
        ("stealthchop_threshold", "-100", True),
        ("stealthchop_threshold", "0", False), ("stealthchop_threshold", "250", False),
    ):
        cfg = f"[tmc2130]\ncs_pin: PA1\nrun_current: 0.8\nstealthchop_threshold: 250\n"
        cfg = cfg.replace(f"run_current: 0.8", f"run_current: {value}") if param == "run_current" \
            else cfg.replace(f"stealthchop_threshold: 250", f"stealthchop_threshold: {value}")
        errors = _errors(cfg)
        bad = [e for e in errors if e.param == param and e.severity == "error"]
        assert bool(bad) is should_error, \
            f"{param}={value} should_error={should_error}, got: {[e.message for e in bad]}"
