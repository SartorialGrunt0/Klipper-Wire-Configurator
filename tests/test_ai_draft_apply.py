"""Tests for services/ai_draft_apply mini-diff application.

Focus: the stale-removal key-tolerant fallback (2026-09-09 HARNESS-03
finding). When the model emits a `-` removal line with a stale old value
for a param key that DOES exist in the base section (e.g. the section was
already at `probe_count: 3,3` but the model wrote `-probe_count: 7,7`),
the removal must still match by param key instead of aborting the whole
block. Before the fix the aborted block fell back to
strip_mini_diff_markers + full-section write, which kept BOTH sides of
every -/+ pair; the parser's first-wins then selected the OLD value,
silently reversing the edit and dropping every untouched param of the
section. The deterministic audit caught it ("asked for `speed` = `8`,
merged config has 3/500") — correct alarm, wrong culprit.

Mirrored in frontend/src/utils/miniDiff.ts (same tests in
frontend/src/utils/__tests__/miniDiff.test.ts).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from services.ai_draft_apply import (  # noqa: E402
    apply_mini_diff_block,
    apply_reply_to_configs,
)
from services.ai_reply_audit import check_stated_requirements  # noqa: E402


BASE_CFG = """\
[bed_mesh]
speed: 500
horizontal_move_z: 2
mesh_min: 5,5
mesh_max: 345, 345
zero_reference_position: 175, 175
mesh_pps: 10, 10

probe_count: 3,3
algorithm: bicubic

[probe]
speed: 3
"""


def _params(merged_text: str, header: str) -> dict[str, str]:
    cfg = parse_config(merged_text, 'printer.cfg')
    want = header.strip().strip('[]')
    for section in cfg.sections:
        if section.full_header.strip().strip('[]') == want:
            return {p.key: p.value for p in section.params}
    raise AssertionError(f'section {header} missing from merged text')


def test_stale_removal_matches_by_param_key():
    """-probe_count: 7,7 against a base already at 3,3 still applies the block."""
    block = """[bed_mesh]
-speed: 500
+speed: 8
-probe_count: 7,7
+probe_count: 3,3"""
    res = apply_mini_diff_block(block, BASE_CFG)
    assert res['applied'], 'stale removal value must not abort the block'
    params = _params(res['text'], '[bed_mesh]')
    assert params['speed'] == '8'
    assert params['probe_count'] == '3,3'
    # untouched params survive — this is exactly what the aborted-block
    # fallback silently destroyed:
    assert params['horizontal_move_z'] == '2'
    assert params['zero_reference_position'] == '175, 175'
    assert params['mesh_pps'] == '10, 10'
    assert params['algorithm'] == 'bicubic'


def test_stale_removal_delete_only_matches_by_key():
    """-speed: 999 (stale value) with no + line still deletes the speed line by key."""
    block = """[bed_mesh]
-speed: 999"""
    res = apply_mini_diff_block(block, BASE_CFG)
    assert res['applied']
    params = _params(res['text'], '[bed_mesh]')
    assert 'speed' not in params
    assert params['probe_count'] == '3,3'


def test_key_fallback_does_not_invent_keys():
    """A removal whose KEY is absent from the section still fails (atomic)."""
    block = """[bed_mesh]
-not_a_param: 7,7
+not_a_param: 3,3"""
    res = apply_mini_diff_block(block, BASE_CFG)
    assert not res['applied']


def test_key_fallback_is_scoped_to_the_section():
    """Key matching operates inside the TARGET section's own lines only:
    [probe] `speed: 3` gets key-matched by a stale `-speed: 500` removal,
    and the block output is the edited section materialized in full
    (untouched sections are the caller's merge job, not this function's)."""
    block = """[probe]
-speed: 500
+speed: 4"""
    res = apply_mini_diff_block(block, BASE_CFG)
    assert res['applied']
    params = _params(res['text'], '[probe]')
    assert params['speed'] == '4'
    assert '[bed_mesh]' not in res['text']  # only edited sections returned


def test_gcode_stale_removal_still_falls_back():
    """Non-param-shaped removals (gcode lines) never key-match."""
    gcode_base = """\
[gcode_macro PARK]
gcode:
    G28 X
    G1 Z5 F1500
"""
    block = """[gcode_macro PARK]
-G1 Z9 F1500
+G1 Z10 F1500"""
    res = apply_mini_diff_block(block, gcode_base)
    assert not res['applied']  # stale gcode content: no param key -> legacy fallback


def test_harness03_end_to_end_no_audit_footer():
    """The exact HARNESS-03 reply against the planted fixture: the merged
    config lands speed=8, and the stated-requirement audit stays silent."""
    content = (
        Path(__file__).resolve().parents[1]
        / 'reference/Trident_backup/printer_data/config/printer.cfg'
    ).read_text(encoding='utf-8')
    base_content = content.replace('probe_count: 7,7', 'probe_count: 3,3', 1)
    assert base_content != content, 'probe_count marker not found in fixture'

    reply = """```cfg
# file: printer.cfg
[bed_mesh]
-speed: 500
+speed: 8
-probe_count: 7,7
+probe_count: 3,3
+mesh_min: 5,5
+mesh_max: 345, 345
```

