import { describe, it, expect } from 'vitest';
import {
  findUnclosedJinjaBlocks,
  repairUnclosedJinjaBlock,
  repairUnclosedJinjaInSectionText,
  repairUnclosedJinjaInConfigText,
  stripInlineComment,
} from '../jinjaBlockRepair';

describe('stripInlineComment', () => {
  it('strips # unconditionally', () => {
    expect(stripInlineComment('    G28 # home')).toBe('    G28 ');
  });

  it('strips ; only when whitespace-preceded (keeps the ; like Klipper)', () => {
    expect(stripInlineComment('    G28 ; home')).toBe('    G28 ;');
    expect(stripInlineComment("    {% set x = 'a;b' %}")).toBe("    {% set x = 'a;b' %}");
  });
});

describe('findUnclosedJinjaBlocks', () => {
  it('returns empty for balanced bodies', () => {
    const body = [
      '    {% if printer.toolhead.homed_axes %}',
      '      G28',
      '    {% endif %}',
      '    BED_MESH_CALIBRATE',
    ].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual([]);
  });

  it('finds a single trailing unclosed if', () => {
    const body = ['    {% if printer.toolhead.homed_axes %}', '      G28'].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual(['if']);
  });

  it('keeps open order for nested blocks', () => {
    const body = ['    {% if x %}', '      {% for item in list %}', '        M117 {{ item }}'].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual(['if', 'for']);
  });

  it('ignores tags inside a # comment line', () => {
    const body = ['    # {% if ignored %}', '    G28'].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual([]);
  });

  it('handles else/elif without stack changes', () => {
    const body = [
      '    {% if x %}',
      '      A',
      '    {% else %}',
      '      B',
      '    {% endif %}',
    ].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual([]);
  });

  it('treats tags inside raw as literal', () => {
    const body = [
      '    {% raw %}',
      '      {% if not_a_tag %}',
      '    {% endraw %}',
    ].join('\n');
    expect(findUnclosedJinjaBlocks(body)).toEqual([]);
  });
});

describe('repairUnclosedJinjaBlock', () => {
  it('returns null when balanced', () => {
    expect(repairUnclosedJinjaBlock('    {% if x %}\n      A\n    {% endif %}')).toBeNull();
  });

  it('appends a single endif at the end', () => {
    const body = '    {% if printer.toolhead.homed_axes %}\n      G28';
    const repair = repairUnclosedJinjaBlock(body);
    expect(repair).not.toBeNull();
    expect(repair?.added).toEqual(['    {% endif %}']);
    expect(repair?.repaired.endsWith('    {% endif %}')).toBe(true);
  });

  it('closes nested blocks innermost-first', () => {
    const body = '    {% if x %}\n      {% for item in list %}\n        M117 {{ item }}';
    const repair = repairUnclosedJinjaBlock(body);
    expect(repair?.added).toEqual(['      {% endfor %}', '    {% endif %}']);
  });
});

describe('repairUnclosedJinjaInSectionText', () => {
  const section = [
    '[gcode_macro Level_Bed]',
    'description: Home + mesh',
    'gcode:',
    '    {% if "xyz" not in printer.toolhead.homed_axes %}',
    '      G28',
    '    M104 S0',
  ].join('\n');

  it('appends closers at the end of the gcode body (before a following param)', () => {
    const sectionWithTail = [
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      '      G28',
      'description: tail param',
    ].join('\n');
    const repair = repairUnclosedJinjaInSectionText(sectionWithTail);
    expect(repair).not.toBeNull();
    expect(repair?.added).toEqual(['    {% endif %}']);
    // The closer lands inside the gcode body, before the next param.
    expect(repair?.text).toBe([
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      '      G28',
      '    {% endif %}',
      'description: tail param',
    ].join('\n'));
  });

  it('returns null when balanced', () => {
    const balanced = [
      '[gcode_macro M109]',
      'gcode:',
      '    {% if x %}',
      '      M104 S0',
      '    {% endif %}',
    ].join('\n');
    expect(repairUnclosedJinjaInSectionText(balanced)).toBeNull();
  });

  it('returns null when there is no gcode param', () => {
    expect(repairUnclosedJinjaInSectionText('[extruder]\nmax_temp: 300')).toBeNull();
  });

  it('repairs an UNINDENTED gcode body at its true end (screenshot case)', () => {
    // Model emitted the {% if %} indented but the body at column 0 and no
    // {% endif %} — Klipper treats every non-key line as a continuation, so
    // the closer belongs AFTER the last body line, not after the if-line.
    const section = [
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      'CLEAN_NOZZLE',
      'M109 S150',
      'Z_TILT_ADJUST',
      'G28 Z',
      'BED_MESH_CALIBRATE ADAPTIVE=1',
      'M104 S0',
    ].join('\n');
    const repair = repairUnclosedJinjaInSectionText(section);
    expect(repair).not.toBeNull();
    expect(repair?.added).toEqual(['    {% endif %}']);
    expect(repair?.text).toBe([
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      'CLEAN_NOZZLE',
      'M109 S150',
      'Z_TILT_ADJUST',
      'G28 Z',
      'BED_MESH_CALIBRATE ADAPTIVE=1',
      'M104 S0',
      '    {% endif %}',
    ].join('\n'));
  });
});

describe('repairUnclosedJinjaInConfigText', () => {
  it('repairs macro sections and reports their headers', () => {
    const cfg = [
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if "xyz" not in printer.toolhead.homed_axes %}',
      '      G28',
      '',
      '[extruder]',
      'max_temp: 300',
    ].join('\n');
    const result = repairUnclosedJinjaInConfigText(cfg);
    expect(result.repairedSections).toEqual(['gcode_macro Level_Bed']);
    expect(result.text).toContain('    {% endif %}');
    expect(result.text).toContain('[extruder]');
    expect(result.text).toContain('max_temp: 300');
  });

  it('repairs multiple macro sections', () => {
    const cfg = [
      '[gcode_macro A]',
      'gcode:',
      '    {% if x %}',
      '',
      '[delayed_gcode B]',
      'gcode:',
      '    {% for i in range(3) %}',
    ].join('\n');
    const result = repairUnclosedJinjaInConfigText(cfg);
    expect(result.repairedSections).toEqual(['gcode_macro A', 'delayed_gcode B']);
    expect(result.text).toContain('{% endif %}');
    expect(result.text).toContain('{% endfor %}');
  });

  it('leaves balanced configs untouched', () => {
    const cfg = ['[gcode_macro M109]', 'gcode:', '    M104 S0'].join('\n');
    const result = repairUnclosedJinjaInConfigText(cfg);
    expect(result.repairedSections).toEqual([]);
    expect(result.text).toBe(cfg);
  });

  it('preserves the # file: hint when a repair fires', () => {
    const cfg = [
      '# file: printer.cfg',
      '[gcode_macro Level_Bed]',
      'gcode:',
      '    {% if x %}',
      '    G28',
    ].join('\n');
    const result = repairUnclosedJinjaInConfigText(cfg);
    expect(result.repairedSections).toEqual(['gcode_macro Level_Bed']);
    expect(result.text.startsWith('# file: printer.cfg\n')).toBe(true);
    expect(result.text).toContain('{% endif %}');
  });
});
