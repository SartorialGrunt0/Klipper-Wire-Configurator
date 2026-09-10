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
