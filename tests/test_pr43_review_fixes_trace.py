"""Trace-truthfulness fixes from PR #43 review round 2 (A-F5, A-F6, A-F7).

Contract under test (each pin cites the reviewer finding it locks down):

  * A-F6 — Klipper registers ONLY G28 (klippy/extras/homing.py:306). Its
    dispatch token for ``G28.1`` is ``G28.1`` (klippy/gcode.py:210-215 keeps
    the dotted suffix), which resolves to gcode.cmd_default -> "Unknown
    command": the macro ABORTS. Marking axes homed there is a trace untruth.
    (G28.1 exists on real printers only as some *other* macro's
    ``rename_existing`` target — not something the trace can know.)
  * A-F5 — SET_KINEMATIC_POSITION (klippy/extras/force_move.py:118-137) sets
    position only for the axes NAMED on the line, but homes whatever
    ``SET_HOMED`` names, DEFAULT ``'xyz'`` — all three axes. It is also
    registered only when ``[force_move] enable_force_move`` is true
    (force_move.py:44-47).
  * A-F7 — a named-but-empty value (``G92 X``, ``SET_KINEMATIC_POSITION X=``)
    is a Klipper parse error (``gcmd.get_float`` raises), never position 0;
    the render simulator already flags those lines macro_param_renders_empty.
  * Cosmetic — ``CALIBATE_Z`` is not a Klipper command (typo of nothing:
    neither CALIBATE_Z nor CALIBRATE_Z exists upstream); degenerate declared
    geometry (position_min == position_max, print_radius 0) must not raise
    ZeroDivisionError out of the MCP handler.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.macro_trace import (  # noqa: E402
    Z_MOVERS, MotionProfile, annotate, derive_motion_profile, seed_state,
    trace_motion)


_VORON = """
[printer]
kinematics: corexy
[stepper_x]
position_endstop: 250
position_max: 250
[stepper_y]
position_endstop: 250
position_max: 250
[stepper_z]
position_endstop: 0
position_min: -5
position_max: 250
"""

# position_min == position_max on X: a *declared* but degenerate axis.
_DEGENERATE = """
[printer]
kinematics: cartesian
[stepper_x]
position_min: 200
position_max: 200
[stepper_y]
position_min: 0
position_max: 200
[stepper_z]
position_max: 200
"""

# print_radius 0: declared, degenerate round bed.
_ZERO_RADIUS = """
[printer]
kinematics: delta
print_radius: 0
[stepper_z]
position_max: 300
"""


def _t(cfg, lines, state=None):
    profile = (derive_motion_profile([cfg]) if cfg
               else derive_motion_profile([]))
    if state is None:
        state, _ = seed_state({})
    return trace_motion(lines, profile, state)


def _lines(tr):
    return "\n".join(tr.lines)


# ── A-F6 + T-1: G28.1 does not exist in Klipper, and the macro SURVIVES ─

def test_g28_1_is_unknown_command_and_the_macro_continues():
    # A-F6 said G28.1 reaches cmd_default; T-1 (second pass) corrected what
    # cmd_default DOES there: respond_info('Unknown command:"G28.1"') and
    # return — no error, so the script keeps running (gcode.py:283-316,
    # re-proven against klippy/gcode.py with a stub printer). Only the
    # phantom homing half of the old pin survives.
    st, _ = seed_state({"toolhead.position": [10, 10, 5],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_VORON, [(1, "G28.1"), (2, "G1 X100 Y100")], st)
    text = _lines(tr)
    assert tr.aborted is False              # nothing here stops the macro
    assert 'Unknown command:"G28.1"' in text
    assert "CONTINUES" in text              # the behaviour, said aloud
    assert "L2" in text                     # the later line still ran
    assert tr.state.pos["x"] == 100.0
    # de-homing half: nothing became homed, nothing moved at L1
    assert tr.state.homed == {"x", "y", "z"}


# ── A-F5: SET_HOMED decides homing, not the named position params ──────

def test_set_kinematic_position_default_set_homed_is_xyz():
    # No SET_HOMED given -> force_move.py default 'xyz' => ALL axes homed,
    # even though only X carries a position.
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=10"),
                     (2, "G1 Y100 F3000")])
    text = _lines(tr)
    assert tr.state.homed == {"x", "y", "z"}
    assert tr.state.pos["x"] == 10.0
    assert tr.aborted is False          # Y100 is legal on a homed machine
    assert tr.state.pos["y"] == 100.0
    assert "SET_HOMED" in text          # the default is said aloud


def test_set_kinematic_position_explicit_set_homed_narrows_homing():
    # SET_HOMED=x homes ONLY x; the Y move is then refused, like Klipper.
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION SET_HOMED=x"),
                     (2, "G1 Y100 F3000")])
    text = _lines(tr)
    assert tr.state.homed == {"x"}
    assert tr.aborted is True
    assert "Must home axis first: y" in text


def test_set_kinematic_position_annotation_names_force_move_gate():
    # force_move.py:42-47 — the command exists only with enable_force_move.
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=10 Y=10 Z=1")])
    line = next(ln for ln in tr.lines
                if "SET_KINEMATIC_POSITION" in ln and "REFUSED" not in ln)
    assert "enable_force_move" in line


# ── A-F7: empty rendered values are parse errors, not zero ─────────────

def test_g92_with_empty_value_aborts_instead_of_zero():
    tr = _t(_VORON, [(1, "G28"), (2, "G92 X"), (3, "G1 X50")])
    text = _lines(tr)
    assert tr.aborted is True
    assert tr.state.pos["x"] == 250.0   # the G28 landing, NOT 0
    assert "G92" in text and "ABORTED" in text
    assert "L3" not in text             # later lines did not run


def test_set_kinematic_position_with_empty_value_aborts():
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X="),
                     (2, "G1 X50")])
    text = _lines(tr)
    assert tr.aborted is True
    assert tr.state.pos["x"] is None    # never silently 0
    assert tr.state.homed == set()      # nothing was homed either
    assert "L2" not in text


# ── cosmetic 1: no phantom command in Z_MOVERS ─────────────────────────

def test_z_movers_has_no_typo_command():
    # PR #43 review (cosmetic 1): CALIBATE_Z exists nowhere in klippy —
    # treating it as a Z mover modelled a command that cannot run.
    assert "CALIBATE_Z" not in Z_MOVERS


# ── cosmetic 2: degenerate geometry must not crash the handler ─────────

def test_degenerate_axis_bounds_make_no_range_claim():
    profile = derive_motion_profile([_DEGENERATE])
    assert profile.bounds["x"] == (200.0, 200.0)
    ann, cartesian = annotate({"x": 200.0, "y": 100.0}, profile)
    # a 200–200 span is not a machine extent: stay silent on that axis
    assert "200\u2013200" not in ann
    assert "X " not in ann
    assert "Y " in ann                  # the healthy axis still annotates
    assert cartesian is True


def test_zero_print_radius_does_not_raise():
    profile = derive_motion_profile([_ZERO_RADIUS])
    assert profile.radius == 0.0
    # annotate: was ZeroDivisionError (d / radius)
    ann, _ = annotate({"x": 10.0, "y": 10.0}, profile)
    assert "%" not in ann and "out" not in ann
    # and the whole trace survives a move on that degenerate profile
    st, _ = seed_state({"toolhead.position": [0, 0, 100],
                        "gcode_move.homed_axes": "xyz"})
    tr = trace_motion([(1, "G1 X5 Y5")], profile, st)
    assert "Final state" in _lines(tr)


def test_zero_radius_profile_object_is_safe_to_annotate():
    ann, _ = annotate({"x": 3.0, "y": 4.0},
                      MotionProfile(radius=0.0))
    assert ann == ""


# ── T-1 (second pass): G28.1 is a WARNING, not an abort ────────────────
# klippy/gcode.py:283-316 (cmd_default) answers an unregistered token with
# gcmd.respond_info('Unknown command:"%s"') and returns. Nothing raises, so
# run_script_from_command keeps executing the remaining lines. The trace used
# to claim "the real printer stops the macro here" — false in the aborting
# direction (and it hid every line after it).

def test_t1_g28_1_note_says_continue_and_later_lines_run():
    """T-1: G28.1 -> Unknown command, macro CONTINUES; later lines execute."""
    st, _ = seed_state({"toolhead.position": [10, 10, 5],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_VORON, [(1, "G28.1"), (2, "G1 X100 Y100")], st)
    text = _lines(tr)
    note = next(ln for ln in tr.lines if ln.startswith("L1:"))
    assert 'Unknown command:"G28.1"' in note
    assert "CONTINUES" in note and "later lines still run" in note
    assert "REFUSED" not in note            # a warning, not a refusal
    assert not tr.aborted
    assert "L2" in text                     # the move after it really ran
    assert tr.state.pos["x"] == 100.0 and tr.state.pos["y"] == 100.0


def test_t1_g28_1_homes_nothing_and_a_later_unhomed_move_refuses():
    """T-1: the macro survives G28.1, so the stop — if any — comes from the
    NEXT line for the ordinary reason (Must home axis first), never from
    G28.1 itself."""
    st, _ = seed_state({})
    tr = _t(_VORON, [(1, "G28.1"), (2, "G1 X100")], st)
    text = _lines(tr)
    assert tr.state.homed == set()          # G28.1 homed nothing
    assert "L2" in text                     # it ran and was traced
    assert "L2: REFUSED" in text
    assert "Must home axis first: x" in text
    assert "L1: REFUSED" not in text        # the stop is not charged to L1
    assert tr.aborted is True


# ── T-4 (second pass): no fabricated state after a refusal ─────────────
# The module's own law (virtual printer): a refused line ABORTS — later lines
# never run and no state is invented for them. LED/heater/fan branches used
# to print the run-time failure and then keep going with a made-up value.

def test_t4_set_led_empty_component_refuses_and_stops():
    """T-4: SET_LED RED= is float('') -> Klipper error; trace must abort."""
    tr = _t(_VORON, [(1, "SET_LED LED=strip RED= GREEN=0 BLUE=0"),
                     (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "SET_LED" in text and "REFUSED" in text
    assert "unable to parse" in text
    assert "L2" not in text                 # nothing after a refused line
    assert "strip" not in tr.state.leds     # no fabricated rgb(0,0,0)


def test_t4_set_led_out_of_range_component_refuses_and_stops():
    """T-4: led.py:76-79 uses minval=0./maxval=1. -> RED=2 aborts, and the
    trace must not store rgb(2, 0, 0) as if the printer accepted it."""
    tr = _t(_VORON, [(1, "SET_LED LED=strip RED=2"), (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "RED=2" in text and "0\u20131" in text
    assert "REFUSED" in text
    assert "strip" not in tr.state.leds
    assert "L2" not in text


def test_t4_set_led_omitted_component_still_defaults_to_zero():
    """T-4 (guard against over-refusing): an ABSENT key takes get_float's
    0. default — that is modelled colour, not a fabrication."""
    tr = _t(_VORON, [(1, "SET_LED LED=strip RED=1 GREEN=0.2"),
                     (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is False
    assert tr.state.leds["strip"] == (1.0, 0.2, 0.0)
    assert "L2" in text


def test_t4_m104_empty_target_refuses_and_stops():
    """T-4: M104 S (empty) is gcmd.get_float('S', 0.) raising — the macro
    stops; later lines must not be traced as if they ran."""
    tr = _t(_VORON, [(1, "M104 S"), (2, "M106 S255")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "unable to parse" in text and "REFUSED" in text
    assert "extruder target" not in text    # no '?' target invented
    assert "fan speed" not in text          # the later fan line never ran
    assert "L2" not in text
    assert "Final state at refusal" in text


def test_t4_set_heater_temperature_empty_value_refuses_and_stops():
    """T-4: SET_HEATER_TEMPERATURE TARGET= raises in get_float.
    (Third-pass own review: the fetched parameter is TARGET, not
    TEMPERATURE — heaters.py:157.)"""
    tr = _t(_VORON, [(1, "SET_HEATER_TEMPERATURE HEATER=chamber "
                         "TARGET="),
                     (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "unable to parse" in text
    assert "chamber" not in tr.state.heaters
    assert "L2" not in text


def test_t4_set_heater_temperature_absent_target_is_zero_default():
    """T-4 (guard): heaters.py:157 defaults TARGET to 0. — absent is a real
    0-degree command, not an unparseable one."""
    tr = _t(_VORON, [(1, "SET_HEATER_TEMPERATURE HEATER=chamber"),
                     (2, "G90")])
    assert tr.aborted is False
    assert tr.state.heaters["chamber"] == 0.0
    assert "L2" in _lines(tr)


def test_t4_set_fan_speed_unparseable_and_negative_refuse():
    """T-4: SPEED= cannot parse; SPEED<0 fails get_float minval=0."""
    tr = _t(_VORON, [(1, "SET_FAN_SPEED FAN=myfan SPEED="), (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is True and "unable to parse" in text
    assert "myfan" not in tr.state.fans
    assert "L2" not in text
    tr = _t(_VORON, [(1, "SET_FAN_SPEED FAN=myfan SPEED=-0.5"),
                     (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "minimum of 0" in text
    assert "myfan" not in tr.state.fans
    assert "L2" not in text


def test_t4_set_fan_speed_above_one_is_clamped_not_refused():
    """T-4 (ground truth, both directions): fan_generic.py:34-42 only takes
    minval=0. for SPEED; fan.py _apply_speed clamps to max_power (1.0 by
    default) — SPEED=2 runs the fan at 100% and the macro continues. Saying
    'Klipper refuses' would over-claim an abort that never happens."""
    tr = _t(_VORON, [(1, "SET_FAN_SPEED FAN=myfan SPEED=2"), (2, "G90")])
    text = _lines(tr)
    assert tr.aborted is False
    assert tr.state.fans["myfan"] == 100.0
    assert "clamps" in text and "max_power" in text
    assert "L2" in text


# ── T-5 (second pass): CLEAR_HOMED / CLEAR un-home axes ────────────────
# force_move.py:127-137 reads SET_HOMED (default 'xyz'), calls
# toolhead.set_position(..., homing_axes=set_homed_axes) and then
# clear_homing_state(clear_homed_axes) — so CLEAR_HOMED wins over SET_HOMED
# for the same axis. CLEAR is its alias.

def test_t5_clear_homed_unhomes_and_the_next_move_refuses():
    """T-5: SET_KINEMATIC_POSITION ... CLEAR_HOMED=xyz leaves NOTHING homed,
    so the following G1 must refuse (Must home axis first)."""
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=10 Y=10 Z=14.5 "
                         "CLEAR_HOMED=xyz"),
                     (2, "G1 X50 Y50 F3000")])
    text = _lines(tr)
    note = next(ln for ln in tr.lines if ln.startswith("L1:"))
    assert "cleared homed X Y Z" in note
    assert tr.state.homed == set()
    assert tr.aborted is True
    assert "L2: REFUSED" in text
    assert "Must home axis first: x y" in text
    final = next(ln for ln in tr.lines if ln.startswith("Final state"))
    assert "homed \u2014" in final          # homed none


def test_t5_clear_alias_and_partial_axis_sets():
    """T-5: CLEAR=z is the alias (force_move.py:127-131) and only names the
    axes it lists — SET_HOMED's 'xyz' default still homes x and y."""
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=10 Y=10 Z=14.5 "
                         "CLEAR=z")])
    note = next(ln for ln in tr.lines if ln.startswith("L1:"))
    assert "cleared homed Z" in note
    assert tr.state.homed == {"x", "y"}


def test_t5_empty_clear_homed_clears_nothing():
    """T-5: CLEAR_HOMED= (present, empty) clears no axis, exactly like the
    '' that gcmd.get('CLEAR_HOMED', '') returns there."""
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=10 CLEAR_HOMED="),
                     (2, "G1 Y100")])
    assert tr.state.homed == {"x", "y", "z"}
    assert tr.aborted is False
    assert tr.state.pos["y"] == 100.0


def test_t5_clear_homed_wins_over_set_homed_for_the_same_axis():
    """T-5: clear_homing_state runs AFTER set_position, so an axis named in
    both ends up NOT homed."""
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION SET_HOMED=xy "
                         "CLEAR_HOMED=xy"),
                     (2, "G1 X5")])
    text = _lines(tr)
    assert tr.state.homed == set()
    assert tr.aborted is True
    assert "Must home axis first: x" in text
