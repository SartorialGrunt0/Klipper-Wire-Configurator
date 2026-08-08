import { describe, expect, it } from 'vitest';
import {
  MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS,
  buildPrinterMemoryValidationFeedback,
  extractPrinterMemoryBlock,
  getPrinterMemoryExtraKeys,
  hasPrinterMemoryBlock,
  stripPrinterMemoryExtraKeys,
  validatePrinterMemoryContent,
} from '@/utils/printerMemory';

const block = (json: string) => `Explaining...\n\`\`\`printer-memory\n${json}\n\`\`\``;

describe('hasPrinterMemoryBlock', () => {
  it('detects a printer-memory block', () => {
    expect(hasPrinterMemoryBlock('```printer-memory\n{}```')).toBe(true);
    expect(hasPrinterMemoryBlock('no block here')).toBe(false);
  });
});

describe('extractPrinterMemoryBlock', () => {
  it('extracts a valid block and normalizes display keys', () => {
    const result = extractPrinterMemoryBlock(block('{"Mainboard": "Spider", "Printer Name": "Trident"}'));
    expect(result).toEqual({ mainboard: 'Spider', printerName: 'Trident' });
  });

  it('handles explanatory text around the JSON', () => {
    const result = extractPrinterMemoryBlock(block('Here is my proposal:\n{"mainboard": "Spider"}'));
    expect(result).toEqual({ mainboard: 'Spider' });
  });

  it('strips extra keys as a safety net', () => {
    const result = extractPrinterMemoryBlock(block('{"mainboard": "Spider", "warpDrive": "on"}'));
    expect(result).toEqual({ mainboard: 'Spider' });
  });

  it('returns null when no block exists', () => {
    expect(extractPrinterMemoryBlock('just text')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractPrinterMemoryBlock(block('{not json'))).toBeNull();
  });
});

describe('getPrinterMemoryExtraKeys / stripPrinterMemoryExtraKeys', () => {
  it('finds keys outside the allowed set', () => {
    expect(getPrinterMemoryExtraKeys({ mainboard: 'x', warpDrive: 'y' })).toEqual(['warpDrive']);
  });

  it('strips disallowed keys', () => {
    expect(stripPrinterMemoryExtraKeys({ mainboard: 'x', warpDrive: 'y' })).toEqual({ mainboard: 'x' });
  });

  it('keeps all allowed keys', () => {
    const full = {
      mainboard: 'a', toolheadBoard: 'b', expanderBoards: 'c', printerName: 'd',
      kinematics: 'e', probe: 'f', additionalNotes: 'g',
    };
    expect(stripPrinterMemoryExtraKeys(full)).toEqual(full);
  });
});

describe('validatePrinterMemoryContent', () => {
  it('returns null when no block is present', () => {
    expect(validatePrinterMemoryContent('no block')).toBeNull();
  });

  it('accepts a valid block with no issues', () => {
    const result = validatePrinterMemoryContent(block('{"mainboard": "Spider"}'));
    expect(result).not.toBeNull();
    expect(result!.issues).toEqual([]);
    expect(result!.parsed).toEqual({ mainboard: 'Spider' });
  });

  it('flags an empty block', () => {
    const result = validatePrinterMemoryContent('```printer-memory\n```');
    expect(result!.issues[0].type).toBe('parse_error');
    expect(result!.issues[0].message).toContain('empty');
  });

  it('flags missing JSON object', () => {
    const result = validatePrinterMemoryContent(block('no braces here'));
    expect(result!.issues[0].type).toBe('parse_error');
  });

  it('flags invalid JSON', () => {
    const result = validatePrinterMemoryContent(block('{"mainboard": }'));
    expect(result!.issues[0].type).toBe('parse_error');
    expect(result!.issues[0].message).toContain('invalid JSON');
  });

  it('flags arrays as invalid', () => {
    const result = validatePrinterMemoryContent(block('[1,2,3]'));
    expect(result!.issues[0].type).toBe('parse_error');
  });

  it('flags extra keys', () => {
    const result = validatePrinterMemoryContent(block('{"mainboard": "Spider", "extraField": "x"}'));
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues[0].type).toBe('extra_keys');
    expect(result!.issues[0].extraKeys).toEqual(['extraField']);
    // The extra key is stripped from the parsed result.
    expect(result!.parsed).toEqual({ mainboard: 'Spider' });
  });
});

describe('buildPrinterMemoryValidationFeedback', () => {
  it('lists issues and the allowed fields', () => {
    const feedback = buildPrinterMemoryValidationFeedback([
      { type: 'extra_keys', message: 'Unsupported fields: warpDrive.', extraKeys: ['warpDrive'] },
      { type: 'parse_error', message: 'The block is empty.' },
    ]);
    expect(feedback).toContain('warpDrive');
    expect(feedback).toContain('The block is empty.');
    expect(feedback).toContain('mainboard');
    expect(feedback).toContain('toolheadBoard');
    expect(feedback).toContain('additionalNotes');
    expect(feedback).toContain('Return a corrected printer-memory block.');
  });
});

describe('MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS', () => {
  it('is 3', () => {
    expect(MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS).toBe(3);
  });
});
