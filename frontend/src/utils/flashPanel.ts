/**
 * Pure flash-panel logic extracted from FirmwareDialog.tsx.
 *
 * All functions here are side-effect free and unit-testable without React.
 * Keep this module free of component/UI dependencies — it only reads the
 * NativeFlash* API types and returns plain data.
 */
import type {
  NativeFlashDeviceCandidate,
  NativeFlashField,
  NativeFlashMethodCandidate,
  NativeFlashProfileAssignment,
  NativeFlashState,
} from '../services/api';

export const USB_ID_PATTERN = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/;
export const CAN_UUID_PATTERN = /^(?:[A-Za-z0-9_-]+:)?[0-9a-fA-F]{12}$/;

/** The subset of FlashPanelState these resolution helpers depend on. */
export interface FlashPanelStateLike {
  flashMethod: string;
  flashDevice: string;
  flashState: NativeFlashState | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFlashTargetKey(value: unknown): value is 'klipper' | 'katapult' {
  return value === 'klipper' || value === 'katapult';
}

export function normalizeProfileAssignments(assignments: NativeFlashProfileAssignment[]): NativeFlashProfileAssignment[] {
  const normalized: NativeFlashProfileAssignment[] = [];
  for (const assignment of assignments) {
    const symbol = assignment.symbol.trim();
    if (!symbol) {
      continue;
    }
    normalized.push({
      symbol,
      value: assignment.value,
    });
  }
  return normalized;
}

export function buildPanelAssignments(
  assignmentValues: Record<string, string>,
  knownFields: Record<string, NativeFlashField>,
  stickyAssignments: NativeFlashProfileAssignment[],
): Array<{ symbol: string; value: string }> {
  const merged = new Map<string, string>();
  for (const assignment of normalizeProfileAssignments(stickyAssignments)) {
    merged.set(assignment.symbol, assignment.value);
  }
  for (const assignment of buildAssignments(assignmentValues, knownFields)) {
    merged.set(assignment.symbol, assignment.value);
  }
  return Array.from(merged.entries()).map(([symbol, value]) => ({ symbol, value }));
}

export function flashMethodRecord(
  state: NativeFlashState | null,
  methodValue: string,
): NativeFlashMethodCandidate | null {
  if (!state || !methodValue) {
    return null;
  }
  return state.flash_method_candidates.find((candidate) => candidate.value === methodValue) || null;
}

export function resolveMethodDefaultDevice(state: NativeFlashState | null, methodValue: string): string {
  return flashMethodRecord(state, methodValue)?.default_device || state?.default_flash_device || '';
}

export function inferFlashMethodForDevice(value: string, state: NativeFlashState | null): string {
  const trimmedValue = value.trim();
  if (!state || !trimmedValue) {
    return '';
  }

  const exactCandidate = state.flash_device_candidates.find((candidate) => candidate.value === trimmedValue);
  if (exactCandidate?.preferred_flash_method && flashMethodRecord(state, exactCandidate.preferred_flash_method)) {
    return exactCandidate.preferred_flash_method;
  }

  const supportedMethods = new Set(state.flash_method_candidates.map((candidate) => candidate.value));
  if (CAN_UUID_PATTERN.test(trimmedValue) && supportedMethods.has('flashtool')) {
    return 'flashtool';
  }
  if (trimmedValue.startsWith('/dev/')) {
    if (supportedMethods.has('flashtool')) {
      return 'flashtool';
    }
    if (supportedMethods.has('make_flash')) {
      return 'make_flash';
    }
  }
  if (trimmedValue === 'first' && supportedMethods.has('make_flash')) {
    return 'make_flash';
  }
  if (USB_ID_PATTERN.test(trimmedValue)) {
    if (supportedMethods.has('dfu_util')) {
      return 'dfu_util';
    }
    if (supportedMethods.has('make_flash')) {
      return 'make_flash';
    }
  }
  return '';
}

export function resolveFlashMethod(previous: FlashPanelStateLike, nextState: NativeFlashState, resetToDefault: boolean): string {
  const currentDefault = previous.flashState?.default_flash_method || '';
  const nextDefault = nextState.default_flash_method || '';
  if (resetToDefault) {
    if (previous.flashMethod && previous.flashMethod !== currentDefault) {
      return previous.flashMethod;
    }
    return nextDefault;
  }
  if (!previous.flashMethod || previous.flashMethod === currentDefault) {
    return nextDefault;
  }
  return previous.flashMethod;
}

export function cloneField(field: NativeFlashField): NativeFlashField {
  return {
    ...field,
    menu_path: [...field.menu_path],
    assignable: [...field.assignable],
    options: field.options?.map((option) => ({ ...option })),
  };
}

export function cloneFields(fields: NativeFlashField[]): NativeFlashField[] {
  return fields.map(cloneField);
}

export function fieldRecord(fields: NativeFlashField[]): Record<string, NativeFlashField> {
  const result: Record<string, NativeFlashField> = {};
  for (const field of fields) {
    result[field.id] = cloneField(field);
  }
  return result;
}

export function fieldAssignments(fields: NativeFlashField[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    result[field.id] = field.value;
  }
  return result;
}

export function buildAssignments(
  assignmentValues: Record<string, string>,
  knownFields: Record<string, NativeFlashField>,
): Array<{ symbol: string; value: string }> {
  const assignments: Array<{ symbol: string; value: string }> = [];
  for (const [fieldId, value] of Object.entries(assignmentValues)) {
    const field = knownFields[fieldId];
    if (!field) {
      continue;
    }
    if (field.kind === 'choice') {
      if (value) {
        assignments.push({ symbol: value, value: 'y' });
      }
      continue;
    }
    if (field.symbol) {
      assignments.push({ symbol: field.symbol, value });
    }
  }
  return assignments;
}

export function applyFieldValue(fields: NativeFlashField[], fieldId: string, value: string): NativeFlashField[] {
  return fields.map((field) => {
    if (field.id !== fieldId) {
      return field;
    }
    if (field.kind === 'choice') {
      return {
        ...field,
        value,
        options: field.options?.map((option) => ({
          ...option,
          selected: option.symbol === value,
        })),
      };
    }
    return {
      ...field,
      value,
    };
  });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatModified(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/** Merge static (config-driven) candidates with dynamically scanned ones, deduplicating by value. */
export function mergeDeviceCandidates(
  staticCandidates: NativeFlashDeviceCandidate[],
  scannedCandidates: NativeFlashDeviceCandidate[],
): NativeFlashDeviceCandidate[] {
  const seen = new Set(staticCandidates.map((c) => c.value));
  const extras = scannedCandidates.filter((c) => !seen.has(c.value));
  return [...staticCandidates, ...extras];
}

export function resolveFlashDevice(
  previous: FlashPanelStateLike,
  nextState: NativeFlashState,
  nextMethod: string,
  resetToDefault: boolean,
): string {
  const currentMethod = previous.flashMethod || previous.flashState?.default_flash_method || '';
  const currentDefault = resolveMethodDefaultDevice(previous.flashState, currentMethod);
  const nextDefault = resolveMethodDefaultDevice(nextState, nextMethod);
  if (resetToDefault) {
    if (previous.flashDevice && previous.flashDevice !== currentDefault) {
      return previous.flashDevice;
    }
    return nextDefault;
  }
  if (!previous.flashDevice || previous.flashDevice === currentDefault) {
    return nextDefault;
  }
  return previous.flashDevice;
}

export function groupedFields(fields: NativeFlashField[]): Map<string, NativeFlashField[]> {
  const groups = new Map<string, NativeFlashField[]>();
  for (const field of fields) {
    const name = field.menu_path.length > 0 ? field.menu_path.join(' / ') : 'General';
    const existing = groups.get(name);
    if (existing) {
      existing.push(field);
    } else {
      groups.set(name, [field]);
    }
  }
  return groups;
}
