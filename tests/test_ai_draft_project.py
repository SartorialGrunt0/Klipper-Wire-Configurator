"""Phase 0 tests: mechanical project-state ops + delta gate (ai_draft_project).

Pure-service tests — no routes, no flags. Covers Gate 0 of
.hermes/plans/2026-09-10_tool-mediated-config-editing.md:
every op × {clean apply, new-error kickback, baseline-inherited error
never blocks, text-shift regression, commented-param preservation,
dup-key pairing preserved, delete missing file/section → structured
error not exception}.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.ai_draft_project import ProjectState  # noqa: E402
from services.ai_draft_validation import _error_key, collect_new_validation_errors  # noqa: E402


BASE_CFG = """[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
max_z_velocity: 5
max_z_accel: 100

[stepper_x]
step_pin: PF13
dir_pin: PF12   # keep me
## enable_pin: PF16
rotation_distance: 40
microsteps: 16

[stepper_y]
step_pin: PF11
dir_pin: PB3
rotation_distance: 40
microsteps: 16

[stepper_z]
step_pin: PB5
dir_pin: BB5
rotation_distance: 8
microsteps: 16

[gcode_macro PRINT_START]
gcode:
    {% set temp = params.T | default(60) | float %}
    M104 S{temp}
    G28
    M109 S{temp}

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


# ── set_param ───────────────────────────────────────────────────────────

def test_set_param_clean_and_preserves_comments():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'printer', 'key': 'max_accel', 'value': '3000'})
    assert r['status'] == 'applied'
    assert not r['newErrors'] and not r['advisories']
    assert 'max_accel: 3000' in st1.files['printer.cfg']
    # untouched lines are byte-stable
    assert 'dir_pin: PF12   # keep me' in st1.files['printer.cfg']
    assert '## enable_pin: PF16' in st1.files['printer.cfg']
    assert 'M104 S{temp}' in st1.files['printer.cfg']


def test_set_param_upserts_new_param_into_section():
    st, base = _state()
    # NOTE: round_probe_count would be a VALID new-error case (it makes
    # mesh_radius required) — kept out of this clean-upsert test on purpose.
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'bed_mesh', 'key': 'fade_start', 'value': '1'})
    assert r['status'] == 'applied'
    assert 'fade_start: 1' in st1.files['printer.cfg']


def test_set_param_uncomments_and_sets_commented_param():
    """2026-09-20: the refusal was removed — set_param on a commented-only
    param now uncomments the line IN PLACE and applies (the approval-card
    diff is the user's confirmation; a separate active line must NOT be
    inserted, which would leave a duplicate dormant key)."""
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'stepper_x', 'key': 'enable_pin', 'value': 'PF16'})
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert 'enable_pin: PF16' in st1.files['printer.cfg']
    assert '#enable_pin' not in st1.files['printer.cfg']
    # the value replaced the commented line; exactly one enable_pin exists
    assert st1.files['printer.cfg'].count('enable_pin') == 1
    assert 'uncommented' in r['summary']


def test_set_param_new_error_kickback_leaves_state_untouched():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'printer', 'key': 'kinematics', 'value': 'hologate'})
    assert r['status'] == 'error'
    assert any('hologate' in e['message'] for e in r['newErrors'])
    assert st1.files == st.files


def test_set_param_missing_section_structured_error():
    st, base = _state()
    _, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                           'section': 'nope', 'key': 'a', 'value': 'b'})
    assert r['status'] == 'error' and 'not found' in r['error']


def test_set_param_multiline_value():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'bed_mesh', 'key': 'probe_count',
                             'value': '7,\n    7'})
    assert r['status'] == 'applied'
    assert 'probe_count: 7,' in st1.files['printer.cfg']


# ── baseline semantics ──────────────────────────────────────────────────

def test_baseline_inherited_errors_never_block():
    st, base = _state()
    st1, _ = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'printer', 'key': 'max_accel', 'value': '3000'})
    # A project seeded WITH errors: baseline carries them; an unrelated
    # clean edit must still apply.
    ctx = {'printer.cfg': {'content': '[printer]\nkinematics: cartesian\nsensor_type: bogus\n'}}
    bad = ProjectState.from_context_files(ctx)
    bad_base = bad.validate()
    assert sum(len(v['errors']) for v in bad_base.values()) > 0
    bad1, r = bad.apply(bad_base, {'op': 'set_param', 'file': 'printer.cfg',
                                   'section': 'printer', 'key': 'max_velocity', 'value': '250'})
    assert r['status'] == 'applied'
    assert not r['newErrors']


def test_text_shift_regression_error_key_is_message_free():
    # Changing a pre-existing error's VALUE (message text shifts, location
    # identity holds) must NOT surface as a new error.
    st, base = _state()
    st1, r1 = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                              'section': 'stepper_x', 'key': 'step_pin', 'value': 'halleluja'})
    # warning-severity pin warning rides as advisory, non-blocking
    assert r1['status'] in ('applied', 'applied_with_advisory')
    # Now the pin warning is in state; change the value AGAIN — the warning
    # message text shifts ('halleluja' -> 'nope') but is baseline-inherited.
    st2, r2 = st1.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                               'section': 'stepper_x', 'key': 'step_pin', 'value': 'nope'})
    assert r2['status'] in ('applied', 'applied_with_advisory')
    pin_new = [e for e in r2['newErrors'] if e['param'] == 'step_pin']
    assert not pin_new


