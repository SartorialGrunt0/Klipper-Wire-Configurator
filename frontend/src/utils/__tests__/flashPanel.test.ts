import { describe, expect, it } from 'vitest';
import {
  CAN_UUID_PATTERN,
  USB_ID_PATTERN,
  buildAssignments,
  buildPanelAssignments,
  fieldRecord,
  flashMethodRecord,
  formatBytes,
  inferFlashMethodForDevice,
  mergeDeviceCandidates,
  normalizeProfileAssignments,
  resolveFlashDevice,
  resolveFlashMethod,
  resolveMethodDefaultDevice,
} from '@/utils/flashPanel';
import type {
  NativeFlashDeviceCandidate,
  NativeFlashField,
  NativeFlashMethodCandidate,
  NativeFlashProfileAssignment,
  NativeFlashState,
} from '@/services/api';

function makeField(overrides: Partial<NativeFlashField>): NativeFlashField {
  return {
    id: 'FIELD',
    kind: 'bool',
    symbol: 'FIELD',
    prompt: 'Field',
    value: 'n',
    help: '',
    menu_path: ['Menu'],
    assignable: [],
    ...overrides,
  };
}

function makeMethod(value: string, overrides: Partial<NativeFlashMethodCandidate> = {}): NativeFlashMethodCandidate {
  return {
    value,
    label: value,
    description: '',
    supported: true,
    reason: null,
    device_required: true,
    device_placeholder: '',
    default_device: '',
    help: '',
    ...overrides,
  };
}

function makeDevice(value: string, overrides: Partial<NativeFlashDeviceCandidate> = {}): NativeFlashDeviceCandidate {
  return { value, label: value, ...overrides };
}

function makeState(overrides: Partial<NativeFlashState> = {}): NativeFlashState {
  return {
    target: 'klipper',
    display_name: 'Klipper',
    available: true,
    error: null,
    checkout_path: '/home/pi/klipper',
    config_path: '/home/pi/klipper/.config',
    out_path: '/home/pi/klipper/out',
    config_exists: true,
    fields: [],
    artifacts: [],
    primary_artifact: null,
    flash_supported: true,
    flash_reason: null,
    flash_device_required: false,
    flash_device_placeholder: '',
    default_flash_device: '',
    flash_device_candidates: [],
    flash_method_candidates: [],
    default_flash_method: 'make_flash',
    flash_help: '',
    ...overrides,
  };
}

function makePanel(overrides: { flashMethod?: string; flashDevice?: string; flashState?: NativeFlashState | null }) {
  return {
    flashMethod: overrides.flashMethod ?? '',
    flashDevice: overrides.flashDevice ?? '',
    flashState: overrides.flashState ?? null,
  };
}

describe('inferFlashMethodForDevice', () => {
  const state = makeState({
    flash_method_candidates: [
      makeMethod('make_flash', { default_device: 'first' }),
      makeMethod('dfu_util'),
      makeMethod('flashtool'),
    ],
  });

  it('maps a CAN UUID to flashtool', () => {
    expect(inferFlashMethodForDevice('aabbccddeeff', state)).toBe('flashtool');
    expect(inferFlashMethodForDevice('can0:aabbccddeeff', state)).toBe('flashtool');
  });

  it('maps a /dev/ path to flashtool, falling back to make_flash', () => {
    expect(inferFlashMethodForDevice('/dev/serial/by-id/usb-katapult', state)).toBe('flashtool');
    const noFlashtool = makeState({
      flash_method_candidates: [makeMethod('make_flash'), makeMethod('dfu_util')],
    });
    expect(inferFlashMethodForDevice('/dev/ttyACM0', noFlashtool)).toBe('make_flash');
  });

  it('maps the RP2040 "first" shortcut to make_flash', () => {
    expect(inferFlashMethodForDevice('first', state)).toBe('make_flash');
  });

  it('maps a USB VID:PID to dfu_util, falling back to make_flash', () => {
    expect(inferFlashMethodForDevice('0483:df11', state)).toBe('dfu_util');
    const noDfu = makeState({ flash_method_candidates: [makeMethod('make_flash'), makeMethod('flashtool')] });
    expect(inferFlashMethodForDevice('0483:df11', noDfu)).toBe('make_flash');
  });

  it('respects a candidate-preferred method over format heuristics', () => {
    const withPreferred = makeState({
      flash_method_candidates: [makeMethod('make_flash'), makeMethod('dfu_util')],
      flash_device_candidates: [
        makeDevice('0483:df11', { preferred_flash_method: 'make_flash' }),
      ],
    });
    expect(inferFlashMethodForDevice('0483:df11', withPreferred)).toBe('make_flash');
  });

  it('returns empty for empty input or missing state', () => {
    expect(inferFlashMethodForDevice('', state)).toBe('');
    expect(inferFlashMethodForDevice('/dev/ttyACM0', null)).toBe('');
  });
});

