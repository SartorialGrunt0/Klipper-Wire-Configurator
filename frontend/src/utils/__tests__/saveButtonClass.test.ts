import { describe, expect, it } from 'vitest';
import { getSaveButtonClass } from '../saveButtonClass';
import type { ValidationResult } from '../../types/config';

function val(errors: Array<{ severity: 'error' | 'warning' | 'info' }>): ValidationResult {
  return {
    has_errors: errors.some((e) => e.severity === 'error'),
    has_warnings: errors.some((e) => e.severity === 'warning'),
    errors: errors.map((e) => ({
      severity: e.severity,
      section: '',
      param: '',
      message: '',
      line_number: 0,
    })),
  };
}

describe('getSaveButtonClass', () => {
  it('is grey when not dirty', () => {
    expect(getSaveButtonClass(false, { 'printer.cfg': val([]) })).toContain('bg-[var(--color-bg-tertiary)]');
  });

  it('is green when dirty and clean', () => {
    expect(getSaveButtonClass(true, { 'printer.cfg': val([]) })).toBe('bg-green-600 text-white hover:bg-green-700');
  });

  it('is yellow when dirty with warnings', () => {
    const result = getSaveButtonClass(true, { 'printer.cfg': val([{ severity: 'warning' }]) });
    expect(result).toContain('bg-[var(--color-warning)]');
  });

  it('is red when dirty with errors', () => {
    const result = getSaveButtonClass(true, { 'printer.cfg': val([{ severity: 'error' }]) });
    expect(result).toContain('bg-red-600');
  });

  it('error beats warning across files', () => {
    const result = getSaveButtonClass(true, {
      'a.cfg': val([{ severity: 'warning' }]),
      'b.cfg': val([{ severity: 'error' }]),
    });
    expect(result).toContain('bg-red-600');
  });

  it('info-only issues still count as green when dirty', () => {
    expect(getSaveButtonClass(true, { 'printer.cfg': val([{ severity: 'info' }]) })).toBe(
      'bg-green-600 text-white hover:bg-green-700',
    );
  });

  it('empty validation map is green when dirty', () => {
    expect(getSaveButtonClass(true, {})).toBe('bg-green-600 text-white hover:bg-green-700');
  });

  it('is red when dirty and a text file cannot be parsed, even if validation is clean', () => {
    const result = getSaveButtonClass(true, { 'printer.cfg': val([]) }, true);
    expect(result).toContain('bg-red-600');
  });

  it('parse error beats warnings (red, not yellow) when dirty', () => {
    const result = getSaveButtonClass(true, { 'printer.cfg': val([{ severity: 'warning' }]) }, true);
    expect(result).toContain('bg-red-600');
  });

  it('is grey when not dirty, even with a parse error present', () => {
    expect(getSaveButtonClass(false, { 'printer.cfg': val([]) }, true)).toContain(
      'bg-[var(--color-bg-tertiary)]',
    );
  });

  it('defaults to no-parse-error when the third arg is omitted', () => {
    expect(getSaveButtonClass(true, { 'printer.cfg': val([]) })).toBe(
      'bg-green-600 text-white hover:bg-green-700',
    );
  });
});
