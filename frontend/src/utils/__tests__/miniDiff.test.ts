import { describe, it, expect } from 'vitest';
import {isMiniDiffBlock, classifyMiniDiffLine, fenceUnfencedMiniDiffs} from '../miniDiff';

const LEVEL_BED_SECTION = `[gcode_macro Level_Bed]
#rename_existing: _BED_MESH_CALIBRATE
gcode:
    {% if "xyz" not in printer.toolhead.homed_axes %}
      G28
    {% endif %}
    CLEAN_NOZZLE
    M109 S150
    Z_TILT_ADJUST
    G28 Z
    BED_MESH_CALIBRATE
    M104 S0
`;

describe('isMiniDiffBlock', () => {
  it('detects a section header plus removal lines', () => {
    expect(isMiniDiffBlock(
      '[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1',
    )).toBe(true);
  });

  it('rejects a full-section block (no +/- lines)', () => {
    expect(isMiniDiffBlock(LEVEL_BED_SECTION)).toBe(false);
  });

  it('accepts addition-only blocks (add-only edits have no removal anchor)', () => {
    expect(isMiniDiffBlock('[gcode_macro Level_Bed]\n+    NEW_LINE')).toBe(true);
  });

  it('rejects blocks with delete markers', () => {
    expect(isMiniDiffBlock('[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n*[gcode_macro Other]')).toBe(false);
  });
});

describe('classifyMiniDiffLine', () => {
  it('classifies removal, addition, and context lines', () => {
    expect(classifyMiniDiffLine('-    BED_MESH_CALIBRATE')).toBe('removal');
    expect(classifyMiniDiffLine('+    BED_MESH_CALIBRATE ADAPTIVE=1')).toBe('addition');
    expect(classifyMiniDiffLine('[gcode_macro Level_Bed]')).toBe('context');
    expect(classifyMiniDiffLine('gcode:')).toBe('context');
    expect(classifyMiniDiffLine('')).toBe('context');
  });

  it('treats indented +/- lines as diff markers when they lead the line', () => {
    // Markers are matched with leading-whitespace tolerance: models indent
    // the '-'/'+' to align with a gcode body indentation. The content after
    // the marker is what matters; a mid-line '-' (e.g. 'G1 X-10') is still
    // plain content.
    expect(classifyMiniDiffLine('    - a comment')).toBe('removal');
    expect(classifyMiniDiffLine('  -  Level_Bed')).toBe('removal');
    expect(classifyMiniDiffLine('  +  BED_MESH_CALIBRATE ADAPTIVE=1')).toBe('addition');
    expect(classifyMiniDiffLine('      G1 X-10')).toBe('context');
  });
});

describe('fenceUnfencedMiniDiffs', () => {
  it('wraps an unfenced mini-diff in a cfg fence (the bullet-point bug)', () => {
    const input = `# file: printer.cfg\n[bed_mesh]\n-    algorithm: bicubic\n+    algorithm: bicubic\n+    adaptive_margin: 5\n\nI added adaptive_margin: 5 to the [bed_mesh] section.`;
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toBe(
      '```cfg\n# file: printer.cfg\n[bed_mesh]\n-    algorithm: bicubic\n+    algorithm: bicubic\n+    adaptive_margin: 5\n```\n\nI added adaptive_margin: 5 to the [bed_mesh] section.',
    );
  });

  it('leaves an already-fenced mini-diff untouched', () => {
    const input = '```cfg\n# file: printer.cfg\n[bed_mesh]\n-    algorithm: bicubic\n+    adaptive_margin: 5\n```\n\nDone.';
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toBe(input);
  });

  it('does not wrap a plain bulleted list', () => {
    const input = '- first item\n- second item\n\nSome prose.';
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toBe(input);
  });

  it('does not wrap a full-section block with no +/- markers', () => {
    const input = `# file: printer.cfg\n[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\n`;
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toBe(input);
  });

  it('handles prose after the diff plus a second paragraph', () => {
    const input = `Here you go:\n# file: printer.cfg\n[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1\n\nApplied to the Level_Bed macro.`;
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toBe(
      'Here you go:\n```cfg\n# file: printer.cfg\n[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1\n```\n\nApplied to the Level_Bed macro.',
    );
  });

  it('handles CRLF line endings', () => {
    const input = '# file: printer.cfg\r\n[bed_mesh]\r\n-    algorithm: bicubic\r\n+    adaptive_margin: 5';
    const result = fenceUnfencedMiniDiffs(input);
    expect(result).toContain('```cfg');
    expect(result).toContain('+    adaptive_margin: 5');
  });
});
