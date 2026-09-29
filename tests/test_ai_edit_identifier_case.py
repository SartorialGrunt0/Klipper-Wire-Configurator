"""Case-insensitive identifier resolution on the EDIT side (2026-09-28).

The read side has always resolved filenames and section headers
case-insensitively (`mcp_server._resolve_user_config_file` compares
`.lower()`, `_locate_config_section` documents an exact case-insensitive
full-header match). The edit side did not: `_require_file` was an exact
dict lookup and `_resolve_section_ref` returned any spaced request
unchanged, so `config_edit ... file='Printer.cfg'` hard-failed while
`read_user_config(filename='Printer.cfg')` worked.

Identifiers are not content. Resolving must always land on the project's
REAL spelling so a mis-cased request edits the existing file/section
instead of creating a case-variant duplicate — and ambiguity must never be
guessed through.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.ai_draft_project import (  # noqa: E402
    _resolve_file_ref,
    _resolve_section_ref,
)
from services.ai_edit_tools import EditSession  # noqa: E402

PRINTER_CFG = """[printer]
kinematics: corexy
max_velocity: 300
max_accel: 3000

[stepper_x]
step_pin: PF13
rotation_distance: 40

[gcode_macro Level_Bed]
gcode:
    G28
    BED_MESH_CALIBRATE
"""

AUX_FAN_CFG = """[fan_generic Aux_Fan]
pin: PB3
"""


def _ctx():
    return {'printer.cfg': {'content': PRINTER_CFG},
            'aux_fan.cfg': {'content': AUX_FAN_CFG}}


def _edit(session, **args):
    args.setdefault('op', 'set_param')
    return session.execute({'name': 'config_edit', 'arguments': args})


# ── _resolve_file_ref ──────────────────────────────────────────────────


def test_file_ref_exact_key_is_identity():
    files = {'printer.cfg': '', 'aux_fan.cfg': ''}
    assert _resolve_file_ref('printer.cfg', files) == 'printer.cfg'


def test_file_ref_resolves_case_and_returns_the_real_spelling():
    files = {'printer.cfg': '', 'aux_fan.cfg': ''}
    assert _resolve_file_ref('Printer.cfg', files) == 'printer.cfg'
    assert _resolve_file_ref('PRINTER.CFG', files) == 'printer.cfg'
    assert _resolve_file_ref('Aux_Fan.cfg', files) == 'aux_fan.cfg'


def test_file_ref_resolves_by_basename_when_path_qualified():
    files = {'configs/printer.cfg': '', 'printer.cfg': ''}
    # Unique basename ('other.cfg' does not exist) -> no guess needed.
    files = {'configs/my_extra.cfg': '', 'printer.cfg': ''}
    assert _resolve_file_ref('configs/MY_EXTRA.CFG', files) == 'configs/my_extra.cfg'
    assert _resolve_file_ref('my_extra.cfg', files) == 'configs/my_extra.cfg'


def test_file_ref_never_guesses_a_case_collision():
    # Two project keys differing only by case: refuse rather than pick.
    files = {'printer.cfg': '', 'Printer.cfg': ''}
    assert _resolve_file_ref('PRINTER.CFG', files) is None


def test_file_ref_absent_returns_none():
    assert _resolve_file_ref('nope.cfg', {'printer.cfg': ''}) is None


# ── _resolve_section_ref ───────────────────────────────────────────────


def test_section_ref_exact_header_still_wins():
    lines = PRINTER_CFG.split('\n')
    assert _resolve_section_ref('printer', lines) == 'printer'
    assert _resolve_section_ref('gcode_macro Level_Bed', lines) == 'gcode_macro Level_Bed'


def test_section_ref_resolves_full_header_case():
    # The gap: a spaced request used to be returned unchanged, so a
    # case-only mismatch hard-failed.
    lines = PRINTER_CFG.split('\n')
    assert _resolve_section_ref('Gcode_Macro level_bed', lines) == 'gcode_macro Level_Bed'
    assert _resolve_section_ref('PRINTER', lines) == 'printer'
    assert _resolve_section_ref('Stepper_X', lines) == 'stepper_x'


def test_section_ref_bare_name_behaviour_is_unchanged():
    lines = PRINTER_CFG.split('\n')
    assert _resolve_section_ref('Level_Bed', lines) == 'gcode_macro Level_Bed'
    assert _resolve_section_ref('level_bed', lines) == 'gcode_macro Level_Bed'


def test_section_ref_absent_is_returned_unchanged():
    lines = PRINTER_CFG.split('\n')
    assert _resolve_section_ref('nope_section', lines) == 'nope_section'
    assert _resolve_section_ref('gcode_macro Nope', lines) == 'gcode_macro Nope'


def test_section_ref_ambiguous_bare_name_is_not_guessed():
    lines = ['[gcode_macro Level_Bed]', '[gcode_macro level_bed]', '']
    # Two family headers share the name part -> unchanged, so the caller's
    # ambiguity hint fires and names both.
    assert _resolve_section_ref('LEVEL_BED', lines) == 'LEVEL_BED'


# ── end-to-end through EditSession ─────────────────────────────────────


def test_wrong_case_file_and_section_stage_on_the_real_targets():
    session = EditSession(_ctx())
    content, details = _edit(session, file='Printer.cfg', section='PRINTER',
                             key='max_accel', value='4000')
    assert details is not None, content
    payload = session.pending_edits_payload()
    assert len(payload) == 1
    assert payload[0]['file'] == 'printer.cfg'        # real key, not the request
    assert 'max_accel: 4000' in payload[0]['newText']
    assert '[printer]' in payload[0]['newText']


def test_wrong_case_macro_header_resolves_and_stages():
    session = EditSession(_ctx())
    content, details = _edit(session, file='printer.cfg',
                             section='Gcode_Macro level_bed',
                             key='description', value='Levels the bed')
    assert details is not None, content
    payload = session.pending_edits_payload()
    assert payload[0]['file'] == 'printer.cfg'
    assert 'description: Levels the bed' in payload[0]['newText']


def test_wrong_case_file_alone_does_not_create_a_variant():
    session = EditSession(_ctx())
    _edit(session, file='AUX_FAN.cfg', section='fan_generic Aux_Fan',
          key='pin', value='PB9')
    payload = session.pending_edits_payload()
    assert [p['file'] for p in payload] == ['aux_fan.cfg']


def test_add_section_wrong_case_of_existing_is_a_duplicate_not_a_variant():
    """Clifford's rule: a case variant must never reach the config. The
    resolved header makes add_section's duplicate check fire, so the file
    keeps exactly one [printer]."""
    session = EditSession(_ctx())
    content, details = _edit(session, op='add_section', file='Printer.cfg',
                             section='Printer', text='max_velocity: 999\n')
    assert details is None
    assert 'already exists' in content
    assert session.pending_edits == []
    # And nothing was written into the working state either.
    assert session.state.files['printer.cfg'].count('[printer]') == 1


def test_add_section_new_section_is_still_created_as_asked():
    session = EditSession(_ctx())
    content, details = _edit(session, op='add_section', file='printer.cfg',
                             section='gcode_macro Park_Head',
                             text='gcode:\n    G28\n')
    assert details is not None, content
    payload = session.pending_edits_payload()
    assert '[gcode_macro Park_Head]' in payload[0]['newText']


def test_absent_file_still_errors_and_names_the_known_files():
    session = EditSession(_ctx())
    content, details = _edit(session, file='nope.cfg', section='printer',
                             key='max_accel', value='1')
    assert details is None
    assert 'not in the project' in content
    assert 'printer.cfg' in content
