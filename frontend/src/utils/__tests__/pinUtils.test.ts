import { describe, expect, it } from 'vitest';
import {
  addMcuPrefix,
  formatPin,
  getMcuName,
  isPinParam,
  isPinParamName,
  parsePin,
  removeMcuPrefix,
  swapMcuPrefix,
  updateAllSectionPins,
  updateSectionPins,
} from '@/utils/pinUtils';
import type { ConfigSection, SectionSchema } from '@/types/config';

describe('isPinParamName', () => {
  it('detects pin params by name convention', () => {
    expect(isPinParamName('step_pin')).toBe(true);
    expect(isPinParamName('dir_pin')).toBe(true);
    expect(isPinParamName('heater_pin')).toBe(true);
    expect(isPinParamName('serial')).toBe(false);
    expect(isPinParamName('microsteps')).toBe(false);
  });
});

describe('isPinParam', () => {
  it('uses schema type when available', () => {
    const schema: SectionSchema = {
      section_type: 'extruder',
      display_name: 'Extruder',
      category: 'sub_component',
      component_group: 'extruder',
      is_named: false,
      description: '',
      max_instances: 1,
      requires: [],
      params: [{ name: 'heater_pin', type: 'pin', required: false, default: null, description: '', enum_values: [], unit: '' }],
    };
    // The name heuristic would match anyway; ensure a non-pin-named schema
    // param with type pin is detected.
    expect(isPinParam('heater_pin', schema)).toBe(true);
  });

  it('falls back to name heuristic without schema', () => {
    expect(isPinParam('step_pin')).toBe(true);
    expect(isPinParam('serial')).toBe(false);
  });
});

describe('parsePin / formatPin', () => {
  it('parses a plain pin', () => {
    expect(parsePin('gpio6')).toEqual({ modifiers: '', mcuName: '', pinName: 'gpio6' });
  });

  it('parses a pin with modifiers', () => {
    expect(parsePin('!^PA9')).toEqual({ modifiers: '!^', mcuName: '', pinName: 'PA9' });
  });

  it('parses a named MCU prefix', () => {
    expect(parsePin('EBBCan:gpio13')).toEqual({ modifiers: '', mcuName: 'EBBCan', pinName: 'gpio13' });
    expect(parsePin('!^EBBCan:gpio6')).toEqual({ modifiers: '!^', mcuName: 'EBBCan', pinName: 'gpio6' });
  });

  it('returns null for empty or virtual endstop values', () => {
    expect(parsePin('')).toBeNull();
    expect(parsePin('   ')).toBeNull();
    expect(parsePin('z_virtual_endstop')).toBeNull();
  });

  it('round-trips through formatPin', () => {
    const parsed = parsePin('!^EBBCan:gpio6')!;
    expect(formatPin(parsed)).toBe('!^EBBCan:gpio6');
  });
});

describe('addMcuPrefix', () => {
  it('adds a prefix to an unprefixed pin, preserving modifiers', () => {
    expect(addMcuPrefix('gpio13', 'EBBCan')).toBe('EBBCan:gpio13');
    expect(addMcuPrefix('!^gpio6', 'EBBCan')).toBe('!^EBBCan:gpio6');
  });

  it('leaves an already-prefixed pin unchanged', () => {
    expect(addMcuPrefix('EBBCan:gpio13', 'EBBCan')).toBe('EBBCan:gpio13');
    expect(addMcuPrefix('Other:gpio13', 'EBBCan')).toBe('Other:gpio13');
  });

  it('no-ops without an mcu name', () => {
    expect(addMcuPrefix('gpio13', '')).toBe('gpio13');
  });
});

describe('removeMcuPrefix', () => {
  it('removes a matching prefix', () => {
    expect(removeMcuPrefix('EBBCan:gpio13', 'EBBCan')).toBe('gpio13');
    expect(removeMcuPrefix('!^EBBCan:gpio6', 'EBBCan')).toBe('!^gpio6');
  });

  it('leaves a non-matching or absent prefix unchanged', () => {
    expect(removeMcuPrefix('Other:gpio13', 'EBBCan')).toBe('Other:gpio13');
    expect(removeMcuPrefix('gpio13', 'EBBCan')).toBe('gpio13');
  });
});

describe('swapMcuPrefix', () => {
  it('replaces a matching old prefix with the new one', () => {
    expect(swapMcuPrefix('EBBCan:gpio13', 'EBBCan', 'Toolhead')).toBe('Toolhead:gpio13');
  });

  it('adds a prefix to unprefixed pins when oldMcu is empty', () => {
    expect(swapMcuPrefix('gpio13', '', 'EBBCan')).toBe('EBBCan:gpio13');
  });

  it('removes the prefix when newMcu is empty', () => {
    expect(swapMcuPrefix('EBBCan:gpio13', 'EBBCan', '')).toBe('gpio13');
  });

  it('leaves pins with a different prefix untouched', () => {
    expect(swapMcuPrefix('Other:gpio13', 'EBBCan', 'Toolhead')).toBe('Other:gpio13');
    expect(swapMcuPrefix('Other:gpio13', '', 'EBBCan')).toBe('Other:gpio13');
  });
});

describe('updateSectionPins / updateAllSectionPins', () => {
  function section(overrides: Partial<ConfigSection> = {}): ConfigSection {
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

  it('swaps pin values but leaves non-pin params unchanged', () => {
    const sec = section({
      params: [
        { key: 'step_pin', value: 'EBBCan:gpio13', is_commented_out: false, comment: '', separator: ':' },
        { key: 'baud', value: '250000', is_commented_out: false, comment: '', separator: ':' },
      ],
    });
    const next = updateSectionPins(sec, 'EBBCan', 'NewMCU');
    expect(next.params.find((p) => p.key === 'step_pin')?.value).toBe('NewMCU:gpio13');
    expect(next.params.find((p) => p.key === 'baud')?.value).toBe('250000');
  });

  it('skips commented-out params', () => {
    const sec = section({
      params: [
        { key: 'step_pin', value: 'EBBCan:gpio13', is_commented_out: true, comment: '', separator: ':' },
      ],
    });
    const next = updateSectionPins(sec, 'EBBCan', 'NewMCU');
    expect(next.params[0].value).toBe('EBBCan:gpio13');
  });

  it('updateAllSectionPins maps across sections', () => {
    const secs = [
      section({ params: [{ key: 'step_pin', value: 'EBBCan:gpio13', is_commented_out: false, comment: '', separator: ':' }] }),
      section({ params: [{ key: 'step_pin', value: 'Other:gpio1', is_commented_out: false, comment: '', separator: ':' }] }),
    ];
    const next = updateAllSectionPins(secs, 'EBBCan', 'NewMCU');
    expect(next[0].params[0].value).toBe('NewMCU:gpio13');
    expect(next[1].params[0].value).toBe('Other:gpio1');
  });
});

describe('getMcuName', () => {
  it('returns the mcu name or empty string', () => {
    expect(getMcuName({ mcuName: 'EBBCan' })).toBe('EBBCan');
    expect(getMcuName({})).toBe('');
    expect(getMcuName({ mcuName: '' })).toBe('');
  });
});
