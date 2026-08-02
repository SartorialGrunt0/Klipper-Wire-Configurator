import { describe, it, expect } from 'vitest';
import { isMiniDiffBlock, applyMiniDiffBlock, classifyMiniDiffLine } from '../miniDiff';

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

  it('does not treat indented +/- lines as diff markers', () => {
    // Mini-diff markers sit at column 0; indented lines are config content.
    expect(classifyMiniDiffLine('    - a comment')).toBe('context');
    expect(classifyMiniDiffLine('      G1 X-10')).toBe('context');
  });
});

describe('applyMiniDiffBlock', () => {
  it('applies a single line replacement and preserves the rest verbatim', () => {
    const result = applyMiniDiffBlock(
      '[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1',
      LEVEL_BED_SECTION,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('BED_MESH_CALIBRATE ADAPTIVE=1');
    // The critical invariant: Jinja tags and unchanged lines survive intact.
    expect(result.text).toContain('{% if "xyz" not in printer.toolhead.homed_axes %}');
    expect(result.text).toContain('{% endif %}');
    expect(result.text).toContain('    G28');
    expect(result.text).toContain('CLEAN_NOZZLE');
    expect(result.text).toContain('M104 S0');
    expect(result.text).not.toContain('\n    BED_MESH_CALIBRATE\n');
    expect(result.text.split('\n')).toEqual([
      '[gcode_macro Level_Bed]',
      '#rename_existing: _BED_MESH_CALIBRATE',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      '      G28',
      '    {% endif %}',
      '    CLEAN_NOZZLE',
      '    M109 S150',
      '    Z_TILT_ADJUST',
      '    G28 Z',
      '    BED_MESH_CALIBRATE ADAPTIVE=1',
      '    M104 S0',
      '',
    ]);
  });

  it('supports multiple removals and multi-line additions in one block', () => {
    const base = `[extruder]
step_pin: PB4
dir_pin: !PB5
microsteps: sixteen
rotation_distance: 100
heater_pin: PB6
`;
    const result = applyMiniDiffBlock(
      '[extruder]\n-rotation_distance: 100\n+rotation_distance: 101\n+gear_ratio: 1:1\n-microsteps: sixteen\n+microsteps: 32',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[extruder]
step_pin: PB4
dir_pin: !PB5
microsteps: 32
rotation_distance: 101
gear_ratio: 1:1
heater_pin: PB6
`);
  });

  it('supports multiple sections in one block', () => {
    const base = `[fan]
pin: PB0

[heater_fan partfan]
pin: PB1
`;
    const result = applyMiniDiffBlock(
      '[fan]\n-pin: PB0\n+pin: PB9\n\n[heater_fan partfan]\n-pin: PB1\n+pin: PB10',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('pin: PB9');
    expect(result.text).toContain('pin: PB10');
    expect(result.text).toContain('[heater_fan partfan]');
  });

  it('ignores non-diff context lines inside the block', () => {
    const result = applyMiniDiffBlock(
      '[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1\n# context comment',
      LEVEL_BED_SECTION,
    );
    expect(result.applied).toBe(true);
    expect(result.text).not.toContain('# context comment');
  });

  it('returns applied=false when a removal has no match in the base', () => {
    const result = applyMiniDiffBlock(
      '[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE XYZ\n+    BED_MESH_CALIBRATE ADAPTIVE=1',
      LEVEL_BED_SECTION,
    );
    expect(result.applied).toBe(false);
  });

  it('returns applied=false for non-mini-diff blocks', () => {
    const result = applyMiniDiffBlock(LEVEL_BED_SECTION, LEVEL_BED_SECTION);
    expect(result.applied).toBe(false);
    expect(result.text).toBe(LEVEL_BED_SECTION);
  });

  it('normalizes trailing whitespace and CRLF when matching', () => {
    const base = 'gcode:\n    BED_MESH_CALIBRATE\r\n    M104 S0\r\n';
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n-    BED_MESH_CALIBRATE \n+    BED_MESH_CALIBRATE ADAPTIVE=1',
      `[gcode_macro X]\ngcode:\n    BED_MESH_CALIBRATE\r\n    M104 S0\r\n`,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe('[gcode_macro X]\ngcode:\n    BED_MESH_CALIBRATE ADAPTIVE=1\n    M104 S0\n');
  });

  it('returns only the changed sections, not the whole file', () => {
    // Regression guard: the output must contain ONLY the edited section so the
    // section-merge touches just that section (untouched sections would go
    // through the param-key merge, which conflates duplicate keys like the
    // three `serial` lines in [mcu] and produces a noisy review diff).
    const base = [
      '[mcu]',
      'serial: /dev/ttyS0',
      '',
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    BED_MESH_CALIBRATE',
      '    M104 S0',
      '',
      '[fan]',
      'pin: PB0',
    ].join('\n');
    const result = applyMiniDiffBlock(
      '[gcode_macro Level_Bed]\n-    BED_MESH_CALIBRATE\n+    BED_MESH_CALIBRATE ADAPTIVE=1',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('BED_MESH_CALIBRATE ADAPTIVE=1');
    expect(result.text).not.toContain('[mcu]');
    expect(result.text).not.toContain('serial:');
    expect(result.text).not.toContain('[fan]');
    expect(result.text).not.toContain('pin: PB0');
  });

  it('leaves the section unchanged when a removal matches twice and only one is targeted', () => {
    const base = `[gcode_macro X]
gcode:
    G28
    G28
`;
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n-    G28\n+    G28 X0',
      base,
    );
    expect(result.applied).toBe(true);
    // First occurrence is replaced, the second stays.
    expect(result.text).toContain('G28 X0');
    const occurrences = result.text.match(/G28/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it('matches an indented removal against a column-0 file line', () => {
    // Regression: the model emitted a 4-space-indented mini-diff for the
    // column-0 [printer] lines; exact matching failed, the block fell back
    // to legacy full-section handling and mangled the section.
    const base = `[printer]
kinematics: corexy
max_velocity: 600
max_accel: 15500 #Ellis Tuned
`;
    const result = applyMiniDiffBlock(
      '[printer]\n-    max_accel: 15500 #Ellis Tuned\n+    max_accel: 18000 #Ellis Tuned',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[printer]
kinematics: corexy
max_velocity: 600
max_accel: 18000 #Ellis Tuned
`);
    // The other params survive (this was the mangling case).
    expect(result.text).toContain('kinematics: corexy');
    expect(result.text).toContain('max_velocity: 600');
  });

  it('inherits the file indentation when the base line is indented', () => {
    const base = `[printer]\n    max_accel: 15500\n`;
    const result = applyMiniDiffBlock(
      '[printer]\n-max_accel: 15500\n+max_accel: 18000',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('    max_accel: 18000');
  });

  it('preserves inner indentation of multi-line additions in the tolerant path', () => {
    const base = `[gcode_macro X]\ngcode:\n    G28\n`;
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n-  G28\n+  G28 X0\n+    M117 homed',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('    G28 X0');
    expect(result.text).toContain('      M117 homed');
  });

  it('still fails when content differs despite indentation tolerance', () => {
    const base = `[printer]\nmax_accel: 15500\n`;
    const result = applyMiniDiffBlock(
      '[printer]\n-    max_accel: 99999\n+    max_accel: 18000',
      base,
    );
    expect(result.applied).toBe(false);
  });

  it('appends add-only lines at the end of a plain section', () => {
    const base = `[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\n`;
    const result = applyMiniDiffBlock(
      '[bed_mesh]\n+adaptive_margin: 10',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\nadaptive_margin: 10\n`);
  });

  it('appends add-only lines at the end of a macro body before trailing blanks', () => {
    const base = `[gcode_macro X]\ngcode:\n    G28\n\n`;
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n+    M117 done',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[gcode_macro X]\ngcode:\n    G28\n    M117 done\n\n`);
  });

  it('supports delete-only mini-diffs (removal with no additions)', () => {
    const base = `[gcode_macro X]\ngcode:\n    G28\n    M104 S0\n`;
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n-    M104 S0',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[gcode_macro X]\ngcode:\n    G28\n`);
  });
});