describe('buildAssignments', () => {
  it('emits y/n for bool fields', () => {
    const fields = {
      B: makeField({ id: 'B', symbol: 'CONFIG_B', value: 'y' }),
      C: makeField({ id: 'C', symbol: 'CONFIG_C', value: 'n' }),
    };
    expect(buildAssignments({ B: 'y', C: 'n' }, fields)).toEqual([
      { symbol: 'CONFIG_B', value: 'y' },
      { symbol: 'CONFIG_C', value: 'n' },
    ]);
  });

  it('converts a choice selection into {symbol: y} and skips empty selection', () => {
    const fields = {
      CH: makeField({ id: 'CH', kind: 'choice', symbol: null, value: 'OPT_A' }),
    };
    expect(buildAssignments({ CH: 'OPT_A' }, fields)).toEqual([{ symbol: 'OPT_A', value: 'y' }]);
    expect(buildAssignments({ CH: '' }, fields)).toEqual([]);
  });

  it('skips unknown field ids', () => {
    expect(buildAssignments({ NOPE: 'y' }, {})).toEqual([]);
  });
});

describe('normalizeProfileAssignments', () => {
  it('trims symbols and drops empty ones', () => {
    const assignments: NativeFlashProfileAssignment[] = [
      { symbol: '  MACH_AVR  ', value: 'y' },
      { symbol: '   ', value: 'y' },
      { symbol: '', value: 'y' },
    ];
    expect(normalizeProfileAssignments(assignments)).toEqual([{ symbol: 'MACH_AVR', value: 'y' }]);
  });
});

describe('buildPanelAssignments', () => {
  it('merges sticky assignments with field values, field values win on conflict', () => {
    const sticky: NativeFlashProfileAssignment[] = [
      { symbol: 'MACH_AVR', value: 'y' },
      { symbol: 'ONLY_STICKY', value: 'x' },
    ];
    const fields = {
      F1: makeField({ id: 'F1', symbol: 'MACH_AVR', value: 'n' }),
      F2: makeField({ id: 'F2', symbol: 'FIELD_TWO', value: 'y' }),
    };
    expect(buildPanelAssignments({ F1: 'n', F2: 'y' }, fields, sticky)).toEqual([
      { symbol: 'MACH_AVR', value: 'n' },
      { symbol: 'ONLY_STICKY', value: 'x' },
      { symbol: 'FIELD_TWO', value: 'y' },
    ]);
  });
});

describe('flashMethodRecord / resolveMethodDefaultDevice', () => {
  const state = makeState({
    default_flash_method: 'flashtool',
    default_flash_device: 'aabbccddeeff',
    flash_method_candidates: [
      makeMethod('flashtool', { default_device: 'can0:aabbccddeeff' }),
      makeMethod('make_flash', { default_device: 'first' }),
    ],
  });

  it('finds a method candidate by value', () => {
    expect(flashMethodRecord(state, 'flashtool')?.label).toBe('flashtool');
    expect(flashMethodRecord(state, 'nope')).toBeNull();
  });

  it('prefers the method default device, then the state default', () => {
    expect(resolveMethodDefaultDevice(state, 'flashtool')).toBe('can0:aabbccddeeff');
    expect(resolveMethodDefaultDevice(state, 'make_flash')).toBe('first');
    expect(resolveMethodDefaultDevice(makeState({ default_flash_device: '0483:df11' }), 'missing')).toBe('0483:df11');
  });
});

