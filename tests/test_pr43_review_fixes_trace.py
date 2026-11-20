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


# ── A-F6: G28.1 does not exist in Klipper ───────────────────────────────

def test_g28_1_is_unknown_command_and_stops_the_trace():
    # cold start: seeding a position auto-homes (seed_state law), so only a
    # cold seed can show whether G28.1 homed anything by itself.
    st, _ = seed_state({})
    tr = _t(_VORON, [(1, "G28.1"), (2, "G1 X100 Y100")], st)
    text = _lines(tr)
    # Klipper: G28.1 falls through to cmd_default -> "Unknown command"
    assert tr.aborted is True
    assert "Unknown command" in text and "G28.1" in text
    # the phantom homing is gone: nothing became homed, nothing moved
    assert tr.state.homed == set()
    assert tr.state.pos["x"] is None
    # a rejected line ABORTS: the following move never runs
    assert "L2" not in text
    assert "ABORTED" in text


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
