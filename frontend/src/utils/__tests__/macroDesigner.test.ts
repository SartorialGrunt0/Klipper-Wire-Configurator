import { describe, expect, it } from 'vitest';
import type { ConfigFile, ConfigParam, ConfigSection } from '@/types/config';
import type { MacroSourceItem } from '@/types/macroDesigner';
import {
  areEquivalentMacroItems,
  createGcodeMacroSection,
  findMatchingTargetMacroSection,
  isMacroItemUnchangedInSection,
  normalizeMacroGcodeForConfig,
  normalizePlainText,
  parseMacroGcodeFromEditorView,
  parseMacroVariables,
  serializeMacroVariables,
} from '@/utils/macroDesigner';

function makeSection(overrides: Partial<ConfigSection> = {}): ConfigSection {
  return {
    section_type: 'gcode_macro',
    section_name: 'TEST',
    full_header: 'gcode_macro TEST',
    line_number: 10,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
    ...overrides,
  };
}

function makeParam(key: string, value: string, overrides: Partial<ConfigParam> = {}): ConfigParam {
  return {
    key,
    value,
    is_commented_out: false,
    comment: '',
    separator: ':',
    ...overrides,
  };
}

function makeMacro(overrides: Partial<MacroSourceItem> = {}): MacroSourceItem {
  return {
    key: 'config:printer.cfg:gcode_macro TEST:10',
    source: 'config',
    title: 'TEST',
    renameExisting: '',
    description: '',
    variables: '',
    gcode: 'G28\n',
    ...overrides,
  };
}

describe('createGcodeMacroSection', () => {
  it('builds a gcode_macro section with description, rename, variables, gcode', () => {
    const section = createGcodeMacroSection(makeMacro({
      description: 'A test macro',
      renameExisting: '_TEST',
      variables: 'variable_heat: 60\nvariable_fan: 255',
      gcode: 'M104 S{params.TEMP}\n',
    }));

    expect(section.section_type).toBe('gcode_macro');
    expect(section.full_header).toBe('gcode_macro TEST');
    expect(section.params.map((p) => p.key)).toEqual(['description', 'rename_existing', 'variable_heat', 'variable_fan', 'gcode']);
    expect(section.params[0].value).toBe('A test macro');
    expect(section.params[1].value).toBe('_TEST');
    expect(section.params[2].value).toBe('60');
    expect(section.params[4].value).toBe('\nM104 S{params.TEMP}');
  });

  it('normalizes the gcode body for config storage', () => {
    const section = createGcodeMacroSection(makeMacro({ gcode: 'gcode:\n  G28\n' }));
    expect(section.params.find((p) => p.key === 'gcode')?.value).toBe('\n  G28');
  });

  it('preserves header and trailing comments from the existing section', () => {
    const existing = makeSection({
      line_number: 42,
      header_comments: ['# My print start macro', '# Used by START_PRINT'],
      trailing_comments: ['# end of macro'],
    });
    const section = createGcodeMacroSection(makeMacro({ gcode: 'G28\n' }), existing);

    expect(section.header_comments).toEqual(['# My print start macro', '# Used by START_PRINT']);
    expect(section.trailing_comments).toEqual(['# end of macro']);
    expect(section.line_number).toBe(42);
  });

  it('defaults comments to empty when no existing section', () => {
    const section = createGcodeMacroSection(makeMacro());
    expect(section.header_comments).toEqual([]);
    expect(section.trailing_comments).toEqual([]);
  });

  it('sanitizes the section name from the title', () => {
    const section = createGcodeMacroSection(makeMacro({ title: 'My Cool Macro!' }));
    expect(section.section_name).toBe('My_Cool_Macro_');
    expect(section.full_header).toBe('gcode_macro My_Cool_Macro_');
  });
});

