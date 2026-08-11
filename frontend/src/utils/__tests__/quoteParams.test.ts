import { describe, expect, it } from 'vitest';
import { parseGcodeLine, parseParams } from '@/utils/gcodeSimulator';

describe('quote-aware param parsing', () => {
  it('keeps single-quoted MSG values intact', () => {
    const parsed = parseGcodeLine("RESPOND TYPE=echo MSG='Printer not homed'", 1, 'test');
    expect(parsed?.command).toBe('RESPOND');
    expect(parsed?.params.MSG).toBe('Printer not homed');
  });

  it('keeps double-quoted MSG values intact', () => {
    const parsed = parseGcodeLine('RESPOND MSG="hello world"', 1, 'test');
    expect(parsed?.params.MSG).toBe('hello world');
  });

  it('parseParams strips both quote styles', () => {
    expect(parseParams(["MSG='hello world'"])).toEqual({ MSG: 'hello world' });
    expect(parseParams(['MSG="hello world"'])).toEqual({ MSG: 'hello world' });
  });

  it('still parses plain KEY=VALUE and positional params', () => {
    expect(parseParams(['TEMP=80', 'FAN=255'])).toEqual({ TEMP: '80', FAN: '255' });
    expect(parseParams(['X100', 'Y50'])).toEqual({ X: '100', Y: '50' });
  });
});
