"""
3q (F24, user-reported 2026-08-24): relational param checks (param A vs param B).

Klipper validates same-section numeric relationships at config load via
getfloat(above=.../below=...) — each a startup hard-fail. Ground truth
(configfile.py _get_wrapper, verified 2026-08-25):
    above=X -> error when v <= X   (strictly above)
    below=X -> error when v >= X   (strictly below)

Seeded relations (same-section, unconditional or plan-mandated skip-if-missing):
  - heater max_temp > min_temp           (heaters.py:29 above=self.min_temp)
  - servo maximum_pulse_width >
    minimum_pulse_width                  (servo.py:17 above=self.min_width)
  - stepper position_max > position_min  (stepper.py:350 above=position_min)
  - stepper position_endstop within
    [position_min, position_max]         (stepper.py:355-357, INCLUSIVE bounds;
                                          skip when endstop or min/max missing)

Severity: error (Klipper hard-fails every one).

Deliberately NOT here (ground truth: cross-section, belongs to 3r):
  delta.arm_length vs radius (radius from [printer] delta_radius)
  deltesian.arm_length vs arm_x (from other steppers)
The plan's "12 above=/below= sites" include many absolute bounds (above=0.)
which are Phase 6 min_val data, not relational checks.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _errors(cfg: str) -> list:
    return validate_config(parse_config(cfg, 'printer.cfg')).errors


def _rel_errors(errors: list) -> list:
    return [e for e in errors
            if e.severity == "error" and ("above" in e.message or "below" in e.message or "between" in e.message)]


# ── heater max_temp > min_temp (strict) ─────────────────────────────────

def test_heater_max_temp_equal_min_temp_errors():
    # above= is strict: max_temp == min_temp is an error.
    cfg = "[extruder]\nheater_pin: PB0\nsensor_type: thermistor\nmin_temp: 20\nmax_temp: 20\n"
    assert _rel_errors(_errors(cfg)), "max_temp == min_temp must be an error (strict above)"


def test_heater_max_temp_below_min_temp_errors():
    cfg = "[heater_bed]\nheater_pin: PB0\nsensor_type: thermistor\nmin_temp: 50\nmax_temp: 30\n"
    assert _rel_errors(_errors(cfg)), "max_temp < min_temp must be an error"


def test_heater_max_temp_above_min_temp_passes():
    for sec, pin in (("extruder", "PB0"), ("heater_bed", "PB0"), ("temperature_fan", "PB1")):
        sensor = "thermistor"
        body = f"sensor_type: {sensor}\n"
        if sec == "temperature_fan":
            body = f"fan_pin: {pin}\nsensor_type: {sensor}\n"
        else:
            body = f"heater_pin: {pin}\nsensor_type: {sensor}\n"
        cfg = f"[{sec}]\n{body}min_temp: 0\nmax_temp: 300\n"
        assert not _rel_errors(_errors(cfg)), f"[{sec}] max_temp 300 > min_temp 0 must pass"


# ── servo maximum_pulse_width > minimum_pulse_width (strict) ────────────

def test_servo_pulse_width_equal_errors():
    cfg = ("[servo test]\npin: PB0\n"
           "minimum_pulse_width: 0.001\nmaximum_pulse_width: 0.001\n")
    assert _rel_errors(_errors(cfg)), "max == min pulse width must be an error (strict above)"


def test_servo_pulse_width_valid_passes():
    cfg = ("[servo test]\npin: PB0\n"
           "minimum_pulse_width: 0.001\nmaximum_pulse_width: 0.002\n")
    assert not _rel_errors(_errors(cfg)), "max > min pulse width must pass"


# ── stepper position_max > position_min (strict) ────────────────────────

STEPPER = ("[stepper_x]\nstep_pin: PB0\ndir_pin: PB1\nenable_pin: !PB2\n"
           "microsteps: 16\nrotation_distance: 40\nposition_endstop: ^PA0\n"
           "homing_speed: 50\n")


def _stepper_with(min_v, max_v, endstop=None):
    cfg = STEPPER
    if endstop is not None:
        cfg = cfg.replace("position_endstop: ^PA0\n", f"position_endstop: {endstop}\n")
    cfg += f"position_min: {min_v}\nposition_max: {max_v}\n"
    return cfg


def test_position_max_below_min_errors():
    # The user's bug: position_min 300 + position_max 210 passed clean.
    assert _rel_errors(_errors(_stepper_with("300", "210", "100"))), "position_max < position_min must be an error"


def test_position_max_equal_min_errors():
    assert _rel_errors(_errors(_stepper_with("100", "100", "100"))), "position_max == position_min must be an error (strict)"


def test_position_max_above_min_passes():
    assert not _rel_errors(_errors(_stepper_with("0", "250", "100"))), "position_max > position_min must pass"


# ── stepper position_endstop within [min,max] (inclusive) ───────────────

def test_position_endstop_above_max_errors():
    # The user's bug: position_endstop 999 with max 250 passed clean.
    assert _rel_errors(_errors(_stepper_with("0", "250", "999"))), "position_endstop > position_max must be an error"


def test_position_endstop_below_min_errors():
    assert _rel_errors(_errors(_stepper_with("0", "250", "-5"))), "position_endstop < position_min must be an error"


def test_position_endstop_at_boundaries_passes():
    # Inclusive: endstop == min and endstop == max are both legal.
    assert not _rel_errors(_errors(_stepper_with("0", "250", "0"))), "endstop == min must pass (inclusive)"
    assert not _rel_errors(_errors(_stepper_with("0", "250", "250"))), "endstop == max must pass (inclusive)"
    assert not _rel_errors(_errors(_stepper_with("0", "250", "125"))), "endstop in range must pass"


def test_missing_position_params_skipped():
    # plan: skip when either is missing — no min/max => no relational check.
    assert not _rel_errors(_errors(STEPPER)), "missing min/max must skip the relational check"
