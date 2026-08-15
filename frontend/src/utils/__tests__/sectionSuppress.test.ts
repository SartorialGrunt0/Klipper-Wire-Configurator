import { describe, it, expect } from 'vitest';
import { toggleSectionSuppressed } from '../sectionSuppress';
import type { ConfigSection } from '../../types/config';

function makeSection(params: Array<{ key: string; commented?: boolean }>): ConfigSection {
  return {
    section_type: 'gcode_macro',
    section_name: 'X',
    full_header: 'gcode_macro X',
    line_number: 1,
    header_comments: [],
    params: params.map((p) => ({
      key: p.key,
      value: '',
      comment: '',
      is_commented_out: !!p.commented,
    })),
  };
}

describe('toggleSectionSuppressed', () => {
  it('comments all real params when suppressing', () => {
    const section = makeSection([{ key: 'gcode' }, { key: 'description' }]);
    const result = toggleSectionSuppressed(section, true);
    expect(result.is_commented_out).toBe(true);
    expect(result.params.every((p) => p.is_commented_out)).toBe(true);
  });

  it('captures prior per-param state so unsuppress restores individually-commented params', () => {
    // User individually commented `description` before suppressing the section.
    const section = makeSection([{ key: 'gcode' }, { key: 'description', commented: true }]);
    const suppressed = toggleSectionSuppressed(section, true);
    // While suppressed everything is commented.
    expect(suppressed.params.every((p) => p.is_commented_out)).toBe(true);

    const restored = toggleSectionSuppressed(suppressed, false);
    // The individually-commented param stays commented; the active one returns.
    expect(restored.params.find((p) => p.key === 'gcode')?.is_commented_out).toBe(false);
    expect(restored.params.find((p) => p.key === 'description')?.is_commented_out).toBe(true);
    expect(restored.is_commented_out).toBe(false);
  });

  it('enables everything when unsuppressing a section with no recorded prior state', () => {
    const section = makeSection([{ key: 'gcode', commented: true }, { key: 'description', commented: true }]);
    const result = toggleSectionSuppressed(section, false);
    expect(result.is_commented_out).toBe(false);
    expect(result.params.every((p) => !p.is_commented_out)).toBe(true);
  });

  it('leaves _comment_ pseudo-params untouched', () => {
    const section = makeSection([{ key: 'gcode' }]);
    section.params.push({ key: '_comment_', value: '# a note', comment: '', is_commented_out: false });
    const suppressed = toggleSectionSuppressed(section, true);
    const commentParam = suppressed.params.find((p) => p.key === '_comment_');
    expect(commentParam?.is_commented_out).toBe(false);
    expect(commentParam?.value).toBe('# a note');
  });

  it('keeps param values and keys intact across the toggle cycle', () => {
    const section = makeSection([{ key: 'gcode', commented: true }]);
    section.params[0].value = 'BED_MESH_CALIBRATE';
    const restored = toggleSectionSuppressed(toggleSectionSuppressed(section, true), false);
    expect(restored.params[0].key).toBe('gcode');
    expect(restored.params[0].value).toBe('BED_MESH_CALIBRATE');
  });

  it('does not carry the snapshot field into the restored section', () => {
    const section = makeSection([{ key: 'gcode' }]);
    const restored = toggleSectionSuppressed(toggleSectionSuppressed(section, true), false);
    expect((restored as unknown as Record<string, unknown>).suppressedParams).toBeUndefined();
  });
});
