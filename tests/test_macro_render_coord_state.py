"""Declared position state must render like Klipper's gcode.Coord.

Ground truth (reference/klipper, Aug-2026 checkout):
  klippy/gcode.py:12-21        class Coord(tuple) with x/y/z/e itemgetter
                               properties; len<4 pads with 0.
  klippy/toolhead.py:512       status 'position' = Coord(commanded_pos)
  klippy/extras/gcode_move.py:110-112  homing_origin / position /
                               gcode_position = Coord(...)

MACRO-14 r3 (2026-11-15 bank run): the model declared
{"toolhead.position": [10.5, 20.25, 3.1]} — Moonraker-JSON shape — and our
scenario overlay stored the raw list, so {pos.x} rendered EMPTY while real
Klipper renders 10.5. The simulator manufactured a defect and the model
"fixed" a non-bug. Declared values at the Coord status paths must answer
attribute access exactly like Klipper.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.macro_render import simulate_macro  # noqa: E402


def _texts(result):
    return [r.text for r in result.rendered]


def test_declared_position_dot_access_matches_klipper():
    body = 'RESPOND TYPE=echo MSG="X is {printer.toolhead.position.x} mm"'
    result = simulate_macro(
        body, printer_state={"toolhead.position": [10.5, 20.25, 3.1]})
    assert _texts(result) == ['RESPOND TYPE=echo MSG="X is 10.5 mm"']
    assert result.findings == []


def test_declared_position_index_access_still_works():
    body = 'RESPOND TYPE=echo MSG="X is {printer.toolhead.position[0]} mm"'
    result = simulate_macro(
        body, printer_state={"toolhead.position": [10.5, 20.25, 3.1]})
    assert _texts(result) == ['RESPOND TYPE=echo MSG="X is 10.5 mm"']


def test_declared_position_pads_short_lists_like_klipper():
    # Klipper Coord: if len(t) < 4: t = tuple(t) + (0,) * (4 - len(t))
    body = ('{% set pos = printer.toolhead.position %}\n'
            'RESPOND TYPE=echo MSG="Z={pos.z} E={pos.e}"')
    result = simulate_macro(body, printer_state={"toolhead.position": [1.0]})
    assert _texts(result) == ["RESPOND TYPE=echo MSG=\"Z=0 E=0\""]


def test_declared_position_is_iterable_like_klipper():
    body = '{% for v in printer.toolhead.position %}{ v };{% endfor %}'
    result = simulate_macro(
        body, printer_state={"toolhead.position": [1.5, 2.5, 3.5, 4.5]})
    assert _texts(result) == ["1.5;2.5;3.5;4.5;"]


def test_gcode_move_coord_paths_normalize():
    body = ('A{printer.gcode_move.gcode_position.y}'
            'B{printer.gcode_move.position.x}')
    result = simulate_macro(body, printer_state={
        "gcode_move.gcode_position": [0.0, 7.25, 0.0, 0.0],
        "gcode_move.position": [1.0, 2.0, 3.0, 4.0],
    })
    assert _texts(result) == ["A7.25B1.0"]


def test_non_position_state_untouched():
    # A raw scalar stays a scalar; no Coord magic on unrelated paths.
    body = 'M104 S{printer.extruder.target}'
    result = simulate_macro(body, printer_state={"extruder.target": 195})
    assert _texts(result) == ["M104 S195"]


def test_undeclared_position_still_unknown_sentinel():
    # No scenario declared: the default UNKNOWN chain answers, unchanged.
    body = 'RESPOND TYPE=echo MSG="X is {printer.toolhead.position.x} mm"'
    result = simulate_macro(body)
    assert _texts(result) == ['RESPOND TYPE=echo MSG="X is <unknown> mm"']


def test_declared_position_comparisons_evaluate_natively():
    body = ('{% if printer.toolhead.position.x > 100 %}HOMED_NEAR_END'
            '{% else %}MID{% endif %}')
    result = simulate_macro(
        body, printer_state={"toolhead.position": [105.0, 0.0, 0.0, 0.0]})
    assert _texts(result) == ["HOMED_NEAR_END"]
