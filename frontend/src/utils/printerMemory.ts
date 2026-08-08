/**
 * Printer-memory code block extraction, validation, and feedback.
 *
 * Extracted from chatUtils.ts (Phase 3 cleanup) — pure functions.
 */

// ── Printer Memory Code Block Extraction ───────────────────────────

const PRINTER_MEMORY_LANGUAGE = 'printer-memory';

/**
 * Normalise printer memory keys from display-friendly formats (e.g.
 * "Mainboard", "Toolhead Board", "Printer Name") to internal camelCase
 * keys ("mainboard", "toolheadBoard", "printerName").
 */
const PRINTER_MEMORY_KEY_MAP: Record<string, string> = {
  mainboard: 'mainboard',
  Mainboard: 'mainboard',
  'toolhead board': 'toolheadBoard',
  'Toolhead Board': 'toolheadBoard',
  toolheadboard: 'toolheadBoard',
  'expander boards': 'expanderBoards',
  'Expander Boards': 'expanderBoards',
  expanderboards: 'expanderBoards',
  'printer name': 'printerName',
  'Printer Name': 'printerName',
  printername: 'printerName',
  kinematics: 'kinematics',
  Kinematics: 'kinematics',
  probe: 'probe',
  Probe: 'probe',
  'additional notes': 'additionalNotes',
  'Additional Notes': 'additionalNotes',
  additionalnotes: 'additionalNotes',
};

function normalizePrinterMemoryKeys(raw: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = PRINTER_MEMORY_KEY_MAP[key.trim()] || key;
    result[canonical] = typeof value === 'string' ? value : String(value ?? '');
  }
  return result;
}

/**
 * Extract a printer-memory fenced code block from AI response text.
 * Returns the parsed PrinterMemory object, or null if none found.
 *
 * Handles:
 * - Explanatory text around the JSON inside the code block
 * - Display-friendly keys ("Mainboard", "Printer Name") → canonical camelCase
 */
export function extractPrinterMemoryBlock(content: string): Record<string, string> | null {
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    if (language !== PRINTER_MEMORY_LANGUAGE) continue;
    const block = match[2].trim();
    if (!block) continue;

    // Find JSON content within the block — look for first { to last }
    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) continue;
    const jsonEnd = block.lastIndexOf('}');
    if (jsonEnd === -1 || jsonEnd <= jsonStart) continue;
    const jsonStr = block.slice(jsonStart, jsonEnd + 1);

    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizePrinterMemoryKeys(parsed as Record<string, string>);
        // Strip any keys not in the allowed set (safety net against AI adding extra fields)
        return stripPrinterMemoryExtraKeys(normalized);
      }
    } catch {
      // Not valid JSON, skip this block
    }
  }
  return null;
}

/**
 * Check if a message contains a printer-memory code block.
 */
export function hasPrinterMemoryBlock(content: string): boolean {
  return /```printer-memory\s*\n/i.test(content);
}

// ── Printer Memory Validation ──────────────────────────────────

/** The only keys the printer-memory JSON may contain. */
const ALLOWED_PRINTER_MEMORY_KEYS = new Set([
  'mainboard',
  'toolheadBoard',
  'expanderBoards',
  'printerName',
  'kinematics',
  'probe',
  'additionalNotes',
]);

/**
 * Return any keys in the parsed object that are NOT in the allowed set.
 * Used to detect when the AI adds unsupported fields.
 */
export function getPrinterMemoryExtraKeys(
  parsed: Record<string, string>,
): string[] {
  return Object.keys(parsed).filter((k) => !ALLOWED_PRINTER_MEMORY_KEYS.has(k));
}

/**
 * Strip any keys from the object that aren't in the allowed set.
 * Applied inside `extractPrinterMemoryBlock` as a safety net.
 */
export function stripPrinterMemoryExtraKeys(
  parsed: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_PRINTER_MEMORY_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ── Comprehensive Printer Memory Validation ────────────────────

export interface PrinterMemoryValidationIssue {
  type: 'parse_error' | 'extra_keys';
  message: string;
  extraKeys?: string[];
}

/**
 * Run comprehensive validation on an AI message containing a
 * printer-memory code block. Catches:
 * - Missing/invalid JSON inside the block
 * - Non-object values (arrays, primitives)
 * - Extra fields beyond the 7 allowed keys
 *
 * @returns null if no printer-memory block is found.
 *          Otherwise returns issues (empty = valid) + the cleaned parsed data.
 */
export function validatePrinterMemoryContent(
  content: string,
): { issues: PrinterMemoryValidationIssue[]; parsed: Record<string, string> | null } | null {
  if (!hasPrinterMemoryBlock(content)) return null;

  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    if (language !== PRINTER_MEMORY_LANGUAGE) continue;

    const block = match[2].trim();
    if (!block) {
      return { issues: [{ type: 'parse_error', message: 'The printer-memory code block is empty.' }], parsed: null };
    }

    // Find JSON content within the block
    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block does not contain a JSON object (no opening { found).' }],
        parsed: null,
      };
    }
    const jsonEnd = block.lastIndexOf('}');
    if (jsonEnd === -1 || jsonEnd <= jsonStart) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block has an incomplete JSON object (missing closing }).' }],
        parsed: null,
      };
    }

    const jsonStr = block.slice(jsonStart, jsonEnd + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return {
        issues: [{ type: 'parse_error', message: `The printer-memory block contains invalid JSON: ${detail}` }],
        parsed: null,
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block JSON must be a flat object, not an array or primitive.' }],
        parsed: null,
      };
    }

    // Normalise keys to canonical camelCase
    const normalized = normalizePrinterMemoryKeys(parsed as Record<string, string>);
    const issues: PrinterMemoryValidationIssue[] = [];

    // Check for extra keys
    const extraKeys = getPrinterMemoryExtraKeys(normalized);
    if (extraKeys.length > 0) {
      issues.push({
        type: 'extra_keys',
        message: `Unsupported fields: ${extraKeys.join(', ')}. Only the 7 defined fields are allowed.`,
        extraKeys,
      });
    }

    // Strip extras and return
    const stripped = stripPrinterMemoryExtraKeys(normalized);
    return { issues, parsed: Object.keys(stripped).length > 0 ? stripped : null };
  }

  return null;
}

/** Build a user-role message telling the AI to fix printer-memory block issues. */
export function buildPrinterMemoryValidationFeedback(
  issues: PrinterMemoryValidationIssue[],
): string {
  const parts: string[] = [
    'The printer-memory block you returned has errors that must be fixed:',
    '',
  ];
  for (const issue of issues) {
    if (issue.type === 'parse_error') {
      parts.push('- The block has a formatting error.');
      parts.push(`  ${issue.message}`);
    } else if (issue.type === 'extra_keys') {
      parts.push('- The block contains fields that are not supported.');
      parts.push(`  ${issue.message}`);
    }
  }
  parts.push('');
  parts.push('Only these 7 fields are allowed:');
  parts.push('  - mainboard');
  parts.push('  - toolheadBoard');
  parts.push('  - expanderBoards');
  parts.push('  - printerName');
  parts.push('  - kinematics');
  parts.push('  - probe');
  parts.push('  - additionalNotes');
  parts.push('');
  parts.push('All values must be plain strings. Return a corrected printer-memory block.');
  return parts.join('\n');
}

/** Maximum retries for printer memory validation. */
export const MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS = 3;