def test_error_key_ignores_message_uses_code_extra():
    mk = lambda **kw: {'severity': 'error', 'section': 's', 'param': 'p',
                       'message': 'M1', 'code': '', 'extra': '', **kw}
    assert _error_key('f', mk(message='M2')) == _error_key('f', mk())
    assert _error_key('f', mk(code='x')) != _error_key('f', mk())
    assert _error_key('f', mk(extra='CMD')) != _error_key('f', mk(extra='OTHER'))


# ── patch_gcode ─────────────────────────────────────────────────────────

PATCH_OP = {'op': 'patch_gcode', 'file': 'printer.cfg',
            'section': 'gcode_macro PRINT_START'}


def test_patch_gcode_exact():
    st, base = _state()
    st1, r = st.apply(base, dict(PATCH_OP, old_text='    G28', new_text='    G28\n    M400'))
    assert r['status'] == 'applied'
    assert 'M400' in st1.files['printer.cfg']
    # Jinja lines untouched
    assert '{% set temp = params.T | default(60) | float %}' in st1.files['printer.cfg']


def test_patch_gcode_anchor_miss_returns_current_section_text():
    st, base = _state()
    st1, r = st.apply(base, dict(PATCH_OP, old_text='    G28 ; hallucinated suffix', new_text='X'))
    assert r['status'] == 'error'
    assert 'G28' in r.get('sectionText', '')
    assert st1.files == st.files


def test_patch_gcode_indent_tolerant_fallback():
    st, base = _state()
    st1, r = st.apply(base, dict(PATCH_OP, old_text='G28', new_text='G28\n    M400'))
    assert r['status'] == 'applied'
    # insertion re-indented to the section body indent
    assert '\n    M400' in st1.files['printer.cfg']


def test_patch_gcode_ambiguous_anchor_errors_with_count():
    text = BASE_CFG + '\n[gcode_macro DUP]\ngcode:\n    G28\n    G28\n'
    st, base = _state(text)
    _, r = st.apply(base, {'op': 'patch_gcode', 'file': 'printer.cfg',
                           'section': 'gcode_macro DUP', 'old_text': 'G28', 'new_text': 'X'})
    assert r['status'] == 'error'
    assert '2 places' in r['error']


def test_patch_gcode_deletion():
    st, base = _state()
    st1, r = st.apply(base, dict(PATCH_OP, old_text='    M104 S{temp}\n    G28', new_text='    G28'))
    assert r['status'] == 'applied'
    body = st1.files['printer.cfg']
    assert body.count('M104') == 0


# ── sections ────────────────────────────────────────────────────────────

def test_add_section_clean():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'verify_heater extruder',
                             'text': 'max_error: 120\nheating_gain: 2'})
    assert r['status'] == 'applied'
    assert '[verify_heater extruder]' in st1.files['printer.cfg']


SAVE_CONFIG_TAIL = """
#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [probe]
#*# z_offset = -0.520
#*#
#*# [bed_mesh default]
#*# points =
#*#\t\t0.000000
"""


def _tail_state(text=BASE_CFG + SAVE_CONFIG_TAIL):
    return _state(text)


def test_add_section_lands_above_save_config_banner():
    """Live dogfood 2026-09-17: add_section appended at EOF, which on a
    SAVE_CONFIG'd printer.cfg drops the new section BELOW the
    '#*# DO NOT EDIT THIS BLOCK OR BELOW' banner -- Klipper rewrites the
    tail on the next SAVE_CONFIG (the section would be destroyed) and the
    bare header breaks the #*# block parse. Insert above the banner; the
    banner and everything below it stay byte-identical."""
    st, base = _tail_state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'verify_heater extruder',
                             'text': 'max_error: 120\nheating_gain: 2'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    assert out.index('[verify_heater extruder]') < out.index('#*# <')
    # tail preserved byte-for-byte (banner line -> EOF)
    assert out[out.index('#*# <'):] == (BASE_CFG + SAVE_CONFIG_TAIL)[
        (BASE_CFG + SAVE_CONFIG_TAIL).index('#*# <'):]


def test_add_include_lands_above_save_config_banner():
    st, base = _tail_state()
    st1, r = st.apply(base, {'op': 'new_file', 'file': 'dock_macros.cfg',
                             'content': '[gcode_macro DOCK_Z]\ngcode:\n    G1 Z5\n'})
    assert r['status'] == 'applied'
    st2, r = st1.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                              'target_file': 'dock_macros.cfg'})
    assert r['status'] == 'applied'
    out = st2.files['printer.cfg']
    assert out.index('[include dock_macros.cfg]') < out.index('#*# <')


# ── add_include placement convention ─────────────────────────────────
# Sir dogfood 2026-09-25: add_include reused the SECTION inserter
# (EOF/above-banner), so the line landed at the very bottom of
# printer.cfg. Klipper convention is includes at the top, together.

