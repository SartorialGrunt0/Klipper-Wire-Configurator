"""add_section must NOT refuse a type token that has a real module in the
bundled Klipper reference (PR #36 round-1 review, A-L1).

The gate (2026-10-07) refuses NEW sections whose type token is unknown to
KWC's curated schema, because klippy resolves a type token to the module
FILE ``extras/<token>.py``. But the curated schema (156 types) is narrower
than Klipper's module set: ``sht3x``, ``aht10``, and ``print_stats`` all have
real modules under reference/klipper/klippy/extras/ and load fine — the gate
hard-erroring them over-blocks legitimate config work, while the validator's
own convention for an unknown type is an acknowledgeable WARNING.

The law these tests pin: refuse a new token only when it has NO schema entry
AND NO ``extras/<token>.py`` in the bundled reference. The original bug shape
(``[bed_mesh_calibrate]`` — a gcode command name, no module file) stays
refused.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.ai_draft_project import ProjectState  # noqa: E402


BASE_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100
"""


def _state(text=BASE_CFG):
    st = ProjectState.from_context_files({'printer.cfg': {'content': text}})
    return st, st.validate()


def _add(section, text=''):
    st, base = _state()
    return st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                           'section': section, 'text': text})


# ── tokens with a real module in the bundled reference must stage ──────


# Staged = applied: 'ok', or 'applied_with_advisory' when the validator's
# acknowledgeable unknown_section warning rode along (its documented tier).
STAGED = {'ok', 'applied_with_advisory'}


def test_real_extras_sensor_token_stages():
    st1, r = _add('sht3x my_chamber', 'sensor_type: sht3x')
    assert r['status'] in STAGED, r
    assert '[sht3x my_chamber]' in st1.files['printer.cfg']


def test_aht10_token_stages():
    _, r = _add('aht10 my_sensor')
    assert r['status'] in STAGED, r


def test_builtin_module_token_stages():
    _, r = _add('print_stats')
    assert r['status'] in STAGED, r


# ── the original bug shape stays refused ───────────────────────────────


def test_gcode_command_name_header_still_refused():
    st1, r = _add('bed_mesh_calibrate', 'speed: 50')
    assert r['status'] == 'error', r
    assert 'bed_mesh_calibrate' not in st1.files['printer.cfg']


def test_total_nonsense_token_still_refused():
    _, r = _add('zzq_not_a_module')
    assert r['status'] == 'error', r


def test_path_shaped_token_still_refused():
    # A token shaped like a traversal must be refused by the name check and
    # never reach the filesystem probe as a relative escape.
    _, r = _add('../../../etc/passwd')
    assert r['status'] == 'error', r
