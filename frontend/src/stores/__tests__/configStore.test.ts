import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigFile, ConfigParam, ConfigSection, ValidationResult } from '@/types/config';
import { useConfigStore } from '@/stores/configStore';

vi.mock('@/services/api', () => ({
  validateConfig: vi.fn(async (cf: ConfigFile) => ({
    has_errors: false,
    has_warnings: false,
    errors: [],
  })),
  validateProject: vi.fn(async () => ({})),
}));

const validResult: ValidationResult = {
  has_errors: false,
  has_warnings: false,
  errors: [],
};

function makeSection(overrides: Partial<ConfigSection> = {}): ConfigSection {
  return {
    section_type: 'mcu',
    section_name: '',
    full_header: 'mcu',
    line_number: 1,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
    ...overrides,
  };
}

function makeParam(key: string, value = 'x'): ConfigParam {
  return {
    key,
    value,
    is_commented_out: false,
    comment: '',
    separator: ':',
  };
}

function makeConfigFile(sections: ConfigSection[] = [makeSection()]): ConfigFile {
  return {
    filename: 'printer.cfg',
    sections,
    includes: [],
    header_comments: [],
    raw_text: '',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useConfigStore.setState({
    configFiles: {},
    activeFile: 'printer.cfg',
    validation: {},
    schemas: {},
    selectedSection: null,
    originalTexts: {},
    isDirty: false,
    textParseErrors: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('configStore file operations', () => {
  it('setConfigFile adds a file and preserves others', () => {
    useConfigStore.getState().setConfigFile('a.cfg', makeConfigFile());
    useConfigStore.getState().setConfigFile('b.cfg', makeConfigFile());
    expect(Object.keys(useConfigStore.getState().configFiles)).toEqual(['a.cfg', 'b.cfg']);
  });

  it('removeConfigFile deletes file, validation, and resets active file', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('a.cfg', makeConfigFile());
    store.setConfigFile('b.cfg', makeConfigFile());
    store.setActiveFile('a.cfg');
    store.setValidation('a.cfg', validResult);
    store.setTextParseError('a.cfg', 'boom');

    useConfigStore.getState().removeConfigFile('a.cfg');

    const state = useConfigStore.getState();
    expect(state.configFiles['a.cfg']).toBeUndefined();
    expect(state.validation['a.cfg']).toBeUndefined();
    expect(state.textParseErrors['a.cfg']).toBeUndefined();
    expect(state.activeFile).toBe('b.cfg');
    expect(state.isDirty).toBe(true);
  });

  it('removeConfigFile falls back to printer.cfg when no files remain', () => {
    useConfigStore.getState().setConfigFile('a.cfg', makeConfigFile());
    useConfigStore.getState().setActiveFile('a.cfg');
    useConfigStore.getState().removeConfigFile('a.cfg');
    expect(useConfigStore.getState().activeFile).toBe('printer.cfg');
  });

  it('renameConfigFile moves the file and rewrites includes in other files', () => {
    const store = useConfigStore.getState();
    const a = makeConfigFile();
    const b = makeConfigFile();
    b.includes = ['a.cfg'];
    store.setConfigFile('a.cfg', a);
    store.setConfigFile('b.cfg', b);
    store.setTextParseError('a.cfg', 'boom');

    useConfigStore.getState().renameConfigFile('a.cfg', 'renamed.cfg');

    const state = useConfigStore.getState();
    expect(state.configFiles['a.cfg']).toBeUndefined();
    expect(state.configFiles['renamed.cfg'].filename).toBe('renamed.cfg');
    expect(state.configFiles['b.cfg'].includes).toEqual(['renamed.cfg']);
    expect(state.textParseErrors['a.cfg']).toBeUndefined();
    expect(state.textParseErrors['renamed.cfg']).toBe('boom');
  });

  it('renameConfigFile refuses to overwrite an existing target', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('a.cfg', makeConfigFile());
    store.setConfigFile('b.cfg', makeConfigFile());
    useConfigStore.getState().renameConfigFile('a.cfg', 'b.cfg');
    expect(useConfigStore.getState().configFiles['b.cfg']).toBeDefined();
    expect(useConfigStore.getState().configFiles['a.cfg']).toBeDefined();
  });

  it('copyConfigFile deep-copies sections and params', () => {
    const store = useConfigStore.getState();
    const section = makeSection({
      params: [makeParam('serial'), makeParam('baud')],
    });
    store.setConfigFile('a.cfg', makeConfigFile([section]));

    useConfigStore.getState().copyConfigFile('a.cfg', 'copy.cfg');

    const copy = useConfigStore.getState().configFiles['copy.cfg'];
    expect(copy.filename).toBe('copy.cfg');
    expect(copy.sections[0].params[0].key).toBe('serial');
    // Section container is a new object...
    expect(copy.sections[0]).not.toBe(section);
    // ...and so is every param object and the params array itself
    expect(copy.sections[0].params).not.toBe(section.params);
    expect(copy.sections[0].params[0]).not.toBe(section.params[0]);
    expect(copy.sections[0].params[1]).not.toBe(section.params[1]);
    // Editing the copy must not leak into the original
    copy.sections[0].params[0].value = '/dev/ttyACM9';
    expect(section.params[0].value).toBe('x');
  });

  it('loadConfigs sets files and clears dirty state', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('a.cfg', makeConfigFile());
    store.markDirty();
    store.setTextParseError('a.cfg', 'stale boom');
    useConfigStore.getState().loadConfigs({ 'new.cfg': makeConfigFile() });
    const state = useConfigStore.getState();
    expect(Object.keys(state.configFiles)).toEqual(['new.cfg']);
    expect(state.activeFile).toBe('new.cfg');
    expect(state.isDirty).toBe(false);
    expect(state.textParseErrors).toEqual({});
  });

  it('clearAll resets everything', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('a.cfg', makeConfigFile());
    store.markDirty();
    store.setTextParseError('a.cfg', 'stale boom');
    useConfigStore.getState().clearAll();
    const state = useConfigStore.getState();
    expect(state.configFiles).toEqual({});
    expect(state.activeFile).toBe('printer.cfg');
    expect(state.isDirty).toBe(false);
    expect(state.textParseErrors).toEqual({});
  });
});