I updated the `speed` to 8 and the `probe_count` to 3,3 as requested."""

    base = {'printer.cfg': parse_config(base_content, 'printer.cfg')}
    res = apply_reply_to_configs(reply, base)
    merged = {f: e['merged_config'] for f, e in res['files'].items()}
    notes = check_stated_requirements(
        'Set my bed mesh probe speed to 8 in printer.cfg and keep '
        'the current probe_count of 3x3.',
        merged,
    )
    assert notes == [], f'audit footer must stay silent, got: {notes}'
    text = res['files']['printer.cfg']['merged_text']
    i = text.find('[bed_mesh]')
    seg = text[i:i + 500]
    assert 'speed: 8' in seg
    assert 'horizontal_move_z: 2' in seg, 'untouched bed_mesh params must survive'
    assert 'zero_reference_position: 175, 175' in seg


# ── Review finding #12: duplicate-active-key ambiguity must fail closed ──

DUPKEY_CFG = """\
[mcu mcu]
serial: /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
baud: 250000

[mcu EBBCan]
serial: /tmp/EBBCan
canbus_uuid: aabbccddeeff

[printer]
kinematics: corexy
"""


def test_ambiguous_duplicate_key_stale_removal_fails_closed():
    """Two candidate `serial:` lines + a stale value: key-tolerant matching
    must NOT silently pick the first one (wrong-line edit that validation
    cannot see). Fail the block atomically instead."""
    block = """[mcu EBBCan]
-serial: /dev/serial/by-id/usb-stale-wrong-path
+serial: /tmp/EBBCan2"""
    # Target section [mcu EBBCan] has exactly ONE serial line; but a block
    # targeting a file where the SAME header resolves once is unique — this
    # case must APPLY (guards against over-tightening).
    res = apply_mini_diff_block(block, DUPKEY_CFG)
    assert res['applied']
    params = _params(res['text'], '[mcu EBBCan]')
    assert params['serial'] == '/tmp/EBBCan2'


def test_duplicate_key_in_same_section_stale_removal_fails_closed():
    """The true ambiguity: the TARGET section itself has two active lines
    with the same key and the removal value matches neither."""
    base = """[mcu mcu]
serial: /dev/ttyUSB0
serial: /dev/ttyAMA0
baud: 250000
"""
    block = """[mcu mcu]
-serial: /dev/ttyS999
+serial: /dev/ttyUSB5"""
    res = apply_mini_diff_block(block, base)
    assert not res['applied'], (
        'ambiguous duplicate-key key-fallback must fail the block, '
        'never silently pick the first same-key line'
    )


def test_duplicate_key_exact_value_still_matches():
    """Stage-1 exact match is unaffected by duplicate keys: value-true
    removal applies against the matching line, sibling untouched."""
    base = """[mcu mcu]
serial: /dev/ttyUSB0
serial: /dev/ttyAMA0
baud: 250000
"""
    block = """[mcu mcu]
-serial: /dev/ttyAMA0
+serial: /dev/ttyAMA1"""
    res = apply_mini_diff_block(block, base)
    assert res['applied']
    assert 'serial: /dev/ttyUSB0' in res['text']
    assert 'serial: /dev/ttyAMA1' in res['text']
    assert 'serial: /dev/ttyAMA0' not in res['text']


# ── Review finding #5: target resolution mirrors TS inputs ──────────────

MACROS_A = """\
[gcode_macro PARK_A]
gcode:
    G91
"""

MACROS_B = """\
[gcode_macro PARK_B]
gcode:
    G90
"""

REPLY_NO_HINT = """\
Here you go:

```cfg
[gcode_macro NEW_PARK]
gcode:
    G28
```
"""


def _two_file_project():
    from parser.config_parser import parse_config as pc
    return {
        'config/macros_a.cfg': pc(MACROS_A, 'macros_a.cfg'),
        'config/macros_b.cfg': pc(MACROS_B, 'macros_b.cfg'),
    }


def test_active_file_input_breaks_zero_overlap_tie():
    """No hints, no section overlap anywhere: the supplied activeFile wins
    over the old hardcoded first-loaded-file fallback."""
    res = apply_reply_to_configs(
        REPLY_NO_HINT, _two_file_project(), active_file='config/macros_b.cfg',
    )
    assert list(res['files'].keys()) == ['config/macros_b.cfg']


def test_user_hint_texts_resolve_target_without_reply_hint():
    """Reply carries no '# file:' hint but the USER named the file: the
    mention scan sees reply + preceding user messages, mirroring the TS
    hook. (Like TS, the mention must be the loaded path as named — bare
    basenames never match the full 'config/...' path in either engine.)"""
    res = apply_reply_to_configs(
        REPLY_NO_HINT, _two_file_project(),
        active_file='config/macros_a.cfg',
        hint_texts=['edit my config/macros_b.cfg file please'],
    )
    assert list(res['files'].keys()) == ['config/macros_b.cfg']


def test_reply_hint_beats_active_file_and_user_hint():
    """Precedence preserved: explicit '# file:' hint in the reply still wins
    over both other inputs (mirrors TS ?? chain)."""
    reply = REPLY_NO_HINT.replace('```cfg', "```cfg\n# file: macros_a.cfg")
    res = apply_reply_to_configs(
        reply, _two_file_project(),
        active_file='config/macros_b.cfg',
        hint_texts=['edit config/macros_b.cfg'],
    )
    assert list(res['files'].keys()) == ['config/macros_a.cfg']


def test_unknown_active_file_falls_back_to_first_loaded():
    res = apply_reply_to_configs(
        REPLY_NO_HINT, _two_file_project(), active_file='does_not_exist.cfg',
    )
    assert list(res['files'].keys()) == ['config/macros_a.cfg']
