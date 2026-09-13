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


def test_set_param_refuses_commented_param():
    st, base = _state()
    st1, r = st.apply(base, {'op': 'set_param', 'file': 'printer.cfg',
                             'section': 'stepper_x', 'key': 'enable_pin', 'value': 'PF16'})
    assert r['status'] == 'error'
    assert 'commented out' in r['error']
    assert st1.files == st.files  # unchanged


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


def test_patch_gcode_cannot_silently_uncomment_param():
    st, base = _guard_state()
    _, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': 'enable_pin: PF16',
    })
    assert r['status'] == 'error'
    assert 'commented' in r['error'].lower()
    assert r.get('commentedParams') == ['enable_pin']


def test_patch_gcode_allow_comment_change_escapes_guard():
    st, base = _guard_state()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': 'enable_pin: PF16',
        'allow_comment_change': True,
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r
    assert 'enable_pin: PF16' in st2.files['printer.cfg']


def test_patch_gcode_comment_to_comment_edit_not_blocked():
    st, base = _guard_state()
    st2, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': '#enable_pin: !PE9', 'new_text': '#enable_pin: !PF16',
    })
    assert r['status'] in ('applied', 'applied_with_advisory'), r


def test_patch_gcode_commenting_out_param_also_guarded():
    st, base = _guard_state()
    _, r = st.apply(base, {
        'op': 'patch_gcode', 'file': 'printer.cfg', 'section': 'stepper_x',
        'old_text': 'step_pin: PB0', 'new_text': '#step_pin: PB0',
    })
    assert r['status'] == 'error'
    assert r.get('commentedParams') == ['step_pin']
