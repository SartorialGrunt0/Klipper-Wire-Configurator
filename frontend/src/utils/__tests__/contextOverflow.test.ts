import { describe, expect, it } from 'vitest';

import {
  CONTEXT_OVERFLOW_BANNER_FALLBACK,
  CONTEXT_OVERFLOW_ERROR_CODE,
  isContextOverflowErrorCode,
} from '@/utils/contextOverflow';

describe('contextOverflow (W8)', () => {
  it('keys only on the structured backend code', () => {
    expect(isContextOverflowErrorCode(CONTEXT_OVERFLOW_ERROR_CODE)).toBe(true);
    // Never prose-matching: the banner keys on the code, not the message.
    expect(isContextOverflowErrorCode('context length exceeded')).toBe(false);
    expect(isContextOverflowErrorCode(undefined)).toBe(false);
    expect(isContextOverflowErrorCode(null)).toBe(false);
    expect(isContextOverflowErrorCode('')).toBe(false);
  });

  it('fallback label names both actionable exits, no numbers', () => {
    expect(CONTEXT_OVERFLOW_BANNER_FALLBACK).toContain('new chat');
    expect(CONTEXT_OVERFLOW_BANNER_FALLBACK).toContain('references');
    expect(CONTEXT_OVERFLOW_BANNER_FALLBACK).not.toMatch(/\d/);
  });
});