describe('findMatchingTargetMacroSection', () => {
  function makeConfigFile(sections: ConfigSection[]): ConfigFile {
    return { filename: 'printer.cfg', sections, includes: [], header_comments: [], raw_text: '' };
  }

  it('matches a config item by header and line number', () => {
    const target = makeSection({ full_header: 'gcode_macro TEST', line_number: 10 });
    const configFiles = { 'printer.cfg': makeConfigFile([
      makeSection({ full_header: 'gcode_macro OTHER', line_number: 5 }),
      target,
    ]) };

    const found = findMatchingTargetMacroSection(configFiles, makeMacro(), 'printer.cfg');
    expect(found).toBe(target);
  });

  it('matches a draft item by header only (first match)', () => {
    const first = makeSection({ full_header: 'gcode_macro TEST', line_number: 10 });
    const second = makeSection({ full_header: 'gcode_macro TEST', line_number: 20 });
    const configFiles = { 'printer.cfg': makeConfigFile([first, second]) };

    const found = findMatchingTargetMacroSection(
      configFiles,
      makeMacro({ source: 'draft', key: 'draft:1', sourceFile: undefined, sourceLine: undefined }),
      'printer.cfg',
    );
    expect(found).toBe(first);
  });

  it('returns null when no section matches', () => {
    const configFiles = { 'printer.cfg': makeConfigFile([makeSection({ full_header: 'gcode_macro OTHER' })]) };
    expect(findMatchingTargetMacroSection(configFiles, makeMacro(), 'printer.cfg')).toBeNull();
  });
});

describe('isMacroItemUnchangedInSection', () => {
  it('returns true when item matches the section content', () => {
    const section = makeSection({
      params: [
        makeParam('gcode', '\nG28'),
        makeParam('description', 'A test macro'),
      ],
    });
    expect(isMacroItemUnchangedInSection(makeMacro({ description: 'A test macro', gcode: 'G28\n' }), section)).toBe(true);
  });

  it('returns false when gcode differs', () => {
    const section = makeSection({ params: [makeParam('gcode', '\nG28')] });
    expect(isMacroItemUnchangedInSection(makeMacro({ gcode: 'G28 X0\n' }), section)).toBe(false);
  });

  it('returns false for a null section', () => {
    expect(isMacroItemUnchangedInSection(makeMacro(), null)).toBe(false);
  });
});

describe('areEquivalentMacroItems', () => {
  it('ignores formatting differences in gcode', () => {
    const base = makeMacro({ gcode: 'G28\nG1 X10 Y10\n' });
    const formatted = makeMacro({ gcode: 'gcode:\nG28\nG1 X10 Y10\n' });
    expect(areEquivalentMacroItems(base, formatted)).toBe(true);
  });

  it('detects real differences', () => {
    const base = makeMacro({ description: 'one' });
    const other = makeMacro({ description: 'two' });
    expect(areEquivalentMacroItems(base, other)).toBe(false);
  });
});

describe('gcode normalization round-trip', () => {
  it('parseMacroGcodeFromEditorView strips a leading gcode: directive', () => {
    expect(parseMacroGcodeFromEditorView('gcode:\n  G28\n  M117 hi')).toBe('  G28\n  M117 hi');
  });

  it('normalizeMacroGcodeForConfig strips leading/trailing blank lines', () => {
    expect(normalizeMacroGcodeForConfig('\n\nG28\n\n')).toBe('\nG28');
  });

  it('normalizeMacroGcodeForConfig returns empty string for blank body', () => {
    expect(normalizeMacroGcodeForConfig('')).toBe('');
    expect(normalizeMacroGcodeForConfig('\n')).toBe('');
  });

  it('preserves comment lines inside the gcode body', () => {
    expect(normalizeMacroGcodeForConfig('# comment\nG28\n')).toBe('\n# comment\nG28');
  });
});

describe('variables round-trip', () => {
  it('serializes and parses variables with comments and blank lines', () => {
    const params: ConfigParam[] = [
      makeParam('variable_heat', '60'),
      { key: '_comment_', value: '', comment: '', is_commented_out: false },
      makeParam('variable_fan', '255', { is_commented_out: true }),
      { key: '_comment_', value: '# a full-line comment', comment: '', is_commented_out: false },
    ];
    const text = serializeMacroVariables({ ...makeSection(), params });
    expect(text).toBe('variable_heat: 60\n\n#variable_fan: 255\n# a full-line comment');

    const reparsed = parseMacroVariables(text);
    expect(reparsed.find((p) => p.key === 'variable_heat')?.value).toBe('60');
    expect(reparsed.find((p) => p.key === 'variable_fan')?.is_commented_out).toBe(true);
  });

  it('parses = separator variables', () => {
    const reparsed = parseMacroVariables('variable_x=1\nvariable_y: 2');
    expect(reparsed[0].key).toBe('variable_x');
    expect(reparsed[0].value).toBe('1');
    expect(reparsed[0].separator).toBe('=');
    expect(reparsed[1].key).toBe('variable_y');
    expect(reparsed[1].separator).toBe(':');
  });
});

describe('normalizePlainText', () => {
  it('normalizes line endings and trims', () => {
    expect(normalizePlainText('  hello\r\nworld\r')).toBe('hello\nworld');
  });
});
