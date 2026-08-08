import { describe, expect, it } from 'vitest';
import {
  applyBoardTypeMarkerToMcuSections,
  applyBoardTypeMarkerToSection,
  buildBoardTypeMarker,
  getBoardTypeMarker,
} from '@/utils/boardTypeMarker';
import type { ConfigSection } from '@/types/config';

describe('getBoardTypeMarker', () => {
  it('returns null without comments', () => {
    expect(getBoardTypeMarker(undefined)).toBeNull();
    expect(getBoardTypeMarker([])).toBeNull();
  });

  it('extracts the board type from a marker comment', () => {
    expect(getBoardTypeMarker(['# kwc: board_type=mainboard'])).toBe('mainboard');
    expect(getBoardTypeMarker(['# kwc: board_type=sbc'])).toBe('sbc');
    expect(getBoardTypeMarker(['# kwc: board_type=Toolhead'])).toBe('toolhead');
  });

  it('returns null when no marker comment exists', () => {
    expect(getBoardTypeMarker(['# just a comment', '[mcu]'])).toBeNull();
  });
});

describe('buildBoardTypeMarker', () => {
  it('builds a marker comment for the type', () => {
    expect(buildBoardTypeMarker('expander')).toBe('# kwc: board_type=expander');
  });
});

describe('applyBoardTypeMarkerToSection', () => {
  it('replaces an existing marker and keeps other comments', () => {
    const section = {
      header_comments: ['# first', '# kwc: board_type=sbc'],
    };
    const next = applyBoardTypeMarkerToSection(section, 'mainboard');
    expect(next.header_comments).toEqual(['# first', '# kwc: board_type=mainboard']);
  });

  it('appends a marker when none exists', () => {
    const section = { header_comments: ['# first'] };
    const next = applyBoardTypeMarkerToSection(section, 'toolhead');
    expect(next.header_comments).toEqual(['# first', '# kwc: board_type=toolhead']);
  });
});

describe('applyBoardTypeMarkerToMcuSections', () => {
  const mcu: ConfigSection = {
    section_type: 'mcu',
    section_name: '',
    full_header: 'mcu',
    line_number: 1,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
  };

  it('marks the matching unnamed mcu section', () => {
    const next = applyBoardTypeMarkerToMcuSections([mcu], 'mainboard');
    expect(next[0].header_comments).toContain('# kwc: board_type=mainboard');
  });

  it('marks the matching named mcu section', () => {
    const named = {
      ...mcu,
      section_name: 'EBBCan',
      full_header: 'mcu EBBCan',
    };
    const next = applyBoardTypeMarkerToMcuSections([named], 'toolhead', 'EBBCan');
    expect(next[0].header_comments).toContain('# kwc: board_type=toolhead');
  });

  it('leaves non-mcu sections untouched', () => {
    const extruder: ConfigSection = {
      ...mcu,
      section_type: 'extruder',
      full_header: 'extruder',
    };
    const next = applyBoardTypeMarkerToMcuSections([extruder], 'mainboard');
    expect(next[0].header_comments).toEqual([]);
  });

  it('leaves a named mcu untouched when the name does not match', () => {
    const named = {
      ...mcu,
      section_name: 'EBBCan',
      full_header: 'mcu EBBCan',
    };
    const next = applyBoardTypeMarkerToMcuSections([named], 'toolhead', 'OtherMCU');
    expect(next[0].header_comments).toEqual([]);
  });
});
