import { describe, expect, it } from 'vitest';
import { resolveSection } from '@/utils/sectionResolver';
import type { ConfigFile } from '@/types/config';

function makeFile(filename: string, sections: Array<{ header: string; line: number }>): ConfigFile {
  return {
    filename,
    sections: sections.map((s) => ({
      section_type: s.header.split(' ')[0],
      section_name: s.header.split(' ').slice(1).join(' '),
      full_header: s.header,
      line_number: s.line,
      params: [],
      header_comments: [],
      trailing_comments: [],
      is_commented_out: false,
    })),
    includes: [],
    header_comments: [],
    raw_text: '',
  };
}

const configFiles: Record<string, ConfigFile> = {
  'printer.cfg': makeFile('printer.cfg', [
    { header: 'idle_timeout', line: 10 },
    { header: 'gcode_macro LEVEL_BED', line: 20 },
  ]),
  'macros.cfg': makeFile('macros.cfg', [
    { header: 'idle_timeout', line: 5 },
    { header: 'gcode_macro LEVEL_BED', line: 15 },
  ]),
};

describe('resolveSection', () => {
  it('returns null when no header is given', () => {
    expect(resolveSection(configFiles, null)).toBeNull();
  });

  it('resolves by header when no file is known (legacy behavior)', () => {
    const result = resolveSection(configFiles, 'gcode_macro LEVEL_BED');
    expect(result?.filename).toBe('printer.cfg');
    expect(result?.section.line_number).toBe(20);
  });

  it('prefers the carried config file over first-match across files', () => {
    const result = resolveSection(configFiles, 'idle_timeout', 'macros.cfg');
    expect(result?.filename).toBe('macros.cfg');
    expect(result?.section.line_number).toBe(5);
  });

  it('respects the carried line number within the carried file', () => {
    const result = resolveSection(configFiles, 'gcode_macro LEVEL_BED', 'macros.cfg', 15);
    expect(result?.filename).toBe('macros.cfg');
    expect(result?.section.line_number).toBe(15);
  });

  it('falls back to header-only search when carried line is missing', () => {
    const result = resolveSection(configFiles, 'idle_timeout', 'macros.cfg', undefined);
    expect(result?.section.line_number).toBe(5);
  });

  it('returns null when carried file does not exist', () => {
    expect(resolveSection(configFiles, 'idle_timeout', 'nope.cfg')).toBeNull();
  });

  it('matches by header + line across files when file unknown', () => {
    const result = resolveSection(configFiles, 'gcode_macro LEVEL_BED', undefined, 15);
    expect(result?.filename).toBe('macros.cfg');
  });
});