INCLUDES_CFG = """# My Voron config
# (leading header comments stay at the very top)
[include mainsail.cfg]
[include aux_fan.cfg]

[printer]
kinematics: cartesian
max_velocity: 200
"""


def test_add_include_joins_existing_include_block():
    st, base = _state(INCLUDES_CFG)
    st1, r = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                             'target_file': 'new_macros.cfg'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    lines = out.split('\n')
    assert lines[0] == '# My Voron config'
    inc = lines.index('[include new_macros.cfg]')
    # directly after the last existing include — one contiguous block,
    # before the first real section
    assert inc == lines.index('[include aux_fan.cfg]') + 1
    assert inc < lines.index('[printer]')


def test_add_include_no_existing_includes_goes_to_top():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                             'target_file': 'macros.cfg'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    lines = out.split('\n')
    assert lines[0] == '[include macros.cfg]'
    # blank line separates the include from the first section
    assert lines[1] == ''
    assert lines.index('[printer]') == 2


def test_add_include_top_insert_keeps_header_comments_first():
    text = '# Top of file comment\n[printer]\nkinematics: cartesian\n'
    st, base = _state(text)
    st1, r = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                             'target_file': 'macros.cfg'})
    assert r['status'] == 'applied'
    lines = st1.files['printer.cfg'].split('\n')
    assert lines[0] == '# Top of file comment'
    assert lines[1] == '[include macros.cfg]'
    assert lines.index('[printer]') == 3


def test_add_include_joins_block_above_banner_not_eof():
    tail = INCLUDES_CFG + SAVE_CONFIG_TAIL
    st, base = _state(tail)
    st1, r = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                             'target_file': 'new_macros.cfg'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    assert out.index('[include new_macros.cfg]') < out.index('[printer]')
    # tail preserved byte-for-byte
    assert out[out.index('#*# <'):] == tail[tail.index('#*# <'):]


def test_add_section_no_tail_still_appends_at_eof():
    """Flag-off parity: files WITHOUT a tail behave exactly as before."""
    st, base = _state()
    st1, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                             'section': 'idle_timeout',
                             'text': 'timeout: 600'})
    assert r['status'] == 'applied'
    assert st1.files['printer.cfg'].rstrip().endswith('timeout: 600')


def test_add_section_duplicate_refused():
    st, base = _state()
    _, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                           'section': 'bed_mesh', 'text': 'speed: 1'})
    assert r['status'] == 'error' and 'already exists' in r['error']


def test_add_section_rejects_header_in_body():
    st, base = _state()
    _, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                           'section': 'foo', 'text': '[foo]\nbar: 1'})
    assert r['status'] == 'error' and 'BODY only' in r['error']


def test_replace_section_above_tail_preserves_banner():
    """Same bug class as add_section-at-EOF (dogfood 2026-09-17): a
    section's range ran to EOF because banner lines ('#*# [probe]') never
    match RE_SECTION_HEADER — replacing the LAST real section therefore
    rewrote the whole SAVE_CONFIG tail away. The banner must bound the
    section range."""
    st, base = _tail_state()
    # last real section in BASE_CFG is [bed_mesh], directly above the tail
    st1, r = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                             'section': 'bed_mesh',
                             'text': 'speed: 60\nhorizontal_move_z: 5\n'
                                     'mesh_min: 10, 10\nmesh_max: 190, 190\n'
                                     'probe_count: 5, 5'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    assert 'speed: 60' in out
    tail = out[out.index('#*# <'):]
    expected_tail = (BASE_CFG + SAVE_CONFIG_TAIL)
    assert tail == expected_tail[expected_tail.index('#*# <'):]


def test_delete_section_above_tail_preserves_banner():
    st, base = _tail_state()
    st1, r = st.apply(base, {'op': 'delete_section', 'file': 'printer.cfg',
                             'section': 'bed_mesh'})
    assert r['status'] == 'applied'
    out = st1.files['printer.cfg']
    assert '[bed_mesh]' not in out
    tail = out[out.index('#*# <'):]
    expected_tail = (BASE_CFG + SAVE_CONFIG_TAIL)
    assert tail == expected_tail[expected_tail.index('#*# <'):]


def test_replace_section_and_foreign_header_refused():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                             'section': 'gcode_macro PRINT_START',
                             'text': 'gcode:\n    M117 replaced'})
    assert r['status'] == 'applied'
    assert 'M117 replaced' in st1.files['printer.cfg']
    assert 'G28' not in st1.files['printer.cfg']
    _, r2 = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                            'section': 'bed_mesh', 'text': 'speed: 1\n[extruder]\nx: 1'})
    assert r2['status'] == 'error' and 'foreign header' in r2['error']


def test_replace_section_header_prefixed_body_is_stripped():
    """r2 TRIDENT-15 (2026-09-14): models habitually start the text with
    the section's own header. Kept verbatim it duplicated '[header]' and
    the first (empty) duplicate swallowed the section at validate time -
    silent content loss. One leading own-header line is now stripped."""
    st, base = _state()
    st1, r = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                             'section': 'bed_mesh',
                             'text': '[bed_mesh]\nspeed: 80\n'
                                     'mesh_min: 10, 10\nmesh_max: 190, 190'})
    assert r['status'] == 'applied'
    text = st1.files['printer.cfg']
    assert text.count('[bed_mesh]') == 1
    assert 'speed: 80' in text


