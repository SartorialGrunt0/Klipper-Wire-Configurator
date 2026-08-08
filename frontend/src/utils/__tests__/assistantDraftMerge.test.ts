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

describe('mergeAssistantSectionsIntoConfig — duplicate keys', () => {
  it('verbatim re-emit of a duplicate-key section is a no-op (mcu serial lines)', () => {
    const base = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', '/dev/ttyAMA0', { is_commented_out: true, comment: ' # f446' }),
          param('serial', '/dev/ttyS0', { is_commented_out: true, comment: ' # alternate' }),
          param('serial', '/dev/serial/by-id/usb-1a86-usb', { is_commented_out: false }),
        ],
      }),
    ]);
    const assistant = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', '/dev/ttyAMA0', { is_commented_out: true, comment: ' # f446' }),
          param('serial', '/dev/ttyS0', { is_commented_out: true, comment: ' # alternate' }),
          param('serial', '/dev/serial/by-id/usb-1a86-usb', { is_commented_out: false }),
        ],
      }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    // Each line keeps its OWN value — no conflation onto the last one.
    expect(merged.params.map((p) => p.value)).toEqual([
      '/dev/ttyAMA0',
      '/dev/ttyS0',
      '/dev/serial/by-id/usb-1a86-usb',
    ]);
    expect(merged.params.map((p) => p.is_commented_out)).toEqual([true, true, false]);
  });

  it('assistant params in a different order still pair with their own existing lines', () => {
    // Two same-key lines with DISTINCT states: the state disambiguates the
    // pairing no matter what order the AI emits them in. The old code
    // conflated both onto the last same-key param ('A' active) -> ['A','A'].
    const base = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', 'A', { is_commented_out: false }),
          param('serial', 'B', { is_commented_out: true }),
        ],
      }),
    ]);
    const assistant = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', 'B', { is_commented_out: true }),
          param('serial', 'A', { is_commented_out: false }),
        ],
      }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    expect(merged.params.map((p) => p.value)).toEqual(['A', 'B']);
    expect(merged.params.map((p) => p.is_commented_out)).toEqual([false, true]);
  });

  it('same-state duplicate lines emitted in a different order pair greedily but never conflate', () => {
    // Existing: active A, #B, #C. Assistant emits the same lines reversed
    // (#C, #B, active A). The greedy per-state matcher pairs #C with B's
    // slot and #B with C's slot, so the values land as A, C, B — the whole
    // multiset and every commented-state are preserved (no conflation onto
    // the last same-key param, which is what the old code did).
    const base = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', 'A', { is_commented_out: false }),
          param('serial', 'B', { is_commented_out: true }),
          param('serial', 'C', { is_commented_out: true }),
        ],
      }),
    ]);
    const assistant = config([
      section({
        full_header: 'mcu',
        params: [
          param('serial', 'C', { is_commented_out: true }),
          param('serial', 'B', { is_commented_out: true }),
          param('serial', 'A', { is_commented_out: false }),
        ],
      }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    expect(merged.params.map((p) => p.value)).toEqual(['A', 'C', 'B']);
    expect(merged.params.map((p) => p.is_commented_out)).toEqual([false, true, true]);
  });

  it('a changed active value updates only the active line, leaving comments alone', () => {
    const base = config([
      section({
        full_header: 'printer',
        section_type: 'printer',
        params: [
          param('max_accel', '4800', { is_commented_out: true }),
          param('max_accel', '15500', { is_commented_out: false }),
        ],
      }),
    ]);
    const assistant = config([
      section({
        full_header: 'printer',
        section_type: 'printer',
        params: [
          param('max_accel', '4800', { is_commented_out: true }),
          param('max_accel', '20000', { is_commented_out: false }),
        ],
      }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    expect(merged.params.map((p) => p.value)).toEqual(['4800', '20000']);
    expect(merged.params[0].is_commented_out).toBe(true);
    expect(merged.params[1].is_commented_out).toBe(false);
  });

  it('commented AI param falling back to an active existing param preserves existing comment state but takes the matched value', () => {
    const base = config([
      section({
        full_header: 'stepper_x',
        section_type: 'stepper_x',
        params: [
          param('endstop_pin', '^PC2', { is_commented_out: false }),
        ],
      }),
    ]);
    const assistant = config([
      section({
        full_header: 'stepper_x',
        section_type: 'stepper_x',
        params: [
          param('endstop_pin', '^PC1', { is_commented_out: true }),
        ],
      }),
    ]);
    const { mergedConfig } = mergeAssistantSectionsIntoConfig(base, assistant);
    const merged = mergedConfig.sections[0];
    // Existing active state is preserved (no force-comment), but the
    // value comes from the specific matched AI param.
    expect(merged.params[0].is_commented_out).toBe(false);
    expect(merged.params[0].value).toBe('^PC1');
  });
});
