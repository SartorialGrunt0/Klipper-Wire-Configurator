/**
 * Utilities for managing MCU pin prefixes in Klipper configs.
 *
 * Klipper pin format: [modifiers][mcuName:]pinName
 *   - modifiers: optional leading !, ^, ~ characters
 *   - mcuName: the named MCU (e.g., EBBCan) — omitted for primary MCU
 *   - pinName: the actual pin (e.g., gpio13, PA9, PB0)
 *
 * Examples:
 *   Primary MCU: gpio6, !^PA9
 *   Named MCU:   EBBCan:gpio13, !^EBBCan:gpio6
 */

import type { ConfigSection, ParamSchema, SectionSchema } from '../types/config';

/* ── Pin-param detection ────────────────────────────── */

const PIN_NAME_RE = /(_pin|^pin)$/i;

/** Check if a param name is likely a pin param by naming convention. */
export function isPinParamName(paramName: string): boolean {
  return PIN_NAME_RE.test(paramName);
}

/** Check if a param is a pin using schema info or name heuristic. */
export function isPinParam(
  paramName: string,
  sectionSchema?: SectionSchema,
): boolean {
  if (sectionSchema) {
    const pdef = sectionSchema.params.find((p: ParamSchema) => p.name === paramName);
    if (pdef) return pdef.type === 'pin';
  }
  return isPinParamName(paramName);
}

/* ── Pin value parsing ──────────────────────────────── */

interface ParsedPin {
  modifiers: string; // leading !^~ chars
  mcuName: string;   // MCU prefix (empty if none)
  pinName: string;   // the actual pin identifier
}

const PIN_PARSE_RE = /^([!^~]*)(?:(\w+)\s*:\s*)?(.+)$/;

export function parsePin(value: string): ParsedPin | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'z_virtual_endstop') return null;
  const m = PIN_PARSE_RE.exec(trimmed);
  if (!m) return null;
  return {
    modifiers: m[1] || '',
    mcuName: m[2] || '',
    pinName: m[3].trim(),
  };
}

export function formatPin(parsed: ParsedPin): string {
  const prefix = parsed.mcuName ? `${parsed.mcuName}:` : '';
  return `${parsed.modifiers}${prefix}${parsed.pinName}`;
}

/* ── Prefix manipulation ────────────────────────────── */

/**
 * Add an MCU prefix to a pin value if it doesn't already have one.
 * Preserves modifiers.
 */
export function addMcuPrefix(pinValue: string, mcuName: string): string {
  if (!mcuName) return pinValue;
  const parsed = parsePin(pinValue);
  if (!parsed) return pinValue;
  if (parsed.mcuName) return pinValue; // already has a prefix
  parsed.mcuName = mcuName;
  return formatPin(parsed);
}

/**
 * Remove a specific MCU prefix from a pin value.
 * Only removes if the prefix matches the given mcuName.
 */
export function removeMcuPrefix(pinValue: string, mcuName: string): string {
  if (!mcuName) return pinValue;
  const parsed = parsePin(pinValue);
  if (!parsed) return pinValue;
  if (parsed.mcuName !== mcuName) return pinValue;
  parsed.mcuName = '';
  return formatPin(parsed);
}

/**
 * Replace one MCU prefix with another on a pin value.
 * If oldMcu is empty, adds the new prefix to unprefixed pins.
 * If newMcu is empty, removes the old prefix.
 */
export function swapMcuPrefix(
  pinValue: string,
  oldMcu: string,
  newMcu: string,
): string {
  const parsed = parsePin(pinValue);
  if (!parsed) return pinValue;
  if (oldMcu && parsed.mcuName !== oldMcu) return pinValue;
  if (!oldMcu && parsed.mcuName) return pinValue; // has a different prefix, don't touch
  parsed.mcuName = newMcu;
  return formatPin(parsed);
}

/* ── Batch section updates ──────────────────────────── */

/**
 * Update all pin params in a section's params, swapping MCU prefixes.
 * Returns a new params array (immutable).
 */
export function updateSectionPins(
  section: ConfigSection,
  oldMcu: string,
  newMcu: string,
  schemas?: Record<string, SectionSchema>,
): ConfigSection {
  const sectionSchema = schemas?.[section.section_type];
  const newParams = section.params.map((p) => {
    if (p.is_commented_out) return p;
    if (!isPinParam(p.key, sectionSchema)) return p;
    const newValue = swapMcuPrefix(p.value, oldMcu, newMcu);
    if (newValue === p.value) return p;
    return { ...p, value: newValue };
  });
  return { ...section, params: newParams };
}

/**
 * Update all pin params across an array of sections.
 */
export function updateAllSectionPins(
  sections: ConfigSection[],
  oldMcu: string,
  newMcu: string,
  schemas?: Record<string, SectionSchema>,
): ConfigSection[] {
  return sections.map((s) => updateSectionPins(s, oldMcu, newMcu, schemas));
}

/**
 * Get the MCU name from a hardware node's data, returning empty string for primary MCU.
 */
export function getMcuName(hwData: Record<string, unknown>): string {
  return (hwData.mcuName as string) || '';
}