def test_comment_include_op():
    """TRIDENT-04 (2026-09-14): 'comment out the include' had no op; the
    model honestly reported the gap. comment_include disables the line as
    '#[include x.cfg]' without destroying it."""
    st0, base = _state()
    seeded = ProjectState.from_context_files({'printer.cfg': {'content':
        st0.files['printer.cfg'].rstrip('\n') + '\n\n[include sensorless.cfg]\n'}})
    st1, r = seeded.apply(seeded.validate(), {'op': 'comment_include',
                                              'file': 'printer.cfg',
                             'target_file': 'sensorless.cfg'})
    assert r['status'] == 'applied'
    assert '#[include sensorless.cfg]' in st1.files['printer.cfg']
    # Idempotent: already commented -> honest error, not a double '#'.
    _, r2 = st1.apply(st1.validate(), {'op': 'comment_include',
                                       'file': 'printer.cfg',
                                       'target_file': 'sensorless.cfg'})
    assert r2['status'] == 'error' and 'already commented' in r2['error']
    # Missing include -> honest error.
    _, r3 = seeded.apply(seeded.validate(), {'op': 'comment_include',
                                             'file': 'printer.cfg',
                                             'target_file': 'nope.cfg'})
    assert r3['status'] == 'error' and 'not present' in r3['error']


def test_include_ops_path_shapes_kamp():
    """Live trace 2026-09-20 (KAMP): includes written as
    '[include ./KAMP/Adaptive_Meshing.cfg]'. Exact-match-only targeting
    rejected every sensible basename call with 'not present', and the
    model concluded comment_include couldn't touch top-of-file include
    lines at all. Targeting now accepts exact, './'-normalized, and
    unique-basename forms; failures list the file's actual includes."""
    st = ProjectState.from_context_files({'KAMP_Settings.cfg': {'content':
        '[include ./KAMP/Adaptive_Meshing.cfg]\n'
        '[include ./KAMP/Line_Purge.cfg]\n'
        '[include ./KAMP/Smart_Park.cfg]\n'}})
    base = st.validate()
    # Basename form addresses a './KAMP/...' line.
    st1, r = st.apply(base, {'op': 'comment_include',
                             'file': 'KAMP_Settings.cfg',
                             'target_file': 'Adaptive_Meshing.cfg'})
    assert r['status'] == 'applied', r
    assert '#[include ./KAMP/Adaptive_Meshing.cfg]' in st1.files['KAMP_Settings.cfg']
    # './'-normalized form.
    st2, r2 = st1.apply(st1.validate(), {'op': 'comment_include',
                                         'file': 'KAMP_Settings.cfg',
                                         'target_file': './KAMP/Line_Purge.cfg'})
    assert r2['status'] == 'applied', r2
    # Ambiguous basename -> error listing candidates, never a coin flip.
    st3 = ProjectState.from_context_files({'printer.cfg': {'content':
        '[include a/macros.cfg]\n[include b/macros.cfg]\n'}})
    _, r3 = st3.apply(st3.validate(), {'op': 'comment_include',
                                       'file': 'printer.cfg',
                                       'target_file': 'macros.cfg'})
    assert r3['status'] == 'error' and 'ambiguous' in r3['error']
    assert 'a/macros.cfg' in r3['error'] and 'b/macros.cfg' in r3['error']
    # Not-present error lists what IS there so the model can re-quote.
    _, r4 = st2.apply(st2.validate(), {'op': 'remove_include',
                                       'file': 'KAMP_Settings.cfg',
                                       'target_file': 'nope.cfg'})
    assert r4['status'] == 'error' and 'not present' in r4['error']
    assert '[include ./KAMP/Smart_Park.cfg]' in r4['error']
    # remove_include accepts the same shapes.
    st4, r5 = st2.apply(st2.validate(), {'op': 'remove_include',
                                         'file': 'KAMP_Settings.cfg',
                                         'target_file': 'Smart_Park.cfg'})
    assert r5['status'] == 'applied', r5
    assert 'Smart_Park' not in st4.files['KAMP_Settings.cfg']


def test_add_include_duplicate_guard_normalized():
    """'[include x]' and '[include ./x]' are the SAME include in Klipper;
    the dup guard must see through the './' prefix."""
    st = ProjectState.from_context_files({'printer.cfg': {'content':
        '[include ./KAMP/Line_Purge.cfg]\n'}})
    _, r = st.apply(st.validate(), {'op': 'add_include',
                                    'file': 'printer.cfg',
                                    'target_file': 'KAMP/Line_Purge.cfg'})
    assert r['status'] == 'error' and 'already present' in r['error']


KAMP_TRAILING_COMMENTS = (
    '[include ./KAMP/Adaptive_Meshing.cfg]       # Include to enable '
    'adaptive meshing configuration.\n'
    '[include ./KAMP/Line_Purge.cfg]             # Include to enable '
    'adaptive line purging configuration.\n')