describe('resolveFlashMethod', () => {
  const prev = makePanel({ flashMethod: 'dfu_util', flashState: makeState({ default_flash_method: 'make_flash' }) });
  const next = makeState({ default_flash_method: 'flashtool' });

  it('keeps a user-chosen method across previews', () => {
    expect(resolveFlashMethod(prev, next, false)).toBe('dfu_util');
  });

  it('follows the new default when the previous was the old default', () => {
    const atDefault = makePanel({ flashMethod: 'make_flash', flashState: makeState({ default_flash_method: 'make_flash' }) });
    expect(resolveFlashMethod(atDefault, next, false)).toBe('flashtool');
  });

  it('resetToDefault keeps a user override but follows the default otherwise', () => {
    expect(resolveFlashMethod(prev, next, true)).toBe('dfu_util');
    const atDefault = makePanel({ flashMethod: 'make_flash', flashState: makeState({ default_flash_method: 'make_flash' }) });
    expect(resolveFlashMethod(atDefault, next, true)).toBe('flashtool');
  });
});

describe('resolveFlashDevice', () => {
  const prev = makePanel({
    flashMethod: 'dfu_util',
    flashDevice: '0483:3748', // a user-typed device that is NOT the method default
    flashState: makeState({ default_flash_method: 'dfu_util', flash_method_candidates: [makeMethod('dfu_util', { default_device: '0483:df11' })] }),
  });
  const next = makeState({
    default_flash_method: 'flashtool',
    flash_method_candidates: [
      makeMethod('flashtool', { default_device: 'can0:aabbccddeeff' }),
      makeMethod('dfu_util', { default_device: '0483:df11' }),
    ],
  });

  it('keeps a user-typed device that differs from the old default', () => {
    expect(resolveFlashDevice(prev, next, 'flashtool', false)).toBe('0483:3748');
  });

  it('swaps to the new method default when the device was the old default', () => {
    const atDefault = makePanel({
      flashMethod: 'dfu_util',
      flashDevice: '0483:df11',
      flashState: makeState({ default_flash_method: 'dfu_util', flash_method_candidates: [makeMethod('dfu_util', { default_device: '0483:df11' })] }),
    });
    expect(resolveFlashDevice(atDefault, next, 'flashtool', false)).toBe('can0:aabbccddeeff');
  });
});

describe('mergeDeviceCandidates', () => {
  it('dedupes by value with static candidates first', () => {
    const staticCandidates = [makeDevice('first'), makeDevice('/dev/ttyACM0')];
    const scannedCandidates = [makeDevice('/dev/ttyACM0'), makeDevice('aabbccddeeff')];
    expect(mergeDeviceCandidates(staticCandidates, scannedCandidates).map((c) => c.value)).toEqual([
      'first',
      '/dev/ttyACM0',
      'aabbccddeeff',
    ]);
  });
});

describe('fieldRecord', () => {
  it('keys fields by id with cloned entries', () => {
    const fields = [makeField({ id: 'A' }), makeField({ id: 'B' })];
    const record = fieldRecord(fields);
    expect(Object.keys(record)).toEqual(['A', 'B']);
    record.A.value = 'mutated';
    expect(fields[0].value).toBe('n');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
  });
});

describe('pattern constants', () => {
  it('USB_ID_PATTERN matches 4:4 hex ids', () => {
    expect(USB_ID_PATTERN.test('0483:df11')).toBe(true);
    expect(USB_ID_PATTERN.test('04831:df11')).toBe(false);
  });

  it('CAN_UUID_PATTERN matches bare or interface-prefixed 12-hex uuids', () => {
    expect(CAN_UUID_PATTERN.test('aabbccddeeff')).toBe(true);
    expect(CAN_UUID_PATTERN.test('can0:aabbccddeeff')).toBe(true);
    expect(CAN_UUID_PATTERN.test('aabbccddee')).toBe(false);
  });
});
