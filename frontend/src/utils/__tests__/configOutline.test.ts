import { describe, it, expect } from 'vitest';
import { scanSections } from '../configOutline';

describe('scanSections', () => {
  it('collects sections with their line numbers and params', () => {
    const text = ['[stepper_x]', 'microsteps: 16', 'rotation_distance: 40', '', '[extruder]', 'nozzle_diameter: 0.4'].join('\n');
    const sections = scanSections(text);
    expect(sections.map((s) => [s.title, s.line])).toEqual([
      ['stepper_x', 1],
      ['extruder', 5],
    ]);
    expect(sections[0].params).toEqual([
      { key: 'microsteps', line: 2 },
      { key: 'rotation_distance', line: 3 },
    ]);
    expect(sections[1].params).toEqual([{ key: 'nozzle_diameter', line: 6 }]);
  });

  it('keeps the full header text as the title (named sections)', () => {
    expect(scanSections('[gcode_macro CLEAN_NOZZLE]')[0].title).toBe('gcode_macro CLEAN_NOZZLE');
  });

  it('accepts indented headers', () => {
    expect(scanSections('  [probe]')[0].line).toBe(1);
  });

  it('marks commented sections and skips their params', () => {
    const sections = scanSections('#[probe]\nz_offset: 2.0');
    expect(sections[0].isCommented).toBe(true);
    expect(sections[0].params).toEqual([]);
  });

  it('ignores commented-out params inside a live section', () => {
    const sections = scanSections('[probe]\n#z_offset: 2.0\nz_offset: 1.0');
    expect(sections[0].params).toEqual([{ key: 'z_offset', line: 3 }]);
  });

  it('ends the current section at an include line', () => {
    const sections = scanSections('[a]\nx: 1\n[include other.cfg]\ny: 2\n[b]\nz: 3');
    expect(sections.map((s) => s.title)).toEqual(['a', 'b']);
    expect(sections[0].params).toEqual([{ key: 'x', line: 2 }]);
  });

  it('does not treat a commented include as a section terminator', () => {
    const sections = scanSections('[a]\nx: 1\n#[include other.cfg]\ny: 2');
    expect(sections.map((s) => s.title)).toEqual(['a']);
    expect(sections[0].params).toEqual([
      { key: 'x', line: 2 },
      { key: 'y', line: 4 },
    ]);
  });

  it('does not create a node for a commented include', () => {
    expect(scanSections('#[include other.cfg]')).toEqual([]);
  });

  it('ignores bare comment lines', () => {
    const sections = scanSections('[a]\n# a note\nx: 1');
    expect(sections[0].params).toEqual([{ key: 'x', line: 3 }]);
  });

  it('ignores params that appear before any section', () => {
    expect(scanSections('orphan: 1\n[a]')).toHaveLength(1);
    expect(scanSections('orphan: 1\n[a]')[0].params).toEqual([]);
  });

  it('accepts = as a separator', () => {
    expect(scanSections('[a]\nx = 1')[0].params).toEqual([{ key: 'x', line: 2 }]);
  });

  it('gives duplicate headers distinct ids', () => {
    const sections = scanSections('[a]\n[b]\n[a]');
    expect(sections.map((s) => s.id)).toEqual(['1:a', '2:b', '3:a']);
  });

  it('returns nothing for empty text', () => {
    expect(scanSections('')).toEqual([]);
  });
});