def test_include_ops_trailing_comment_shape():
    """KAMP round 2 (live 2026-09-20): KAMP_Settings.cfg ships
    '[include ./KAMP/x.cfg]       # Include to enable ...' — the header
    regex anchors ']' to EOL, so RE_SECTION_HEADER never matched and
    every include op reported 'has no include lines'; the model fell
    back to patch_gcode with section='' and told the user it was
    impossible."""
    st = ProjectState.from_context_files({'KAMP_Settings.cfg': {'content':
        KAMP_TRAILING_COMMENTS}})
    st1, r = st.apply(st.validate(), {'op': 'comment_include',
                                      'file': 'KAMP_Settings.cfg',
                                      'target_file': 'Adaptive_Meshing.cfg'})
    assert r['status'] == 'applied', r
    first = st1.files['KAMP_Settings.cfg'].splitlines()[0]
    assert first.startswith('#[include ./KAMP/Adaptive_Meshing.cfg]')
    assert 'adaptive meshing' in first  # trailing comment preserved
    st2, r2 = st1.apply(st1.validate(), {'op': 'remove_include',
                                         'file': 'KAMP_Settings.cfg',
                                         'target_file': './KAMP/Line_Purge.cfg'})
    assert r2['status'] == 'applied', r2
    assert 'Line_Purge' not in st2.files['KAMP_Settings.cfg']
    # add_include dup guard sees the trailing-comment line too
    _, r3 = st.apply(st.validate(), {'op': 'add_include',
                                     'file': 'KAMP_Settings.cfg',
                                     'target_file': './KAMP/Line_Purge.cfg'})
    assert r3['status'] == 'error' and 'already present' in r3['error']


def test_patch_gcode_include_misroute_names_right_op():
    """Same trace: the model's fallback was patch_gcode with an empty
    section quoting the include lines. The kickback must name
    comment_include/remove_include, not the generic missing-section
    error the model read as a capability gap."""
    st = ProjectState.from_context_files({'KAMP_Settings.cfg': {'content':
        KAMP_TRAILING_COMMENTS}})
    _, r = st.apply(st.validate(), {
        'op': 'patch_gcode', 'file': 'KAMP_Settings.cfg', 'section': '',
        'old_text': '[include ./KAMP/Adaptive_Meshing.cfg]', 'new_text': ''})
    assert r['status'] == 'error'
    assert 'comment_include' in r['error'] and 'remove_include' in r['error']
    # Scope guard: the kickback fires ONLY on the empty-section
    # misroute. A real section whose text quotes '[include' stays
    # patchable, and an empty-section call WITHOUT include text keeps
    # the generic missing-argument error.
    stg = ProjectState.from_context_files({'macros.cfg': {'content':
        '[gcode_macro SHOW_INCLUDES]\ngcode:\n    M117 edit [include x] not valid here\n'}})
    sg, rg = stg.apply(stg.validate(), {
        'op': 'patch_gcode', 'file': 'macros.cfg',
        'section': 'gcode_macro SHOW_INCLUDES',
        'old_text': 'M117 edit [include x] not valid here',
        'new_text': 'M117 includes listed elsewhere'})
    assert rg['status'] == 'applied', rg
    _, rg2 = stg.apply(stg.validate(), {
        'op': 'patch_gcode', 'file': 'macros.cfg', 'section': '',
        'old_text': 'no include here', 'new_text': ''})
    assert rg2['status'] == 'error' and 'Missing required argument: section' in rg2['error']


def test_missing_section_wrong_file_names_the_file():
    """Audit 2026-09-20: a section op pointed at the wrong file said
    only 'not found — read the file first', sending models to re-read
    the SAME file (dead loop -> 'the tool can't do this'). The tool can
    see the whole project, so the error now names the file that has it.
    Applies to every section op; checked on two."""
    st = ProjectState.from_context_files({
        'printer.cfg': {'content': '[printer]\nkinematics: cartesian\n'},
        'macros.cfg': {'content': '[gcode_macro HOME]\ngcode:\n    G28\n'}})
    _, r = st.apply(st.validate(), {'op': 'set_param', 'file': 'printer.cfg',
                                    'section': 'gcode_macro HOME',
                                    'key': 'gcode', 'value': 'G28 X'})
    assert r['status'] == 'error' and 'macros.cfg' in r['error']
    _, r2 = st.apply(st.validate(), {'op': 'delete_section',
                                     'file': 'printer.cfg',
                                     'section': 'gcode_macro HOME'})
    assert r2['status'] == 'error' and 'It exists in macros.cfg' in r2['error']
    # Section genuinely absent everywhere: no misleading hint.
    _, r3 = st.apply(st.validate(), {'op': 'delete_section',
                                     'file': 'printer.cfg',
                                     'section': 'bed_mesh'})
    assert r3['status'] == 'error' and 'It exists in' not in r3['error']


def test_section_ops_include_shaped_section_kickback():
    """Same audit: section='include' / 'include ./x.cfg' is the model's
    second guess at editing an include line. Every section op must name
    comment_include/remove_include instead of 'section not found'."""
    st = ProjectState.from_context_files({'printer.cfg': {'content':
        '[include ./KAMP/Line_Purge.cfg]\n[printer]\nkinematics: cartesian\n'}})
    for op in ('set_param', 'replace_section', 'delete_section',
               'add_section', 'patch_gcode'):
        args = {'op': op, 'file': 'printer.cfg',
                'section': 'include ./KAMP/Line_Purge.cfg'}
        if op == 'set_param':
            args.update(key='x', value='')
        elif op in ('replace_section', 'add_section'):
            args['text'] = ''
        elif op == 'patch_gcode':
            args.update(old_text='y', new_text='')
        _, r = st.apply_no_gate(args)
        assert r['status'] == 'error', (op, r)
        assert 'comment_include' in r['error'], (op, r)


