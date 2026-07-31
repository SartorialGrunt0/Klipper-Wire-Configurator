import { describe, expect, it } from 'vitest';
import {
  DELETE_MARKER_RE,
  mergeAssistantSectionsIntoConfig,
  preprocessDeleteMarkers,
} from '@/utils/assistantDraftMerge';
import type { ConfigFile, ConfigSection } from '@/types/config';

function section(overrides: Partial<ConfigSection>): ConfigSection {
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

function param(key: string, value: string, extra: Partial<ConfigSection['params'][number]> = {}) {
  return { key, value, is_commented_out: false, comment: '', separator: ':', ...extra };
}

function config(sections: ConfigSection[]): ConfigFile {
  return {
    filename: 'printer.cfg',
    sections,
    includes: [],
    header_comments: [],
    raw_text: '',
  };
}

describe('preprocessDeleteMarkers', () => {
  it('converts *[section] markers into delete_section blocks', () => {
    const out = preprocessDeleteMarkers('*[probe]\n*[bltouch]\n');
    expect(out).toContain('[delete_section]\nsection: probe');
    expect(out).toContain('[delete_section]\nsection: bltouch');
  });

  it('leaves ordinary text untouched', () => {
    const text = '[mcu]\nserial: xyz\n';
    expect(preprocessDeleteMarkers(text)).toBe(text);
  });

  it('exposes the marker regex', () => {
    expect('*[bed_mesh]'.match(DELETE_MARKER_RE)).not.toBeNull();
    expect('[bed_mesh]'.match(DELETE_MARKER_RE)).toBeNull();
  });
});

describe('mergeAssistantSectionsIntoConfig', () => {
  it('updates an existing section and merges params', () => {
    const base = config([
      section({ full_header: 'mcu', params: [param('serial', 'old'), param('baud', '250000')] }),
    ]);
    const assistant = config([
      section({ full_header: 'mcu', params: [param('serial', 'new'), param('extra', '1')] }),
    ]);
    const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(changes).toEqual([{ id: 'printer.cfg:0:mcu', filename: 'printer.cfg', fullHeader: 'mcu', mode: 'update' }]);
    const merged = mergedConfig.sections[0];
    // The assistant's param set is authoritative: 'serial' is updated, the
    // omitted 'baud' is removed, and the new 'extra' is appended.
    expect(merged.params.map((p) => p.key)).toEqual(['serial', 'extra']);
    expect(merged.params.find((p) => p.key === 'serial')?.value).toBe('new');
  });

  it('adds a section that does not exist in the base', () => {
    const base = config([section({ full_header: 'mcu' })]);
    const assistant = config([section({ full_header: 'heater_bed', section_type: 'heater_bed' })]);
    const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(changes).toEqual([{ id: 'printer.cfg:0:heater_bed', filename: 'printer.cfg', fullHeader: 'heater_bed', mode: 'add' }]);
    expect(mergedConfig.sections.map((s) => s.full_header)).toEqual(['mcu', 'heater_bed']);
  });

  it('preserves commented-out state of existing params', () => {
    const base = config([
      section({ full_header: 'mcu', params: [param('serial', 'old', { is_commented_out: true })] }),
    ]);
    const assistant = config([
      section({ full_header: 'mcu', params: [param('serial', 'new')] }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    expect(merged.params[0].is_commented_out).toBe(true);
    expect(merged.params[0].value).toBe('new');
  });

  it('removes params the assistant omitted', () => {
    const base = config([
      section({ full_header: 'mcu', params: [param('serial', 'a'), param('baud', 'b')] }),
    ]);
    const assistant = config([section({ full_header: 'mcu', params: [param('serial', 'a2')] })]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(mergedConfig.sections[0].params.map((p) => p.key)).toEqual(['serial']);
  });

  it('applies a deletion marker', () => {
    const base = config([
      section({ full_header: 'probe', section_type: 'probe' }),
      section({ full_header: 'mcu' }),
    ]);
    const assistant = config([
      section({
        section_type: 'delete_section',
        full_header: 'delete_section',
        params: [param('section', 'probe')],
      }),
    ]);
    const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(changes).toEqual([{ id: 'printer.cfg:0:delete_section', filename: 'printer.cfg', fullHeader: 'probe', mode: 'delete' }]);
    expect(mergedConfig.sections.map((s) => s.full_header)).toEqual(['mcu']);
  });

  it('records a deletion for a missing section as a no-op change', () => {
    const base = config([section({ full_header: 'mcu' })]);
    const assistant = config([
      section({ section_type: 'delete_section', full_header: 'delete_section', params: [param('section', 'ghost')] }),
    ]);
    const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(changes).toHaveLength(1);
    expect(changes[0].mode).toBe('delete');
    expect(mergedConfig.sections).toHaveLength(1);
  });

  it('respects selected change ids (only applies listed changes)', () => {
    const base = config([
      section({ full_header: 'mcu', params: [param('serial', 'old')] }),
    ]);
    const assistant = config([
      section({ full_header: 'mcu', params: [param('serial', 'new')] }),
      section({ full_header: 'heater_bed', section_type: 'heater_bed' }),
    ]);
    const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(
      base,
      assistant,
      ['printer.cfg:0:mcu'],
    );
    expect(changes).toHaveLength(2);
    expect(mergedConfig.sections.map((s) => s.full_header)).toEqual(['mcu']);
    expect(mergedConfig.sections[0].params.find((p) => p.key === 'serial')?.value).toBe('new');
  });

  it('collects includes from merged sections', () => {
    const base = config([section({ full_header: 'mcu' })]);
    const assistant = config([
      section({ section_type: 'include', section_name: 'macros.cfg', full_header: 'include macros.cfg' }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(mergedConfig.includes).toEqual(['macros.cfg']);
  });

  it('preserves deleted section header comments on the next section', () => {
    const base = config([
      section({ full_header: 'probe', section_type: 'probe', header_comments: ['# divider'] }),
      section({ full_header: 'mcu' }),
    ]);
    const assistant = config([
      section({ section_type: 'delete_section', full_header: 'delete_section', params: [param('section', 'probe')] }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    expect(mergedConfig.sections[0].full_header).toBe('mcu');
    expect(mergedConfig.sections[0].header_comments).toContain('# divider');
  });
});
