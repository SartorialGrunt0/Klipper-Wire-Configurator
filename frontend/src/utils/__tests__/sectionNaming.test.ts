import { describe, expect, it } from 'vitest';
import { buildUniqueSectionDraft } from '@/utils/sectionNaming';
import type { ConfigSection } from '@/types/config';

function section(overrides: Partial<ConfigSection>): ConfigSection {
  return {
    section_type: 'fan',
    section_name: '',
    full_header: 'fan',
    line_number: 1,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
    ...overrides,
  };
}

const NAMED_SCHEMA = { is_named: true, component_group: 'temperature' } as const;
const DRIVER_SCHEMA = { is_named: true, component_group: 'stepper_driver' } as const;
const UNNAMED_SCHEMA = { is_named: false, component_group: 'mcu' } as const;

describe('buildUniqueSectionDraft - unnamed sections', () => {
  it('returns the plain section type when free', () => {
    const draft = buildUniqueSectionDraft('mcu', 'MCU', UNNAMED_SCHEMA, []);
    expect(draft).toEqual({ sectionType: 'mcu', sectionName: '', fullHeader: 'mcu', label: 'MCU' });
  });

  it('increments when the header is taken', () => {
    const draft = buildUniqueSectionDraft('fan', 'Fan', UNNAMED_SCHEMA, [
      section({ section_type: 'fan', full_header: 'fan' }),
    ]);
    expect(draft.sectionName).toBe('fan_2');
    expect(draft.fullHeader).toBe('fan fan_2');
    expect(draft.label).toBe('Fan: fan_2');
  });

  it('skips past multiple taken headers', () => {
    const draft = buildUniqueSectionDraft('fan', 'Fan', UNNAMED_SCHEMA, [
      section({ section_type: 'fan', full_header: 'fan' }),
      section({ section_type: 'fan', full_header: 'fan fan_2' }),
      section({ section_type: 'fan', full_header: 'fan fan_3' }),
    ]);
    expect(draft.fullHeader).toBe('fan fan_4');
  });
});

describe('buildUniqueSectionDraft - named sections', () => {
  it('creates a default name for a free named section', () => {
    const draft = buildUniqueSectionDraft('temperature_sensor', 'Temp Sensor', NAMED_SCHEMA, []);
    expect(draft).toEqual({
      sectionType: 'temperature_sensor',
      sectionName: 'temperature_sensor_default',
      fullHeader: 'temperature_sensor temperature_sensor_default',
      label: 'Temp Sensor: temperature_sensor_default',
    });
  });

  it('increments the default name when taken', () => {
    const draft = buildUniqueSectionDraft('temperature_sensor', 'Temp Sensor', NAMED_SCHEMA, [
      section({
        section_type: 'temperature_sensor',
        section_name: 'temperature_sensor_default',
        full_header: 'temperature_sensor temperature_sensor_default',
      }),
    ]);
    expect(draft.sectionName).toBe('temperature_sensor_default_2');
  });
});

describe('buildUniqueSectionDraft - extruder indexing', () => {
  it('keeps extruder when free', () => {
    const draft = buildUniqueSectionDraft('extruder', 'Extruder', UNNAMED_SCHEMA, []);
    expect(draft.fullHeader).toBe('extruder');
  });

  it('chooses extruder1 when extruder is taken', () => {
    const draft = buildUniqueSectionDraft('extruder', 'Extruder', UNNAMED_SCHEMA, [
      section({ section_type: 'extruder', full_header: 'extruder' }),
    ]);
    expect(draft.fullHeader).toBe('extruder1');
  });

  it('honors an explicit extruder2 request when free', () => {
    const draft = buildUniqueSectionDraft('extruder2', 'Extruder 2', UNNAMED_SCHEMA, [
      section({ section_type: 'extruder', full_header: 'extruder' }),
    ]);
    expect(draft.fullHeader).toBe('extruder2');
  });

  it('finds the next free index when the requested one is taken', () => {
    const draft = buildUniqueSectionDraft('extruder2', 'Extruder 2', UNNAMED_SCHEMA, [
      section({ section_type: 'extruder', full_header: 'extruder' }),
      section({ section_type: 'extruder2', full_header: 'extruder2' }),
    ]);
    expect(draft.fullHeader).toBe('extruder1');
  });
});

describe('buildUniqueSectionDraft - stepper indexing', () => {
  it('keeps stepper_x when free', () => {
    const draft = buildUniqueSectionDraft('stepper_x', 'X', UNNAMED_SCHEMA, []);
    expect(draft.fullHeader).toBe('stepper_x');
  });

  it('adds a numeric suffix when stepper_x is taken', () => {
    const draft = buildUniqueSectionDraft('stepper_x', 'X', UNNAMED_SCHEMA, [
      section({ section_type: 'stepper_x', full_header: 'stepper_x' }),
    ]);
    expect(draft.fullHeader).toBe('stepper_x1');
  });
});

describe('buildUniqueSectionDraft - stepper drivers', () => {
  it('references an unused stepper axis for a tmc2209', () => {
    const draft = buildUniqueSectionDraft('tmc2209', 'TMC2209', DRIVER_SCHEMA, [
      section({ section_type: 'stepper_x', full_header: 'stepper_x' }),
      section({ section_type: 'stepper_y', full_header: 'stepper_y' }),
    ]);
    // stepper_x and stepper_y are both referenced; expect an available one.
    expect(draft.fullHeader).toBe('tmc2209 stepper_x');
    expect(draft.label).toBe('TMC2209: stepper_x');
  });

  it('falls back to a default name when all axes are used', () => {
    const driverRefs = ['stepper_x', 'stepper_y', 'stepper_z'].map((name) =>
      section({
        section_type: 'tmc2209',
        section_name: name,
        full_header: `tmc2209 ${name}`,
      }),
    );
    const draft = buildUniqueSectionDraft('tmc2209', 'TMC2209', DRIVER_SCHEMA, [
      section({ section_type: 'stepper_x', full_header: 'stepper_x' }),
      section({ section_type: 'stepper_y', full_header: 'stepper_y' }),
      section({ section_type: 'stepper_z', full_header: 'stepper_z' }),
      ...driverRefs,
    ]);
    expect(draft.fullHeader).toBe('tmc2209 tmc2209_default');
  });
});

describe('buildUniqueSectionDraft - driver types by name', () => {
  it('treats tmc5160 as a stepper driver even without schema group', () => {
    const draft = buildUniqueSectionDraft('tmc5160', 'TMC5160', undefined, [
      section({ section_type: 'stepper_x', full_header: 'stepper_x' }),
    ]);
    expect(draft.sectionName).toBe('stepper_x');
  });
});