def test_delete_file_dangling_include_guard():
    """Same audit: delete_file on an INCLUDED file succeeded and left
    '[include x.cfg]' dangling; the validator doesn't flag dangling
    includes, so a Klipper-unstartable config would have staged with no
    warning. Deletion is now refused until the include is removed, and
    the error gives the exact remove_include call."""
    st = ProjectState.from_context_files({
        'printer.cfg': {'content':
            '[printer]\nkinematics: cartesian\nmax_velocity: 200\n'
            'max_accel: 1000\nmax_z_velocity: 5\nmax_z_accel: 100\n'
            '[include ./sub/old.cfg]\n'},
        'old.cfg': {'content': '[idle_timeout]\nhoming_timeout: 60\n'}})
    _, r = st.apply(st.validate(), {'op': 'delete_file', 'file': 'old.cfg'})
    assert r['status'] == 'error' and 'still included' in r['error']
    assert "op='remove_include'" in r['error'] and 'printer.cfg' in r['error']
    assert 'old.cfg' in st.files  # nothing deleted
    # remove-then-delete works in the guided order
    st2, r2 = st.apply(st.validate(), {'op': 'remove_include',
                                       'file': 'printer.cfg',
                                       'target_file': './sub/old.cfg'})
    assert r2['status'] == 'applied', r2
    st3, r3 = st2.apply(st2.validate(), {'op': 'delete_file', 'file': 'old.cfg'})
    assert r3['status'] == 'applied', r3
    assert 'old.cfg' not in st3.files
    # files nobody includes still delete freely
    stx = ProjectState.from_context_files({
        'printer.cfg': {'content': '[printer]\nkinematics: cartesian\n'},
        'loose.cfg': {'content': '[idle_timeout]\nhoming_timeout: 60\n'}})
    _, rx = stx.apply(stx.validate(), {'op': 'delete_file', 'file': 'loose.cfg'})
    assert rx['status'] == 'applied', rx


def test_replace_section_missing_text_never_wipes():
    """Fullbank edit-tools run 2026-09-14: gemma sent patch-style
    old_text/new_text with op=replace_section and NO text; the handler
    defaulted body to '' and silently deleted the section contents
    (empty sections validate clean, so the corruption reached staging).
    Missing 'text' is now a correctable kickback; emptying stays legal
    only via an explicit empty string."""
    st, base = _state()
    _, r = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                           'section': 'bed_mesh',
                           'old_text': 'speed: 50', 'new_text': 'speed: 80'})
    assert r['status'] == 'error' and "'text'" in r['error']
    assert 'patch_gcode' in r['error']
    st2, r2 = st.apply(base, {'op': 'replace_section', 'file': 'printer.cfg',
                              'section': 'bed_mesh', 'text': ''})
    # Explicit empty string passes the argument guard; whether it then
    # stages depends on validation (bed_mesh requires params, so here it
    # correctly fails validation -- NOT the missing-text error).
    assert "'text'" not in r2.get('error', '')


def test_delete_section_clean_and_missing():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'delete_section', 'file': 'printer.cfg',
                             'section': 'bed_mesh'})
    assert r['status'] == 'applied'
    assert '[bed_mesh]' not in st1.files['printer.cfg']
    _, r2 = st.apply(base, {'op': 'delete_section', 'file': 'printer.cfg',
                            'section': 'bed_mesh_ghost'})
    assert r2['status'] == 'error' and 'not found' in r2['error']


# ── files & includes ────────────────────────────────────────────────────

def test_new_file_and_include_roundtrip():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'new_file', 'file': 'macros.cfg',
                             'content': '[gcode_macro NEW]\ngcode:\n    M117 hi\n'})
    # bed_mesh-without-probe warning surfaces once the project is
    # multi-file; warnings are advisory, never blocking.
    assert r['status'] in ('applied', 'applied_with_advisory')
    assert not r['newErrors']
    assert 'macros.cfg' in st1.files
    # new_file refuses to clobber an existing file (Q3: create-only)
    _, rc = st1.apply(base, {'op': 'new_file', 'file': 'macros.cfg', 'content': 'x'})
    assert rc['status'] == 'error' and 'NEW files only' in rc['error']

    st2, r2 = st1.apply(base, {'op': 'add_include', 'target_file': 'macros.cfg'})
    assert r2['status'] in ('applied', 'applied_with_advisory')
    assert not r2['newErrors']
    assert '[include macros.cfg]' in st2.files['printer.cfg']
    # a second include of the same file is refused
    _, r3 = st2.apply(base, {'op': 'add_include', 'target_file': 'macros.cfg'})
    assert r3['status'] == 'error' and 'already present' in r3['error']

    st3, r4 = st2.apply(base, {'op': 'remove_include', 'target_file': 'macros.cfg'})
    assert r4['status'] in ('applied', 'applied_with_advisory')
    assert not r4['newErrors']
    assert '[include macros.cfg]' not in st3.files['printer.cfg']