describe('configStore section operations', () => {
  it('addSection appends and marks dirty', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([]));
    useConfigStore.getState().addSection('printer.cfg', makeSection({ section_type: 'extruder', full_header: 'extruder' }));
    const state = useConfigStore.getState();
    expect(state.configFiles['printer.cfg'].sections).toHaveLength(1);
    expect(state.configFiles['printer.cfg'].sections[0].section_type).toBe('extruder');
    expect(state.isDirty).toBe(true);
  });

  it('updateSectionParam updates only the matching param', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([
      makeSection({ params: [makeParam('serial', 'old'), makeParam('baud', '250000')] }),
    ]));

    useConfigStore.getState().updateSectionParam('printer.cfg', 'mcu', 'serial', 'new');

    const params = useConfigStore.getState().configFiles['printer.cfg'].sections[0].params;
    expect(params.find((p) => p.key === 'serial')?.value).toBe('new');
    expect(params.find((p) => p.key === 'baud')?.value).toBe('250000');
  });

  it('addParam appends a parameter', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile());
    useConfigStore.getState().addParam('printer.cfg', 'mcu', makeParam('new_key'));
    const params = useConfigStore.getState().configFiles['printer.cfg'].sections[0].params;
    expect(params.some((p) => p.key === 'new_key')).toBe(true);
  });

  it('removeParam removes the parameter', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([makeSection({ params: [makeParam('serial')] })]));
    useConfigStore.getState().removeParam('printer.cfg', 'mcu', 'serial');
    expect(useConfigStore.getState().configFiles['printer.cfg'].sections[0].params).toHaveLength(0);
  });

  it('toggleParamCommented flips is_commented_out', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([makeSection({ params: [makeParam('serial')] })]));
    useConfigStore.getState().toggleParamCommented('printer.cfg', 'mcu', 'serial');
    let params = useConfigStore.getState().configFiles['printer.cfg'].sections[0].params;
    expect(params[0].is_commented_out).toBe(true);
    useConfigStore.getState().toggleParamCommented('printer.cfg', 'mcu', 'serial');
    params = useConfigStore.getState().configFiles['printer.cfg'].sections[0].params;
    expect(params[0].is_commented_out).toBe(false);
  });

  it('upsertSection replaces an existing section by header', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([makeSection({ full_header: 'mcu' })]));
    useConfigStore.getState().upsertSection(
      'printer.cfg',
      makeSection({ full_header: 'mcu', params: [makeParam('serial', 'zzz')] }),
    );
    const sections = useConfigStore.getState().configFiles['printer.cfg'].sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].params[0].value).toBe('zzz');
  });

  it('upsertSection appends when header does not exist', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([makeSection()]));
    useConfigStore.getState().upsertSection('printer.cfg', makeSection({ full_header: 'heater_bed', section_type: 'heater_bed' }));
    const sections = useConfigStore.getState().configFiles['printer.cfg'].sections;
    expect(sections.map((s) => s.full_header)).toEqual(['mcu', 'heater_bed']);
  });

  it('removeSection removes the matching section', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([
      makeSection({ full_header: 'mcu' }),
      makeSection({ full_header: 'extruder', section_type: 'extruder' }),
    ]));
    useConfigStore.getState().removeSection('printer.cfg', 'mcu');
    const sections = useConfigStore.getState().configFiles['printer.cfg'].sections;
    expect(sections.map((s) => s.full_header)).toEqual(['extruder']);
  });
});

