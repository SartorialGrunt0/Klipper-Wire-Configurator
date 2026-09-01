"""
Cross-param (relational) bounds — plan 2026-08-30_214500.

Enforces same-section param-vs-param constraints from Klipper's
getfloat(above=X)/getfloat(minval=X)/between checks, where X is another
config param rather than a constant. Ground truth verified in ~/klipper
(2026-08-30); seeded in config_schema._seed_relational_constraints.

Strict (above=): v <= ref errors. Inclusive (minval=/maxval=/runtime
between): v < low or v > high errors. Absent/unparseable sides are
skipped (formula guard, matching the F17 range branch).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.config_schema import get_section_def  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _errors(cfg_text: str) -> list:
    return validate_config(parse_config(cfg_text, 'printer.cfg')).errors


def _bad(cfg_text: str, param: str) -> list:
    return [e for e in _errors(cfg_text) if e.param == param and e.severity == "error"]


def _pdef(section: str, param: str):
    return next(p for p in get_section_def(section).params if p.name == param)


# ── schema seeding assertions ──────────────────────────────────────────

def test_max_temp_seeded_on_all_temp_sections():
    for sec in ("extruder", "extruder1", "extruder7", "heater_bed", "heater_generic",
                "temperature_fan", "temperature_sensor", "temperature_probe",
                "z_thermal_adjust"):
        pd = _pdef(sec, "max_temp")
        assert pd.rel_above == "min_temp", f"{sec}.max_temp not seeded"


def test_position_max_seeded_where_klipper_reads_minmax():
    # stepper.py:348-351 — rails via LookupRail/LookupMultiRail with
    # need_position_minmax=True. Delta/deltesian/rotary lettered steppers
    # pass need_position_minmax=False, so they must NOT be seeded.
    for sec in ("stepper_x", "stepper_y", "stepper_z", "dual_carriage", "stepper_arm"):
        pd = _pdef(sec, "position_max")
        assert pd.rel_above == "position_min", f"{sec}.position_max not seeded"
    for sec in ("stepper_x", "stepper_y", "stepper_z", "dual_carriage", "stepper_arm"):
        pd = _pdef(sec, "position_endstop")
        assert pd.rel_between == ("position_min", "position_max"), f"{sec}.position_endstop"
    for sec in ("stepper_a", "stepper_b", "stepper_c", "stepper_left", "stepper_right"):
        assert _pdef(sec, "position_max").rel_above is None, f"{sec} must stay unseeded"


def test_extruder_and_fan_refs_seeded():
    assert _pdef("extruder", "min_extrude_temp").rel_between == ("min_temp", "max_temp")
    assert _pdef("extruder1", "min_extrude_temp").rel_between == ("min_temp", "max_temp")
    assert _pdef("temperature_fan", "target_temp").rel_between == ("min_temp", "max_temp")
    assert _pdef("resonance_tester", "max_freq").rel_min == "min_freq"
    assert _pdef("resonance_tester", "max_freq_z").rel_min == "min_freq"
    assert _pdef("extruder", "filament_diameter").rel_min == "nozzle_diameter"


def test_servo_and_clock_constant_bounds():
    # servo.py:15-18 — SERVO_SIGNAL_PERIOD = 0.020
    assert _pdef("servo", "minimum_pulse_width").strict_below == 0.020
    assert _pdef("servo", "maximum_pulse_width").strict_below == 0.020
    # static_pwm_clock.py:16 — above=(1/0.3)
    assert _pdef("static_pwm_clock", "frequency").strict_above == 1 / 0.3


# ── end-to-end validator behaviour ─────────────────────────────────────

SENSOR = "[temperature_sensor]\nsensor_type: BME280\n"


def test_max_temp_below_min_temp_errors():
    assert _bad(SENSOR + "min_temp: 100\nmax_temp: 50\n", "max_temp")
    assert _bad(SENSOR + "min_temp: 100\nmax_temp: 100\n", "max_temp")  # strict
    assert not _bad(SENSOR + "min_temp: 100\nmax_temp: 101\n", "max_temp")


def test_max_temp_against_min_temp_default():
    # min_temp defaults to 0 — max_temp: -5 must fail against the default
    assert _bad("[heater_bed]\nheater_pin: PA1\nmax_temp: -5\n", "max_temp")
    assert not _bad("[heater_bed]\nheater_pin: PA1\nmin_temp: -5\nmax_temp: 5\n", "max_temp")


STEPPER_BASE = "[stepper_x]\nstep_pin: PB0\ndir_pin: PB1\nmicrosteps: 16\n"


def test_position_max_strict_above_position_min():
    assert _bad(STEPPER_BASE + "position_min: 100\nposition_max: 50\nposition_endstop: 50\n",
                "position_max")
    assert _bad(STEPPER_BASE + "position_min: 100\nposition_max: 100\nposition_endstop: 100\n",
                "position_max")  # strict: equal errors
    assert not _bad(STEPPER_BASE + "position_min: 0\nposition_max: 250\nposition_endstop: 5\n",
                    "position_max")


DC_BASE = "[dual_carriage]\naxis: x\ncarriage_1: switch\nswitch_pin: ^PG6\n"


def test_dual_carriage_position_bounds():
    assert _bad(DC_BASE + "position_min: 100\nposition_max: 50\nposition_endstop: 75\n",
                "position_max")
    assert _bad(DC_BASE + "position_min: 0\nposition_max: 200\nposition_endstop: 250\n",
                "position_endstop")
    assert not _bad(DC_BASE + "position_min: 0\nposition_max: 200\nposition_endstop: 200\n",
                    "position_endstop")  # inclusive between


def test_min_extrude_temp_between_min_and_max():
    ext = "[extruder]\nnozzle_diameter: 0.4\nfilament_diameter: 1.75\nheater_pin: PA2\n"
    assert _bad(ext + "min_temp: 0\nmax_temp: 300\nmin_extrude_temp: 400\n", "min_extrude_temp")
    assert _bad(ext + "min_temp: 200\nmax_temp: 300\nmin_extrude_temp: 100\n", "min_extrude_temp")
    assert not _bad(ext + "min_temp: 0\nmax_temp: 300\nmin_extrude_temp: 170\n", "min_extrude_temp")
    assert not _bad(ext + "min_temp: 0\nmax_temp: 300\nmin_extrude_temp: 300\n",
                    "min_extrude_temp")  # inclusive boundary passes


TFAN = "[temperature_fan]\npin: PA4\nsensor_type: EPCOS 100K B57560G104F\n"


def test_target_temp_between_min_and_max():
    assert _bad(TFAN + "min_temp: 0\nmax_temp: 60\ntarget_temp: 80\n", "target_temp")
    assert _bad(TFAN + "min_temp: 40\nmax_temp: 60\ntarget_temp: 30\n", "target_temp")
    assert not _bad(TFAN + "min_temp: 0\nmax_temp: 60\ntarget_temp: 40\n", "target_temp")
    assert not _bad(TFAN + "min_temp: 0\nmax_temp: 40\ntarget_temp: 40\n", "target_temp")


RT = "[resonance_tester]\naccel_chip: adxl345\nprobe_points: 125,125,20\n"


def test_max_freq_inclusive_rel_min():
    assert _bad(RT + "min_freq: 40\nmax_freq: 20\n", "max_freq")
    assert not _bad(RT + "min_freq: 40\nmax_freq: 40\n", "max_freq")  # minval= inclusive
    assert not _bad(RT + "min_freq: 40\nmax_freq: 120\n", "max_freq")
    assert _bad(RT + "min_freq: 120\nmax_freq_z: 100\n", "max_freq_z")
    assert not _bad(RT + "min_freq: 100\nmax_freq_z: 100\n", "max_freq_z")


def test_filament_diameter_min_val_nozzle_diameter():
    ext = "[extruder]\nheater_pin: PA2\nnozzle_diameter: 0.6\n"
    assert _bad(ext + "filament_diameter: 0.4\n", "filament_diameter")
    assert not _bad(ext + "filament_diameter: 0.6\n", "filament_diameter")  # minval= inclusive
    assert not _bad(ext + "filament_diameter: 1.75\n", "filament_diameter")


SERVO = "[servo my_servo]\npin: PB3\n"


def test_servo_pulse_widths_below_signal_period():
    assert _bad(SERVO + "minimum_pulse_width: 0.020\n", "minimum_pulse_width")
    assert _bad(SERVO + "maximum_pulse_width: 0.025\n", "maximum_pulse_width")
    assert not _bad(SERVO + "maximum_pulse_width: 0.0019\n", "maximum_pulse_width")


SPWM = "[static_pwm_clock clk]\npin: PA8\n"


def test_static_pwm_clock_frequency_above_one_third():
    assert _bad(SPWM + "frequency: 3\n", "frequency")
    assert not _bad(SPWM + "frequency: 4\n", "frequency")
    assert not _bad(SPWM + "frequency: 1000000\n", "frequency")


def test_missing_ref_uses_schema_default():
    # target_temp alone: min/max default to 0/absent -> max side missing -> skip
    assert not _bad("[temperature_fan]\npin: PA4\nsensor_type: EPCOS 100K B57560G104F\n"
                    "max_temp: 60\ntarget_temp: 40\n", "target_temp")


def test_formula_values_skipped():
    # Formula/pin refs are not comparable — must not trigger a RELATIONAL
    # error (F22 parity). Bare identifiers ('hello') are still a FLOAT type
    # error; formula-shaped values pass the type check and skip comparison.
    assert not _bad(RT + "max_freq: accel_chip_freq/2\n", "max_freq")
    assert not _bad(DC_BASE + "position_max: x_max*2\nposition_endstop: ^PA0\n",
                    "position_max")