def test_delete_file_rules():
    st, base = _state()
    st1, _ = st.apply(base, {'op': 'new_file', 'file': 'tmp.cfg', 'content': '[gcode_macro T]\ngcode:\n    M117 x\n'})
    st2, r = st1.apply(base, {'op': 'delete_file', 'file': 'tmp.cfg'})
    assert r['status'] == 'applied' and 'tmp.cfg' not in st2.files
    _, r2 = st.apply(base, {'op': 'delete_file', 'file': 'printer.cfg'})
    assert r2['status'] == 'error' and 'root config' in r2['error']
    _, r3 = st.apply(base, {'op': 'delete_file', 'file': 'ghost.cfg'})
    assert r3['status'] == 'error' and 'not in the project' in r3['error']


# ── structured errors, never exceptions ─────────────────────────────────

@pytest.mark.parametrize('op', [
    {'op': 'bogus_op'},
    {'op': 'set_param'},
    {'op': 'set_param', 'file': 'printer.cfg'},
    {'op': 'set_param', 'file': 'printer.cfg', 'section': 'printer'},
    {'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'printer'},
    {'op': 'add_include'},
    {'op': 'new_file'},
])
def test_malformed_ops_return_structured_errors(op):
    st, base = _state()
    st1, r = st.apply(base, op)
    assert r['status'] == 'error'
    assert st1.files == st.files


# ── duplicate keys / commented params preserved through ops elsewhere ──

def test_dup_key_pairing_and_comment_state_survive():
    text = BASE_CFG + '\n[output_pin beacon]\npin: PB2\nserial: aaa\nserial: bbb\nserial: ccc\n'
    st, base = _state(text)
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'output_pin beacon', 'key': 'pwm', 'value': 'True'})
    assert r['status'] == 'applied'
    body = st1.files['printer.cfg']
    assert body.count('serial: aaa') == 1
    assert body.count('serial: bbb') == 1
    assert body.count('serial: ccc') == 1
    assert '## enable_pin: PF16' in body


# ── diff payload (card rendering input) ────────────────────────────────

def test_apply_returns_diff_before_after():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'printer', 'key': 'max_accel', 'value': '3000'})
    diff = r['diff']
    assert diff['file'] == 'printer.cfg'
    assert 'max_accel: 1000' in diff['before']
    assert 'max_accel: 3000' in diff['after']


# ── REPL-style walkthrough (Gate 0 manual item, automated core) ────────

def test_full_op_walkthrough_roundtrips_through_parser():
    st, base = _state()
    st, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                            'section': 'printer', 'key': 'max_accel', 'value': '3000'})
    assert r['status'] == 'applied'
    st, r = st.apply(base, dict(PATCH_OP, old_text='    G28', new_text='    G28\n    M400'))
    assert r['status'] == 'applied'
    st, r = st.apply(base, {'op': 'add_section', 'file': 'printer.cfg',
                            'section': 'controller_fan parts', 'text': 'pin: PA7\nheater: extruder'})
    assert r['status'] == 'applied'
    st, r = st.apply(base, {'op': 'new_file', 'file': 'macros2.cfg',
                            'content': '[gcode_macro PARK]\ngcode:\n    G91\n    G1 Z5\n'})
    assert r['status'] in ('applied', 'applied_with_advisory')
    st, r = st.apply(base, {'op': 'add_include', 'target_file': 'macros2.cfg'})
    assert r['status'] in ('applied', 'applied_with_advisory')
    # Final text re-parses and re-validates with no NEW findings vs original baseline
    final = st.validate()
    issues = collect_new_validation_errors(base, final)
    assert not [e for g in issues for e in g['errors'] if e['severity'] == 'error']


def test_upsert_creating_dependency_error_is_kicked_back():
    # Real validator semantics: adding round_probe_count to a bed_mesh
    # without mesh_radius creates a NEW required-param error -> kickback.
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'bed_mesh', 'key': 'round_probe_count', 'value': '5'})
    assert r['status'] == 'error'
    assert any('mesh_radius' in e['message'] for e in r['newErrors'])
    assert st1.files == st.files


# ── control-state cancellation (EDIT-04 live finding, 2026-09-13) ────────