describe('configStore includes', () => {
  it('addInclude inserts a section at the top and records the include', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([makeSection()]));
    useConfigStore.getState().addInclude('printer.cfg', 'macros.cfg');
    const state = useConfigStore.getState();
    const cf = state.configFiles['printer.cfg'];
    expect(cf.includes).toEqual(['macros.cfg']);
    expect(cf.sections[0].section_type).toBe('include');
    expect(cf.sections[0].section_name).toBe('macros.cfg');
    expect(state.isDirty).toBe(true);
  });

  it('addInclude reactivates an existing commented include instead of duplicating', () => {
    const commented = makeSection({
      section_type: 'include',
      section_name: 'macros.cfg',
      full_header: 'include macros.cfg',
      is_commented_out: true,
    });
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([commented]));
    useConfigStore.getState().addInclude('printer.cfg', 'macros.cfg');
    const sections = useConfigStore.getState().configFiles['printer.cfg'].sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].is_commented_out).toBe(false);
  });

  it('removeInclude comments out the section and drops the include path', () => {
    const inc = makeSection({
      section_type: 'include',
      section_name: 'macros.cfg',
      full_header: 'include macros.cfg',
    });
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile([inc]));
    useConfigStore.getState().removeInclude('printer.cfg', 'macros.cfg');
    const state = useConfigStore.getState();
    const cf = state.configFiles['printer.cfg'];
    expect(cf.includes).toEqual([]);
    expect(cf.sections[0].is_commented_out).toBe(true);
  });
});

describe('configStore dirty / text parse error tracking', () => {
  it('setTextParseError records per-file errors; null clears them', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile());
    useConfigStore.getState().setTextParseError('printer.cfg', 'boom');
    expect(useConfigStore.getState().textParseErrors['printer.cfg']).toBe('boom');

    useConfigStore.getState().setTextParseError('printer.cfg', null);
    expect(useConfigStore.getState().textParseErrors['printer.cfg']).toBeUndefined();
  });

  it('markClean clears the dirty flag', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile());
    store.markDirty();
    useConfigStore.getState().markClean();
    const state = useConfigStore.getState();
    expect(state.isDirty).toBe(false);
  });
});

describe('configStore validation helpers', () => {
  it('getSection finds a section by header', () => {
    const store = useConfigStore.getState();
    const section = makeSection({ full_header: 'mcu' });
    store.setConfigFile('printer.cfg', makeConfigFile([section]));
    const found = useConfigStore.getState().getSection('printer.cfg', 'mcu');
    expect(found).toBe(section);
  });

  it('getSection returns undefined for a missing section', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile());
    expect(useConfigStore.getState().getSection('printer.cfg', 'nope')).toBeUndefined();
  });

  it('getSectionErrors collects error messages for a header', () => {
    const store = useConfigStore.getState();
    store.setConfigFile('printer.cfg', makeConfigFile());
    store.setValidation('printer.cfg', {
      has_errors: true,
      has_warnings: false,
      errors: [
        { section: 'mcu', severity: 'error', message: 'missing serial', param: 'serial', line_number: 1 },
        { section: 'mcu', severity: 'warning', message: 'ignored warning', param: 'x', line_number: 1 },
        { section: 'other', severity: 'error', message: 'other section', param: '', line_number: 2 },
      ],
    });
    const errors = useConfigStore.getState().getSectionErrors('mcu');
    expect(errors).toEqual(['missing serial']);
  });
});
