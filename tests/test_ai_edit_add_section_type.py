"""add_section must refuse a NEW section whose TYPE token is not a known
Klipper section type and does not already exist in the project.

Bug (2026-10-07): an AI chat edit op created ``[bed_mesh_calibrate]`` — a
gcode COMMAND name used as a section header. Klipper resolves a section's
type token to a module FILENAME (``extras/<token>.py``), so a bare
unrecognized token can never load; the validator only *warns* about it (a
genuine plugin section is KWC's documented blind spot), so the add op
staged a config that cannot start.

Only NEW unrecognized TOKENS are refused on the add path:
  * a known type — including a NAMED-family header like
    ``verify_heater extruder`` or ``gcode_macro PARK`` — stays legal;
  * an unrecognized token that ALREADY EXISTS in the project (a plugin
    section the config already uses) stays legal;
  * editing an EXISTING section (set_param/replace_section/…) is untouched;
  * a KNOWN type in the WRONG CASE keeps its existing ``section_type_case``
    refusal (the validator owns that message).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.ai_draft_project import ProjectState  # noqa: E402
from services.ai_edit_tools import EditSession  # noqa: E402


BASE_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100

[bed_mesh]
speed: 50
horizontal_move_z: 5
mesh_min: 10, 10
mesh_max: 190, 190
probe_count: 5, 5
"""


def _state(text=BASE_CFG):
    st = ProjectState.from_context_files({'printer.cfg': {'content': text}})
    return st, st.validate()


# ── the bug: a gcode COMMAND name used as a section header ─────────────


def test_add_section_unknown_bare_type_is_rejected_with_suggestion():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'bed_mesh_calibrate',
                             'text': 'speed: 50'})
    assert r['status'] == 'error', r
    err = r['error']
    assert 'bed_mesh_calibrate' in err
    assert 'not a known section type' in err
    # closest known section type is offered so the model can self-correct
    assert 'bed_mesh' in err
    assert 'If you meant the [bed_mesh] section' in err
    # nothing was written into the working state
    assert '[bed_mesh_calibrate]' not in st1.files['printer.cfg']
    assert st1.files == st.files


def test_unknown_type_rejection_goes_through_edit_session():
    """The op-time refusal must be visible to the agent loop: no pending
    edit, an error string naming the token."""
    session = EditSession({'printer.cfg': {'content': BASE_CFG}})
    content, details = session.execute({'name': 'config_edit', 'arguments': {
        'file': 'printer.cfg', 'op': 'add_section',
        'section': 'bed_mesh_calibrate', 'text': 'speed: 50'}})
    assert details is None, content
    assert session.pending_edits == []
    assert 'bed_mesh_calibrate' in content
    assert 'bed_mesh' in content


# ── legitimate section adds keep working ───────────────────────────────


def test_add_section_known_bare_type_still_created():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'idle_timeout', 'text': 'timeout: 600'})
    assert r['status'] == 'applied', r
    assert '[idle_timeout]' in st1.files['printer.cfg']


def test_add_section_named_family_type_still_created():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'gcode_macro PARK',
                             'text': 'gcode:\n    G28'})
    assert r['status'] == 'applied', r
    assert '[gcode_macro PARK]' in st1.files['printer.cfg']


def test_add_section_type_already_used_elsewhere_in_project_is_allowed():
    """A plugin/custom section the project ALREADY uses is not the bug —
    an unknown token that already exists stays legal."""
    st = ProjectState.from_context_files({
        'printer.cfg': {'content': BASE_CFG},
        'plugin.cfg': {'content': '[my_plugin_thing]\nfoo: 1\n'},
    })
    base = st.validate()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'my_plugin_thing', 'text': 'foo: 2'})
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert '[my_plugin_thing]' in st1.files['printer.cfg']


# ── editing an EXISTING unrecognized section stays legal ───────────────


def test_editing_existing_unknown_section_stays_legal():
    st = ProjectState.from_context_files({
        'printer.cfg': {'content': BASE_CFG + '\n[my_plugin_thing]\nfoo: 1\n'},
    })
    base = st.validate()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'my_plugin_thing',
                             'key': 'foo', 'value': '2'})
    assert r['status'] == 'applied', r
    assert 'foo: 2' in st1.files['printer.cfg']


# ── a mis-cased KNOWN type keeps its existing refusal ──────────────────


def test_miscased_known_type_still_refused_as_case():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'Idle_Timeout', 'text': 'timeout: 600'})
    assert r['status'] == 'error', r
    assert any('case-sensitive' in e['message'] for e in r['newErrors'])
    assert '[Idle_Timeout]' not in st1.files['printer.cfg']
