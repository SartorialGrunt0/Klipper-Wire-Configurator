import { describe, expect, it } from 'vitest';

import {
  CONTEXT_PRESSURE_ADVISORY_RATIO,
  CONTEXT_PRESSURE_ADVISORY_TEXT,
  evaluateContextPressure,
} from '@/utils/contextPressure';

describe('evaluateContextPressure', () => {
  it('fires at exactly 70% of the window', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 70000, contextWindow: 100000 }))
      .toEqual({ advisory: true, ratio: 0.7 });
  });

  it('stays silent just under the threshold', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 69999, contextWindow: 100000 }).advisory)
      .toBe(false);
  });

  it('fires above the threshold', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 240000, contextWindow: 256000 }).advisory)
      .toBe(true);
  });

  it('stays silent when the prompt tokens are unknown', () => {
    expect(evaluateContextPressure({ lastPromptTokens: null, contextWindow: 8192 }))
      .toEqual({ advisory: false, ratio: null });
    expect(evaluateContextPressure({ lastPromptTokens: undefined, contextWindow: 8192 }).ratio)
      .toBeNull();
  });

  it('stays silent when the window is unknown — never guesses a budget', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 100000, contextWindow: null }))
      .toEqual({ advisory: false, ratio: null });
    expect(evaluateContextPressure({ lastPromptTokens: 100000, contextWindow: undefined }).advisory)
      .toBe(false);
  });

  it('rejects nonsensical windows and token counts', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 10, contextWindow: 0 }).advisory).toBe(false);
    expect(evaluateContextPressure({ lastPromptTokens: 10, contextWindow: -1 }).ratio).toBeNull();
    expect(evaluateContextPressure({ lastPromptTokens: -1, contextWindow: 100 }).advisory).toBe(false);
    expect(evaluateContextPressure({ lastPromptTokens: Number.NaN, contextWindow: 100 }).advisory).toBe(false);
    expect(evaluateContextPressure({ lastPromptTokens: '999' as unknown as number, contextWindow: 100 }).advisory).toBe(false);
  });

  it('treats a zero-token prompt as no pressure', () => {
    expect(evaluateContextPressure({ lastPromptTokens: 0, contextWindow: 8192 }))
      .toEqual({ advisory: false, ratio: 0 });
  });

  it('uses pi\'s amber threshold and the agreed label', () => {
    expect(CONTEXT_PRESSURE_ADVISORY_RATIO).toBe(0.7);
    expect(CONTEXT_PRESSURE_ADVISORY_TEXT).toMatch(/new chat/i);
    // One label, no numbers demanded of the user.
    expect(CONTEXT_PRESSURE_ADVISORY_TEXT).not.toMatch(/\d/);
  });
});
