import { describe, expect, it } from 'vitest';

import {
  CONTEXT_CHIP_TIGHT_RATIO,
  buildContextChipDetails,
  computeContextGauge,
  formatDuration,
  formatExactTokens,
  formatTokenCount,
  resolveContextWindow,
} from '@/utils/contextChip';

describe('computeContextGauge', () => {
  it('reports a calm ring well under the advisory threshold', () => {
    expect(computeContextGauge({ promptTokens: 50000, contextWindow: 100000 })).toEqual({
      promptTokens: 50000,
      contextWindow: 100000,
      ratio: 0.5,
      band: 'calm',
    });
  });

  it('turns warm exactly at the W7 advisory ratio — one number governs both', () => {
    expect(computeContextGauge({ promptTokens: 70000, contextWindow: 100000 })?.band).toBe('warm');
    expect(computeContextGauge({ promptTokens: 69999, contextWindow: 100000 })?.band).toBe('calm');
  });

  it('turns tight at 90% of the window', () => {
    expect(computeContextGauge({ promptTokens: 90000, contextWindow: 100000 })?.band).toBe('tight');
    expect(computeContextGauge({ promptTokens: 89999, contextWindow: 100000 })?.band).toBe('warm');
  });

  it('clamps a provider over-report to a full ring', () => {
    const gauge = computeContextGauge({ promptTokens: 120000, contextWindow: 100000 });
    expect(gauge?.ratio).toBe(1);
    expect(gauge?.band).toBe('tight');
  });

  it('returns null rather than guess when either side is unknown or nonsensical', () => {
    expect(computeContextGauge({ promptTokens: null, contextWindow: 131072 })).toBeNull();
    expect(computeContextGauge({ promptTokens: 47000, contextWindow: null })).toBeNull();
    expect(computeContextGauge({ promptTokens: 47000, contextWindow: 0 })).toBeNull();
    expect(computeContextGauge({ promptTokens: Number.NaN, contextWindow: 131072 })).toBeNull();
    expect(computeContextGauge({ promptTokens: -5, contextWindow: 131072 })).toBeNull();
  });

  it('pins the tight ratio as a distinct constant', () => {
    expect(CONTEXT_CHIP_TIGHT_RATIO).toBe(0.9);
  });
});

describe('resolveContextWindow', () => {
  it('prefers the window captured with the reply', () => {
    expect(resolveContextWindow({
      messageWindow: 32768, messageKey: 'u::m', probedKey: 'u::m', probedWindow: 131072,
    })).toBe(32768);
  });

  it('lets the live probe heal a reply sent before the probe settled', () => {
    expect(resolveContextWindow({
      messageWindow: null, messageKey: 'u::m', probedKey: 'u::m', probedWindow: 131072,
    })).toBe(131072);
  });

  it('never borrows a window probed for a different provider or model', () => {
    expect(resolveContextWindow({
      messageWindow: null, messageKey: 'u::small', probedKey: 'u::big', probedWindow: 131072,
    })).toBeNull();
    expect(resolveContextWindow({
      messageWindow: null, messageKey: null, probedKey: 'u::m', probedWindow: 131072,
    })).toBeNull();
  });

  it('ignores a nonsensical live window', () => {
    expect(resolveContextWindow({
      messageWindow: null, messageKey: 'u::m', probedKey: 'u::m', probedWindow: 0,
    })).toBeNull();
    expect(resolveContextWindow({
      messageWindow: null, messageKey: 'u::m', probedKey: 'u::m', probedWindow: Number.NaN,
    })).toBeNull();
  });
});

describe('formatExactTokens', () => {
  it('groups thousands so the used/total read is unambiguous', () => {
    expect(formatExactTokens(47707)).toBe('47,707');
    expect(formatExactTokens(131072)).toBe('131,072');
    expect(formatExactTokens(947)).toBe('947');
  });

  it('shows an em dash for unknown counts', () => {
    expect(formatExactTokens(null)).toBe('—');
    expect(formatExactTokens(undefined)).toBe('—');
    expect(formatExactTokens(Number.NaN)).toBe('—');
  });
});

describe('formatTokenCount', () => {
  it('uses compact units for reuse figures', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(947)).toBe('947');
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(47707)).toBe('47.7K');
    expect(formatTokenCount(1200000)).toBe('1.2M');
  });

  it('shows an em dash for unknown counts', () => {
    expect(formatTokenCount(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('keeps sub-second replies in milliseconds', () => {
    expect(formatDuration(850)).toBe('850 ms');
  });

  it('uses seconds with one decimal, then minutes', () => {
    expect(formatDuration(8200)).toBe('8.2 s');
    expect(formatDuration(125000)).toBe('2m 05s');
  });

  it('shows an em dash for unknown durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('buildContextChipDetails', () => {
  const base = {
    promptTokens: 47707,
    cachedTokens: 42936,
    contextWindow: 131072,
    replyMs: 8200,
    toolCalls: 3,
    model: 'gemma-4-26b-a4b',
  };

  it('leads with used / total context', () => {
    const [first] = buildContextChipDetails(base);
    expect(first).toEqual({ label: 'Context', value: '47,707 / 131,072 tokens (36%)' });
  });

  it('shows the cached share with the absolute reuse', () => {
    expect(buildContextChipDetails(base)[1]).toEqual({
      label: 'Cached',
      value: '90% — 42.9K tokens reused',
    });
  });

  it('shows a full miss as a miss, never as unknown', () => {
    expect(buildContextChipDetails({ ...base, cachedTokens: 0 })[1]).toEqual({
      label: 'Cached',
      value: '0% — nothing reused',
    });
  });

  it('omits the cached row when the provider reported no cache numbers', () => {
    const labels = buildContextChipDetails({ ...base, cachedTokens: null }).map((d) => d.label);
    expect(labels).not.toContain('Cached');
  });

  it('drops the percentage when the window is unknown but keeps the token count', () => {
    const [first] = buildContextChipDetails({ ...base, contextWindow: null });
    expect(first).toEqual({ label: 'Context', value: '47,707 tokens' });
  });

  it('shows tool calls only when the reply used some', () => {
    expect(buildContextChipDetails(base).map((d) => d.label)).toContain('Tool calls');
    expect(buildContextChipDetails({ ...base, toolCalls: 0 }).map((d) => d.label))
      .not.toContain('Tool calls');
  });

  it('always ends with the model', () => {
    const details = buildContextChipDetails(base);
    expect(details[details.length - 1]).toEqual({ label: 'Model', value: 'gemma-4-26b-a4b' });
  });

  it('renders an empty list rather than junk when nothing is known', () => {
    expect(buildContextChipDetails({
      promptTokens: null,
      cachedTokens: null,
      contextWindow: null,
      replyMs: null,
      toolCalls: 0,
      model: null,
    })).toEqual([]);
  });
});
