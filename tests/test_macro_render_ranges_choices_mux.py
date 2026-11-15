"""P2 (either-of), P3 (literal range refusals) and P4 (mux v2 object spaces).

Each check here mirrors a refusal in Klipper's own source, so a finding is a
run-time error the rendered line would really hit:

- P3 range: gcode.py `GCodeCommand.get()` raises outside
  minval/maxval (inclusive) or above/below (exclusive). Only LITERAL limits
  reach the registry artifact; a config-derived limit is never recorded.
- P2 either-of: SET_FAN_SPEED refuses unless exactly one of SPEED/TEMPLATE
  (fan_generic.py), TEMPERATURE_WAIT refuses when neither MINIMUM nor
  MAXIMUM is given (heaters.py).
- P4 mux: CHIP / STEPPER-rail / TEMPERATURE_WAIT SENSOR resolve against the
  project's own sections, in three different object spaces.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.macro_render import simulate_macro  # noqa: E402


def _codes(result):
    return [(f.severity, f.code) for f in result.findings]


def _messages(result):
    return [f.message for f in result.findings]


# ── P3: literal range refusals ─────────────────────────────────────────────

def test_led_component_above_one_is_out_of_range():
    # led.py: get_float('RED', 0., minval=0., maxval=1.) — RED=255 is the
    # classic 0-255 assumption and Klipper refuses it.
    r = simulate_macro("SET_LED LED=led1 RED=255 GREEN=0 BLUE=0")
    errs = [f for f in r.findings if f.code == "macro_param_out_of_bounds"]
    assert len(errs) == 1 and "RED" in errs[0].message, _messages(r)
    assert "maximum of 1.0" in errs[0].message, errs[0].message


def test_led_bounds_are_inclusive():
    for value in ("0", "1", "0.5"):
        r = simulate_macro(f"SET_LED LED=led1 RED={value} GREEN=0 BLUE=0")
        assert "macro_param_out_of_bounds" not in [f.code for f in r.findings], \
            (value, _messages(r))


def test_exclusive_below_limit_is_enforced():
    # toolhead.py: MINIMUM_CRUISE_RATIO get_float(..., minval=0., below=1.)
    # — 1.0 is refused (below is exclusive), 0.99 is fine.
    bad = simulate_macro("SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=1")
    assert "macro_param_out_of_bounds" in [f.code for f in bad.findings], \
        _messages(bad)
    ok = simulate_macro("SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0.99")
    assert "macro_param_out_of_bounds" not in [f.code for f in ok.findings], \
        _messages(ok)


def test_exclusive_above_zero_is_enforced():
    # gcode_move.py: M220 S read with above=0. — 0 is refused, 100 is fine.
    bad = simulate_macro("M220 S0")
    assert "macro_param_out_of_bounds" in [f.code for f in bad.findings], \
        _messages(bad)
    assert not simulate_macro("M220 S100").findings


def test_inclusive_zero_lower_bound_accepts_zero():
    # fan.py: M106 S get_float('S', minval=0.) — S0 is legitimate (fan off).
    r = simulate_macro("M106 S0")
    assert "macro_param_out_of_bounds" not in [f.code for f in r.findings], \
        _messages(r)


def test_config_derived_limit_is_never_checked():
    # output_pin VALUE carries minval 0 but maxval=self.scale (config): the
    # upper bound is undecidable, so only the literal lower bound applies.
    high = simulate_macro("SET_PIN PIN=fan VALUE=99")
    assert "macro_param_out_of_bounds" not in [f.code for f in high.findings], \
        _messages(high)
    low = simulate_macro("SET_PIN PIN=fan VALUE=-1")
    assert "macro_param_out_of_bounds" in [f.code for f in low.findings], \
        _messages(low)


def test_range_check_skips_unknown_renders():
    r = simulate_macro("SET_LED LED=led1 RED={printer.led.chain} GREEN=0 BLUE=0")
    assert "macro_param_out_of_bounds" not in [f.code for f in r.findings], \
        _messages(r)


# ── P2: either-of / exactly-one ────────────────────────────────────────────

def test_fan_speed_needs_speed_or_template():
    none_ = simulate_macro("SET_FAN_SPEED FAN=aux", )
    assert "macro_param_missing_choice" in [f.code for f in none_.findings], \
        _messages(none_)
    for body in ("SET_FAN_SPEED FAN=aux SPEED=0.5",
                 "SET_FAN_SPEED FAN=aux TEMPLATE=t1"):
        r = simulate_macro(body)
        assert "macro_param_missing_choice" not in [f.code for f in r.findings], \
            (body, _messages(r))


def test_fan_speed_refuses_both_speed_and_template():
    r = simulate_macro("SET_FAN_SPEED FAN=aux SPEED=0.5 TEMPLATE=t1")
    errs = [f for f in r.findings if f.code == "macro_param_missing_choice"]
    assert len(errs) == 1 and "only ONE" in errs[0].message, _messages(r)


def test_temperature_wait_needs_at_least_one_limit():
    bad = simulate_macro("TEMPERATURE_WAIT SENSOR=extruder")
    errs = [f for f in bad.findings if f.code == "macro_param_missing_choice"]
    assert len(errs) == 1 and "at least one" in errs[0].message, _messages(bad)
    for body in ("TEMPERATURE_WAIT SENSOR=extruder MINIMUM=50",
                 "TEMPERATURE_WAIT SENSOR=extruder MAXIMUM=250",
                 "TEMPERATURE_WAIT SENSOR=extruder MINIMUM=50 MAXIMUM=250"):
        r = simulate_macro(body)
        assert "macro_param_missing_choice" not in [f.code for f in r.findings], \
            (body, _messages(r))


def test_choice_check_is_undecidable_when_a_member_renders_unknown():
    # TEMPLATE would come from an undeclared param: whether it is supplied is
    # unknowable, so the exactly-one verdict must NOT be fabricated.
    r = simulate_macro("SET_FAN_SPEED FAN=aux TEMPLATE={params.T} SPEED=0.5")
    assert "macro_param_missing_choice" not in [f.code for f in r.findings], \
        _messages(r)


# ── P4: mux object spaces ──────────────────────────────────────────────────

def test_chip_space_resolves_against_chip_sections():
    bare = frozenset({"adxl345"})
    assert not [f for f in simulate_macro(
        "ACCELEROMETER_MEASURE CHIP=adxl345", sections=bare).findings
        if f.code == "macro_mux_target_unknown"]

    named = frozenset({"adxl345 my_chip"})
    r = simulate_macro("ACCELEROMETER_MEASURE CHIP=my_chip", sections=named)
    assert not [f for f in r.findings if f.code == "macro_mux_target_unknown"], \
        _messages(r)

    wrong = simulate_macro("ACCELEROMETER_MEASURE CHIP=probe_eddy_current",
                           sections=bare)
    assert [f for f in wrong.findings
            if f.code == "macro_mux_target_unknown"], _messages(wrong)


def test_stepper_rail_space_resolves_rails_not_sections():
    sections = frozenset({"stepper_x", "stepper_y", "extruder",
                          "tmc2209 stepper_x", "manual_stepper lifter"})
    for value in ("stepper_x", "extruder"):
        r = simulate_macro(f"DUMP_TMC STEPPER={value}", sections=sections)
        assert not [f for f in r.findings
                    if f.code == "macro_mux_target_unknown"], (value, _messages(r))
    # A stepper that does not exist is the real class this catches.
    bad = simulate_macro("DUMP_TMC STEPPER=stepper_q", sections=sections)
    assert [f for f in bad.findings
            if f.code == "macro_mux_target_unknown"], _messages(bad)


def test_manual_stepper_resolves_its_own_section_name():
    sections = frozenset({"manual_stepper lifter"})
    ok = simulate_macro("MANUAL_STEPPER STEPPER=lifter MOVE=10",
                        sections=sections)
    assert not [f for f in ok.findings
                if f.code == "macro_mux_target_unknown"], _messages(ok)
    bad = simulate_macro("MANUAL_STEPPER STEPPER=nope MOVE=10",
                         sections=sections)
    assert [f for f in bad.findings
            if f.code == "macro_mux_target_unknown"], _messages(bad)


def test_sensor_space_uses_the_full_section_name():
    sections = frozenset({"temperature_sensor chamber", "heater_bed",
                          "extruder", "z_thermal_adjust"})
    ok = simulate_macro("TEMPERATURE_WAIT SENSOR=temperature_sensor chamber "
                        "MINIMUM=50", sections=sections)
    assert not [f for f in ok.findings
                if f.code == "macro_mux_target_unknown"], _messages(ok)
    # z_thermal_adjust registers a sensor too — must not be called missing.
    zta = simulate_macro("TEMPERATURE_WAIT SENSOR=z_thermal_adjust MINIMUM=20",
                         sections=sections)
    assert not [f for f in zta.findings
                if f.code == "macro_mux_target_unknown"], _messages(zta)
    # The bare NAME is not the registered value: the full header is.
    bad = simulate_macro("TEMPERATURE_WAIT SENSOR=chamber MINIMUM=50",
                         sections=sections)
    assert [f for f in bad.findings
            if f.code == "macro_mux_target_unknown"], _messages(bad)


def test_mux_checks_stay_silent_without_project_sections():
    # No sections => absence is undecidable => no verdict, never a guess.
    for body in ("DUMP_TMC STEPPER=whatever",
                 "ACCELEROMETER_MEASURE CHIP=whatever",
                 "TEMPERATURE_WAIT SENSOR=whatever MINIMUM=1"):
        r = simulate_macro(body)
        assert "macro_mux_target_unknown" not in [f.code for f in r.findings], \
            (body, _messages(r))