def test_new_file_in_partial_context_does_not_conjure_include_errors():
    """1-file context whose includes are absent on 'disk': creating ANY
    file flips the validator into project mode and would blame all the
    latent 'include not found' errors on the new file (unfixable
    kickback). The control-state projection cancels them out."""
    st = ProjectState.from_context_files({
        'printer.cfg': {'content':
            '[mcu]\nserial: /tmp/x\n\n'
            '[include nothere1.cfg]\n[include nothere2.cfg]\n'
        },
    })
    base = st.validate()
    assert sum(len(v['errors']) for v in base.values()) == 0  # file-local mode
    st2, r = st.apply(base, {
        'op': 'new_file', 'file': 'macros.cfg',
        'content': '[gcode_macro PARK]\ngcode:\n    G91\n',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert not r['newErrors']


def test_new_file_real_content_errors_still_kick_back():
    """Cancellation must NOT hide genuine errors from the new file's
    content: an invalid param in the NEW file is a real, fixable error."""
    st = ProjectState.from_context_files({
        'printer.cfg': {'content':
            '[mcu]\nserial: /tmp/x\n\n[include nothere1.cfg]\n'
        },
    })
    base = st.validate()
    st2, r = st.apply(base, {
        'op': 'new_file', 'file': 'bad.cfg',
        'content': '[stepper_x]\nstep_pin: PB0\nbogus_param_xyz: 1\n',
    })
    assert r['status'] == 'error'  # incomplete stepper section kicks back
    messages = [e.get('message', '') for e in r.get('newErrors', [])]
    assert any('rotation_distance' in msg for msg in messages)
    ghost = [msg for msg in messages if 'nothere1' in msg]
    assert not ghost, f"include ghost leaked into kickback: {ghost}"


# ── comment-boundary guard on patch_gcode (EDIT-06, 2026-09-13) ─────────

_X_PRINTER = ("[stepper_x]\nstep_pin: PB0\n#enable_pin: !PE9\n"
              "rotation_distance: 40\nmicrosteps:Sixteen\ndir_pin: PB1\n")


def _guard_state():
    st = ProjectState.from_context_files({'printer.cfg': {'content': _X_PRINTER}})
    return st, st.validate()


def test_patch_gcode_uncomment_param_applies():
    """2026-09-20: the comment-boundary guard was REMOVED. Comment flips
    apply as-told — the approval-card diff (red commented line, green
    uncommented line) is the user's confirmation. The old refusal pushed
    models into prose ask-first flows that read as a broken edit tool."""
    st, base = _guard_state()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': 'enable_pin: PF16',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert 'enable_pin: PF16' in st2.files['printer.cfg']
    assert '#enable_pin' not in st2.files['printer.cfg']


def test_patch_gcode_comment_to_comment_edit_applies():
    """Dormant-content edits (comment-to-comment) apply as-told too: the
    diff shows the edited commented line; the user approves or declines.
    (r3's dormant-rewrite concern now surfaces honestly IN the diff —
    the user sees the param stays commented.)"""
    st, base = _guard_state()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': '#enable_pin: !PF16',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert '#enable_pin: !PF16' in st2.files['printer.cfg']


def test_patch_gcode_gcode_body_edits_never_guarded():
    """Macro-body patches (the bread-and-butter patch_gcode use) must be
    untouched by the comment guard: comments inside gcode bodies are
    prose, not params."""
    printer = ("[gcode_macro PARK]\n"
               "# park up\n"
               "gcode:\n"
               "    # lift\n"
               "    G91\n")
    st = ProjectState.from_context_files({'printer.cfg': {'content': printer}})
    base = st.validate()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'gcode_macro PARK',
        'old_text': '    # lift\n    G91', 'new_text': '    G91',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r


def test_patch_gcode_commenting_out_param_applies():
    """2026-09-20: comment-OUT flips apply as-told (see
    test_patch_gcode_uncomment_param_applies). Uses an OPTIONAL param —
    commenting out a REQUIRED param (e.g. stepper step_pin) still kicks
    back through the delta validator, which is correct and unrelated to
    the removed comment guard."""
    st = ProjectState.from_context_files({'printer.cfg': {'content':
        '[output_pin case_light]\npin: PB7\ncycle_time: 0.01\n'}})
    base = st.validate()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'output_pin case_light',
        'old_text': 'cycle_time: 0.01', 'new_text': '#cycle_time: 0.01',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert '#cycle_time: 0.01' in st2.files['printer.cfg']


def test_add_include_refuses_self_include():
    """Self-include is a Klipper circular-load error the validator does
    not flag (live 9b r2 finding: add_include file=printer.cfg
    target_file=printer.cfg was accepted and staged as a success)."""
    st = ProjectState.from_context_files({'printer.cfg': {'content':
        '[mcu]\nserial: /tmp/x\n'
    }})
    base = st.validate()
    _, r = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                           'target_file': 'printer.cfg'})
    assert r['status'] == 'error'
    assert 'cannot include itself' in r['error']
    # the corrected call succeeds
    st2, r2 = st.apply(base, {'op': 'add_include', 'file': 'printer.cfg',
                              'target_file': 'park.cfg'})
    assert r2['status'] in ('applied', 'applied_with_advisory'), r2
    assert '[include park.cfg]' in st2.files['printer.cfg']


def test_patch_gcode_dormant_param_update_applies_visibly():
    """r3 9b finding: model anchored '#enable_pin: !PE9' and rewrote it to
    '#enable_pin: !PF16' while the param stayed INACTIVE. 2026-09-20:
    guard removed — the edit applies as-told, and the diff is honest:
    the result line STILL starts with '#', so the user sees the param
    remains commented before approving."""
    st, base = _guard_state()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': '#enable_pin: !PF16',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert '#enable_pin: !PF16' in st2.files['printer.cfg']
    # the diff itself carries the truth for the approval card
    assert '#enable_pin: !PE9' in r['diff']['before']
    assert '#enable_pin: !PF16' in r['diff']['after']
