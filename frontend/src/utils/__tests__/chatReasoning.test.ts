import { describe, expect, it } from 'vitest';
import {
  ASSUMED_REASONING_LEVELS,
  EMPTY_REASONING_PROBE,
  REASONING_DEFAULT,
  isStaleEffort,
  reasoningEffortHint,
  reasoningEffortOptions,
  reasoningSettingApplies,
} from '@/utils/chatReasoning';

describe('reasoningSettingApplies', () => {
  it('is wired for the openai-compatible provider only', () => {
    expect(reasoningSettingApplies('openai-compatible')).toBe(true);
    for (const p of ['chatgpt', 'google', 'anthropic', 'github']) {
      expect(reasoningSettingApplies(p)).toBe(false);
    }
  });
});

describe('reasoningEffortOptions', () => {
  it('lists advertised props levels in server order after Default', () => {
    const probe = { levels: ['low', 'medium', 'xhigh'], source: 'props' as const };
    expect(reasoningEffortOptions(probe, 'medium')).toEqual(['default', 'low', 'medium', 'xhigh']);
  });

  it('props [] means no ladder at all (authoritative empty, not unknown)', () => {
    expect(reasoningEffortOptions({ levels: [], source: 'props' }, 'default'))
      .toEqual(['default']);
  });

  it('unknown source offers the assumed ladder', () => {
    expect(reasoningEffortOptions(EMPTY_REASONING_PROBE, 'default'))
      .toEqual([REASONING_DEFAULT, ...ASSUMED_REASONING_LEVELS]);
  });

  it('appends a saved level the probe does not list — the form never silently rewrites it', () => {
    const probe = { levels: ['low', 'medium', 'xhigh'], source: 'props' as const };
    expect(reasoningEffortOptions(probe, 'ultra')).toEqual(['default', 'low', 'medium', 'xhigh', 'ultra']);
  });

  it('never duplicates a saved level already in the list', () => {
    expect(reasoningEffortOptions(EMPTY_REASONING_PROBE, 'high'))
      .toEqual(['default', 'low', 'medium', 'high']);
  });
});

describe('isStaleEffort', () => {
  it('fires only against an authoritative props list', () => {
    expect(isStaleEffort({ levels: ['low'], source: 'props' }, 'ultra')).toBe(true);
    expect(isStaleEffort(EMPTY_REASONING_PROBE, 'ultra')).toBe(false);
    expect(isStaleEffort({ levels: ['low'], source: 'props' }, 'default')).toBe(false);
    expect(isStaleEffort({ levels: ['low'], source: 'props' }, 'low')).toBe(false);
  });
});

describe('reasoningEffortHint', () => {
  it('labels the empty props answer honestly', () => {
    expect(reasoningEffortHint({ levels: [], source: 'props' }, 'default'))
      .toMatch(/no configurable/i);
  });

  it('warns on a stale saved level', () => {
    expect(reasoningEffortHint({ levels: ['low'], source: 'props' }, 'ultra'))
      .toContain('ultra');
  });

  it('flags the assumed ladder as assumed', () => {
    expect(reasoningEffortHint(EMPTY_REASONING_PROBE, 'default')).toMatch(/assumed/i);
  });
});
