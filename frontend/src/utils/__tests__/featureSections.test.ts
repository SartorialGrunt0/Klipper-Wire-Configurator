import { describe, it, expect } from 'vitest';
import { hasFeatureSectionType } from '../featureSections';
import type { ConfigFile } from '../../types/config';

function makeFile(sectionTypes: string[]): ConfigFile {
  return {
    filename: 'printer.cfg',
    sections: sectionTypes.map((section_type) => ({
      section_type,
      section_name: '',
      full_header: `[${section_type}]`,
      params: [],
      line_number: 1,
      header_comments: [],
    })),
    includes: [],
    header_comments: [],
  };
}

describe('hasFeatureSectionType', () => {
  it('returns true when any file already has the section type', () => {
    const files = { 'printer.cfg': makeFile(['bed_mesh', 'input_shaper']) };
    expect(hasFeatureSectionType(files, 'bed_mesh')).toBe(true);
  });

  it('returns false when no file has the section type', () => {
    const files = { 'printer.cfg': makeFile(['bed_mesh']) };
    expect(hasFeatureSectionType(files, 'z_tilt')).toBe(false);
  });

  it('searches across all files', () => {
    const files = {
      'printer.cfg': makeFile(['bed_mesh']),
      'features.cfg': makeFile(['input_shaper']),
    };
    expect(hasFeatureSectionType(files, 'input_shaper')).toBe(true);
  });

  it('never blocks gcode_macro (repeatable section)', () => {
    const files = { 'printer.cfg': makeFile(['gcode_macro']) };
    expect(hasFeatureSectionType(files, 'gcode_macro')).toBe(false);
  });

  it('returns false for empty files', () => {
    expect(hasFeatureSectionType({}, 'bed_mesh')).toBe(false);
  });
});
