import { describe, it, expect } from 'vitest';
import { isMiniDiffBlock, applyMiniDiffBlock, classifyMiniDiffLine, fenceUnfencedMiniDiffs } from '../miniDiff';

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

  it('detects indented markers and ignores context lines in a gcode body', () => {
    // Regression: the model emitted the mini-diff with the '-'/'+' markers
    // INDENTED to align with the gcode body (plus context lines and '...'
    // placeholders). Column-0-only detection missed it, the block fell
    // through to full-section handling, and the whole macro was replaced
    // with the literal snippet.
    const base = `[gcode_macro PRINT_START]
gcode:
    RESPOND TYPE=error MSG='Level_Bed'
    Level_Bed
    BED_MESH_PROFILE LOAD=default
    M104 S0
`;
    const result = applyMiniDiffBlock(
      `[gcode_macro PRINT_START]
gcode:
  ...
  RESPOND TYPE=error MSG='Level_Bed'
  -  Level_Bed
  +  BED_MESH_CALIBRATE ADAPTIVE=1
  BED_MESH_PROFILE LOAD=default
  ...
`,
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain("RESPOND TYPE=error MSG='Level_Bed'");
    expect(result.text).toContain('BED_MESH_CALIBRATE ADAPTIVE=1');
    expect(result.text).not.toContain('-  Level_Bed');
    expect(result.text).not.toContain('+  BED_MESH_CALIBRATE');
    expect(result.text).not.toContain('...');
    // Unchanged lines survive verbatim.
    expect(result.text).toContain("RESPOND TYPE=error MSG='Level_Bed'");
    expect(result.text).toContain('BED_MESH_PROFILE LOAD=default');
    expect(result.text).toContain('M104 S0');
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

  it('does not sweep the NEXT section\'s comment banner into an add-only edit', () => {
    // Regression: [bed_mesh] is followed by the `##########` / `# print_start
    // macro` banner that the parser attaches to [gcode_macro print_start] as
    // header_comments. The old section extent ran to the next header and
    // swallowed the banner, so the addition was appended AFTER it and the
    // parse→merge pipeline duplicated the banner in the review diff (phantom
    // "+ # print_start macro" added lines).
    const base = `[bed_mesh]
speed: 120
algorithm: bicubic
##########
# print_start macro
##########
[gcode_macro print_start]
gcode:
    M117 hello
`;
    const result = applyMiniDiffBlock('[bed_mesh]\n+adaptive_margin: 5', base);
    expect(result.applied).toBe(true);
    expect(result.text).toContain('adaptive_margin: 5');
    // The banner is NOT part of the materialized [bed_mesh] section.
    expect(result.text).not.toContain('# print_start macro');
    expect(result.text).not.toContain('##########');
    // The addition lands with the params, after the last param line.
    expect(result.text.split('\n')).toEqual([
      '[bed_mesh]',
      'speed: 120',
      'algorithm: bicubic',
      'adaptive_margin: 5',
    ]);
  });

  it('does not sweep the NEXT section\'s comment banner into a replacement edit', () => {
    const base = `[bed_mesh]
algorithm: bicubic
##########
# print_start macro
##########
[gcode_macro print_start]
`;
    const result = applyMiniDiffBlock(
      '[bed_mesh]\n-algorithm: bicubic\n+algorithm: bicubic\n+adaptive_margin: 5',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text.split('\n')).toEqual([
      '[bed_mesh]',
      'algorithm: bicubic',
      'adaptive_margin: 5',
    ]);
  });

  it('preserves trailing comments after a gcode-like body (part of the value)', () => {
    // Exemption: the parser folds a trailing column-0 comment after a gcode
    // body into the multi-line value, so the mini-diff must NOT trim it.
    const base = `[gcode_macro X]
gcode:
    G28
# end of macro
[next_section]
pin: PB0
`;
    const result = applyMiniDiffBlock(
      '[gcode_macro X]\n+    M117 done',
      base,
    );
    expect(result.applied).toBe(true);
    expect(result.text).toContain('    M117 done');
    expect(result.text).toContain('# end of macro');
    expect(result.text).not.toContain('[next_section]');
    expect(result.text).not.toContain('pin: PB0');
  });

  it('keeps trailing blank lines of the last section in the file', () => {
    const base = `[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\n`;
    const result = applyMiniDiffBlock('[bed_mesh]\n+adaptive_margin: 10', base);
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\nadaptive_margin: 10\n`);
  });

  it('keeps comment lines BETWEEN params while trimming the trailing banner', () => {
    // The banner trim must only remove the trailing comment block that belongs
    // to the NEXT section — comment lines inside the section (between params)
    // are section content and must survive the materialization.
    const base = `[bed_mesh]
mesh_min: 25, 25
# probe grid note
mesh_max: 345, 345
algorithm: bicubic
##########
# print_start macro
##########
[gcode_macro print_start]
`;
    const result = applyMiniDiffBlock('[bed_mesh]\n+adaptive_margin: 5', base);
    expect(result.applied).toBe(true);
    expect(result.text.split('\n')).toEqual([
      '[bed_mesh]',
      'mesh_min: 25, 25',
      '# probe grid note',
      'mesh_max: 345, 345',
      'algorithm: bicubic',
      'adaptive_margin: 5',
    ]);
  });

  it('strips the marker separator space from add-only additions on plain sections', () => {
    // Regression: models write "+ value" with a space after the marker (or
    // indent everything 4 spaces). Kept verbatim, the leading whitespace made
    // the parser fold the addition into the PREVIOUS param's value as an
    // indented continuation line, corrupting the config.
    const base = `[printer]\nkinematics: corexy\nmax_velocity: 600\nmax_accel: 15500\n`;
    const result = applyMiniDiffBlock('[printer]\n+ max_accel: 13000', base);
    expect(result.applied).toBe(true);
    expect(result.text).toContain('\nmax_accel: 13000');
    expect(result.text).not.toContain('\n max_accel: 13000');
  });

  it('strips the model\'s blanket 4-space indent from add-only additions on plain sections', () => {
    const base = `[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\n`;
    const result = applyMiniDiffBlock('[bed_mesh]\n+    adaptive_margin: 10', base);
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[bed_mesh]\nmesh_min: 10, 10\nmesh_max: 290, 290\nadaptive_margin: 10\n`);
  });

  it('strips the separator space from add-only comment lines on plain sections', () => {
    const base = `[printer]\nkinematics: corexy\nmax_velocity: 600\n`;
    const result = applyMiniDiffBlock('[printer]\n+ # tuned value\n+ max_accel: 13000', base);
    expect(result.applied).toBe(true);
    expect(result.text).toContain('\n# tuned value\nmax_accel: 13000');
  });

  it('keeps gcode body line indentation for add-only additions (space is content)', () => {
    // Gcode-like bodies are exempt from the trim: models indent body lines
    // exactly as they want them, so "+    M117 done" stays 4-space.
    const base = `[gcode_macro X]\ngcode:\n    G28\n\n`;
    const result = applyMiniDiffBlock('[gcode_macro X]\n+    M117 done', base);
    expect(result.applied).toBe(true);
    expect(result.text).toBe(`[gcode_macro X]\ngcode:\n    G28\n    M117 done\n\n`);
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
