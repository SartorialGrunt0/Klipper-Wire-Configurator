"""Motion trace over RENDERED macro lines (P1 of the simulate trace).

Design law (Sir, 2026-11-18 — "front center lands at center" dogfood):
syntax-correct macros can still DO the wrong thing; the model needs to
watch the printer's state change line by line to catch it.

Contract under test:
  * Rendering stays Klipper-true: Jinja sees the invocation-time position
    (reference/klipper gcode_move renders the whole body before any line
    runs). The trace is EXECUTION-LEVEL: it runs over the rendered lines
    only, never touches the render.
  * Never guess: no fabricated bounds/home unless declared in the project;
    an unresolved coordinate makes the position unresolved, never invented.
  * A refused line aborts — same law as _SIM_LIMITS (virtual printer
    2026-11-15): un-homed move and soft-limit violation stop the trace.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import mcp_server  # noqa: E402
from mcp_server import McpServer  # noqa: E402
from parser.macro_trace import (  # noqa: E402
    derive_motion_profile, seed_state, trace_motion)


# ── machine profile derivation (frontend createMachineProfile parity) ──

_VORON = """
[printer]
kinematics: corexy
max_velocity: 300
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

_SLINGER = """
[printer]
kinematics: cartesian
[stepper_x]
position_endstop: 0
position_max: 235
[stepper_y]
position_endstop: 0
position_max: 235
[stepper_z]
position_endstop: 0
position_max: 250
"""

_DELTA = """
[printer]
kinematics: delta
print_radius: 130
[stepper_a]
position_endstop: 320
[stepper_z]
position_endstop: 320
position_max: 320
position_min: -5
"""


def test_cartesian_profile_bounds_and_home_from_steppers():
    p = derive_motion_profile([_VORON])
    assert p.bounds["x"] == (0.0, 250.0)
    assert p.bounds["y"] == (0.0, 250.0)
    assert p.bounds["z"] == (-5.0, 250.0)
    assert p.home == {"x": 250.0, "y": 250.0, "z": 0.0}
    assert p.radius is None


def test_slinger_home_is_the_min_corner():
    p = derive_motion_profile([_SLINGER])
    assert p.home == {"x": 0.0, "y": 0.0, "z": 0.0}


def test_delta_profile_is_round():
    p = derive_motion_profile([_DELTA])
    assert p.radius == 130.0
    assert p.bounds["x"] == (-130.0, 130.0)
    assert p.home["x"] == 0.0 and p.home["y"] == 0.0


def test_no_steppers_never_invents_bounds():
    p = derive_motion_profile(["[printer]\nkinematics: cartesian\n"])
    assert p.bounds == {}
    assert p.home == {}


def test_partial_stepper_data_never_invents_partial_bounds():
    # xmax without ymax: a wrong box is worse than silence.
    p = derive_motion_profile(
        ["[printer]\nkinematics: cartesian\n[stepper_x]\nposition_max: 200\n"])
    assert p.bounds == {}


# ── seeding from scenario printer_state ─────────────────────────────────

def test_seed_reads_dotted_coord_and_homed_axes():
    st, notes = seed_state({"toolhead.position": [10.5, 20.25, 3.1],
                            "gcode_move.homed_axes": "xyz"})
    assert st.pos["x"] == 10.5 and st.pos["y"] == 20.25
    assert st.homed == {"x", "y", "z"}


def test_seed_nested_shape_supported():
    st, notes = seed_state({"toolhead": {"position": [1, 2, 3, 0]}})
    assert st.pos["z"] == 3.0
    # position declared ⇒ the caller asserts the machine knows it is here
    assert st.homed == {"x", "y", "z"}


def test_seed_cold_start_is_not_homed():
    st, notes = seed_state({})
    assert st.pos == {"x": None, "y": None, "z": None, "e": None}
    assert st.homed == set()


# ── interpreter: moves, modes, homing ───────────────────────────────────

def _t(cfg, lines, state=None):
    """Trace rendered (src_line, text) pairs against cfg."""
    profile = derive_motion_profile([cfg]) if cfg else derive_motion_profile([])
    if state is None:
        state, _ = seed_state({})
    return trace_motion(lines, profile, state)


def _lines(tr):
    return "\n".join(tr.lines)


def test_g28_lands_on_the_declared_endstop():
    tr = _t(_VORON, [(1, "G28")])
    assert "L1: G28" in _lines(tr)
    assert tr.state.pos["x"] == 250.0
    assert tr.state.pos["y"] == 250.0
    assert tr.state.homed == {"x", "y", "z"}


def test_move_annotates_centre_and_front_edge():
    st, _ = seed_state({"toolhead.position": [250, 250, 0],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_VORON, [(2, "G1 X125 Y5 F6000")], st)
    text = _lines(tr)
    assert tr.state.pos == {"x": 125.0, "y": 5.0, "z": 0.0, "e": 0.0}
    assert "centre" in text          # 125 is dead centre of 0-250
    assert "front" in text           # 5 is at the Y-min edge


def test_move_off_centre_reports_fraction():
    st, _ = seed_state({"toolhead.position": [0, 0, 0],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(3, "G1 X47 Y0")], st)
    text = _lines(tr)
    assert "20%" in text             # 47 of 235
    assert "front" in text           # Y0 is the front edge


def test_unhomed_move_is_refused_and_aborts():
    tr = _t(_SLINGER, [(1, "G1 X10 Y10"), (2, "M117 never runs")])
    text = _lines(tr)
    assert tr.aborted is True
    assert "REFUSED" in text
    assert "Must home axis first" in text
    assert "never runs" not in text  # abort means later lines do not trace
    assert "ABORTED" in text


def test_e_only_move_needs_no_homing():
    st, _ = seed_state({})
    tr = _t(_SLINGER, [(1, "G1 E-0.8 F1200")], st)
    assert tr.aborted is False
    assert tr.state.pos["e"] == -0.8


def test_soft_limit_violation_refuses_with_numbers():
    st, _ = seed_state({"toolhead.position": [0, 0, 0],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(4, "G1 Y240")], st)
    text = _lines(tr)
    assert tr.aborted is True
    assert "soft limit" in text
    assert "240" in text and "235" in text


def test_delta_radius_violation_refuses():
    st, _ = seed_state({"toolhead.position": [0, 0, 100],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_DELTA, [(2, "G1 X120 Y120")], st)  # hypot ≈ 169.7 > 130
    assert tr.aborted is True
    assert "radius" in _lines(tr)


def test_g91_relative_then_g90_absolute():
    st, _ = seed_state({"toolhead.position": [100, 100, 5],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(1, "G91"), (2, "G1 X10 Y-20"), (3, "G90"),
                       (4, "G1 X30")], st)
    assert tr.state.pos["x"] == 30.0
    assert tr.state.pos["y"] == 80.0


def test_g92_sets_position_like_klipper():
    st, _ = seed_state({"toolhead.position": [10, 10, 10],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(1, "G92 Z0.3")], st)
    assert tr.state.pos["z"] == 0.3
    assert tr.state.pos["x"] == 10.0  # untouched axes stay


def test_g28x_homes_only_x():
    st, _ = seed_state({"toolhead.position": [0, 0, 0],
                        "gcode_move.homed_axes": "y"})
    tr = _t(_SLINGER, [(1, "G28 X")], st)
    assert tr.state.homed == {"x", "y"}
    assert tr.state.pos["x"] == 0.0


def test_set_kinematic_position_marks_homed_at_values():
    st, _ = seed_state({})
    tr = _t(_VORON, [(1, "SET_KINEMATIC_POSITION X=250 Y=250 Z=0"),
                     (2, "G1 X100")], st)
    assert tr.aborted is False  # SET_KINEMATIC_POSITION made it legal
    assert tr.state.pos["x"] == 100.0


def test_g28_1_is_unknown_and_stops_the_trace():
    # PR #43 review A-F6 — INTENTIONAL FLIP of the old pin ("G28.1 marks
    # homed without moving"). klippy registers only G28
    # (extras/homing.py:306) and keeps the dotted suffix as the dispatch
    # token (gcode.py:210-215), so "G28.1" reaches cmd_default: "Unknown
    # command", and the macro ABORTS. The old pin encoded a command that
    # does not exist.
    # Cold seed on purpose: a declared position auto-homes in seed_state,
    # which would mask whether G28.1 homed anything by itself.
    st, _ = seed_state({})
    tr = _t(_SLINGER, [(1, "G28.1"), (2, "G1 X10 Y10")], st)
    text = _lines(tr)
    assert tr.aborted is True
    assert "Unknown command" in text
    assert tr.state.homed == set()
    assert "L2" not in text


def test_unknown_coordinate_unresolves_never_invents():
    st, _ = seed_state({"toolhead.position": [0, 0, 0],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(5, "G1 X<unknown> Y20")], st)
    assert tr.aborted is False
    assert tr.state.pos["x"] is None
    assert tr.state.pos["y"] == 20.0
    assert "unresolved" in _lines(tr)


def test_probe_makes_z_unresolved_with_note():
    st, _ = seed_state({"toolhead.position": [100, 100, 5],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(1, "PROBE"), (2, "G1 Z2")], st)
    text = _lines(tr)
    assert "not modelled" in text
    # PROBE unresolved Z; the later ABSOLUTE G1 Z2 re-resolves it to 2.0
    assert tr.state.pos["z"] == 2.0


def test_final_state_line_reports_position_and_annotations():
    st, _ = seed_state({"toolhead.position": [0, 235, 5],
                        "gcode_move.homed_axes": "xyz"})
    tr = _t(_SLINGER, [(1, "G1 X0 Y5")], st)
    text = _lines(tr)
    final = next(ln for ln in tr.lines if "Final state:" in ln)
    assert "front" in final          # Y=5 after the move
    assert "back" in text            # the Start line shows Y=235 = back edge


# ── tool integration: output block, multipath, sequence threading ───────

_TRACE_CFG = """
[printer]
kinematics: corexy
[stepper_x]
position_endstop: 200
position_max: 200
[stepper_y]
position_endstop: 200
position_max: 200
[stepper_z]
position_endstop: 0
position_max: 200

[gcode_macro PARK_FRONT]
gcode:
    G28
    G1 X100 Y2 F3000

[gcode_macro BRANCHY]
gcode:
    {% if printer.toolhead.homed_axes == 'xyz' %}
    G1 X10
    {% else %}
    G1 Y10
    {% endif %}
"""


def _call(monkeypatch, **args):
    monkeypatch.setattr(mcp_server, "_working_scan_items",
                        lambda: [("printer.cfg", _TRACE_CFG)])
    return McpServer()._handle_simulate_macro(args)


def test_tool_output_contains_execution_trace(monkeypatch):
    out = _call(monkeypatch, macro="PARK_FRONT")
    assert "Execution trace" in out
    assert "Final state:" in out
    assert "centre" in out          # X=100 of 0-200
    assert "front" in out           # Y=2 at the Y-min edge


def test_multipath_skips_trace_honestly(monkeypatch):
    out = _call(monkeypatch, macro="BRANCHY")
    assert "Execution trace (" not in out   # no executed trace block
    assert "Execution trace skipped: 2 render paths" in out


def test_runs_threads_position_between_calls(monkeypatch):
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [(
        "printer.cfg",
        _TRACE_CFG + "\n[gcode_macro NUDGE]\ngcode:\n    G91\n"
                     "    G1 X-10\n    G90\n")])
    out = McpServer()._handle_simulate_macro(
        {"macro": "NUDGE", "runs": 2,
         "printer_state": {"toolhead.position": [200, 200, 0],
                           "gcode_move.homed_axes": "xyz"}})
    assert "carried from call 1" in out
    assert "190" in out and "180" in out   # 200→190→180 across the two calls


# ── P2: heater/fan/LED targets — commanded before → after ──────────────
# Laws inherited from the plan (.hermes/plans/2026-11-17_macro-simulation-
# chat-card.md): D2 targets-and-commanded-values-only, NEVER a current
# temperature; D3 an undeclared before-value stays "—", never 0.
# SET_LED semantics pinned to reference/klipper led.py cmd_SET_LED: every
# component defaults to 0 — SET_LED overwrites the whole colour (ablation
# C7 confirmed this is what both engines agree on).

def _tr(body, printer_state=None, profile=None):
    seed, _notes = seed_state(printer_state or {})
    return trace_motion(list(enumerate(body, 1)),
                        profile or derive_motion_profile([_VORON]), seed)


def test_heater_target_before_after_uses_dash_not_zero():
    text = "\n".join(_tr(["M104 S215"]).lines)
    assert "extruder target \u2014 \u2192 215\u00b0C" in text
    # D3: an undeclared before-value must never read as 0
    assert "0 \u2192 215" not in text and "0\u00b0C" not in text


def test_seeded_heater_target_shows_declared_before():
    text = "\n".join(_tr(["M104 S215"],
                          {"extruder.target": 180}).lines)
    assert "extruder target 180\u00b0C \u2192 215\u00b0C" in text
    assert "targets: extruder 180\u00b0C" in text  # Start line declares seed


def test_m109_m140_m190_set_targets_too():
    text = "\n".join(_tr(["M109 S205", "M140 S60", "M190"]).lines)
    assert "extruder target \u2014 \u2192 205\u00b0C" in text
    assert "heater_bed target \u2014 \u2192 60\u00b0C" in text
    assert "heater_bed target already 60\u00b0C" in text  # M190 with no S
    # D2: the trace never claims a current temperature or heating progress
    assert "current" not in text.lower()


def test_set_heater_temperature_generic_heater():
    text = "\n".join(
        _tr(["SET_HEATER_TEMPERATURE HEATER=chamber TEMPERATURE=45"]).lines)
    assert "chamber target \u2014 \u2192 45\u00b0C" in text


def test_turn_off_heaters_zeroes_known_targets_only():
    text = "\n".join(_tr(["M104 S200", "M140 S60", "TURN_OFF_HEATERS"]).lines)
    assert "extruder target 200\u00b0C \u2192 0\u00b0C" in text
    assert "heater_bed target 60\u00b0C \u2192 0\u00b0C" in text
    assert "targets: extruder 0\u00b0C heater_bed 0\u00b0C" in text


def test_fan_m106_m107_percent():
    text = "\n".join(_tr(["M106 S128", "M107"]).lines)
    assert "fan speed \u2014 \u2192 50.2%" in text
    assert "fan speed 50.2% \u2192 0%" in text
    text2 = "\n".join(_tr(["M106"]).lines)      # bare M106 = S255
    assert "fan speed \u2014 \u2192 100%" in text2


def test_set_fan_speed_ratio_and_out_of_range():
    text = "\n".join(_tr(["SET_FAN_SPEED FAN=myfan SPEED=0.75"]).lines)
    assert "myfan speed \u2014 \u2192 75%" in text
    text = "\n".join(_tr(["SET_FAN_SPEED FAN=myfan SPEED=2",
                           "G90"]).lines)
    assert "myfan speed \u2014 \u2192 ?" in text and "0\u20131" in text
    # unresolved fan does not abort the trace
    assert "Final state" in text and "ABORTED" not in text


def test_set_led_overwrites_omitted_components_zero():
    text = "\n".join(_tr(["SET_LED LED=strip RED=1 GREEN=0.2"]).lines)
    assert "led strip \u2014 \u2192 rgb(1, 0.2, 0)" in text
    text = "\n".join(_tr(["SET_LED LED=strip WHITE=0.5"]).lines)
    assert "rgbw(0, 0, 0, 0.5)" in text


def test_led_effect_set_stop_and_stop_all():
    text = "\n".join(_tr(["SET_LED_EFFECT LED=strip EFFECT=breathing",
                           "SET_LED_EFFECT LED=strip STOP=1"]).lines)
    assert "led strip \u2014 \u2192 effect breathing" in text
    assert "led strip effect breathing \u2192 stopped" in text
    text = "\n".join(_tr(["SET_LED LED=x RED=1",
                          "STOP_LED_EFFECTS"]).lines)
    # Klipper law: STOP_LED_EFFECTS stops EFFECTS — a static SET_LED
    # colour is not an effect and survives the command.
    assert "static colours are NOT turned off" in text


def test_target_that_did_not_render_is_unresolved_not_refused():
    text = "\n".join(_tr(["M104 S", "M106 S255"]).lines)
    assert "extruder target \u2014 \u2192 ?" in text
    assert "unable to parse" in text          # the run-time risk, said aloud
    assert "ABORTED" not in text              # parse law, not motion law
    assert "fan speed" in text                # later lines still traced


def test_final_state_lists_targets_fans_leds():
    body = ["G28", "M104 S215", "SET_FAN_SPEED FAN=part SPEED=1",
            "SET_LED LED=st RED=0 GREEN=1 BLUE=0"]
    final = [ln for ln in _tr(body).lines if ln.startswith("Final state")][0]
    assert "targets: extruder 215\u00b0C" in final
    assert "fans: part 100%" in final
    assert "leds: st rgb(0, 1, 0)" in final


def test_runs_threads_targets_between_calls(monkeypatch):
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [(
        "printer.cfg",
        _TRACE_CFG + "\n[gcode_macro WARMER]\ngcode:\n"
                     "    M104 S215\n    M106 S128\n")])
    out = McpServer()._handle_simulate_macro(
        {"macro": "WARMER", "runs": 2})
    # The render stays static (Klipper law) — threading is EXECUTION
    # level: call 2's trace Start line carries call 1's targets.
    assert "carried from call 1" in out
    starts = [ln for ln in out.splitlines() if "carried from call 1" in ln]
    assert any("targets: extruder 215\u00b0C" in s and "fans: fan 50.2%"
               in s for s in starts)


def test_skill_body_and_chat_description_pin_the_trace_law():
    from api.ai_routes import _MCP_TOOL_SNIPPETS, _macro_skill_body
    assert "Execution trace" in _MCP_TOOL_SNIPPETS["simulate_macro"]
    assert "Final state" in _macro_skill_body()
