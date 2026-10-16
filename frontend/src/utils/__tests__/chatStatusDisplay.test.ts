import { describe, expect, it } from 'vitest';

import {
  chatStatusActive,
  chatStatusButtonClass,
  chatStatusTitle,
} from '../chatStatusDisplay';

describe('chatStatusDisplay', () => {
  it('idle carries no attention signal', () => {
    expect(chatStatusActive('idle')).toBe(false);
    expect(chatStatusActive('success')).toBe(true);
    expect(chatStatusActive('awaiting')).toBe(true);
    expect(chatStatusActive('error')).toBe(true);
  });

  it('fold/toolbar button classes: green for success/awaiting, red for error', () => {
    expect(chatStatusButtonClass('success')).toBe('bg-green-600 text-white hover:bg-green-700');
    expect(chatStatusButtonClass('awaiting')).toBe('bg-green-600 text-white hover:bg-green-700');
    expect(chatStatusButtonClass('error')).toBe('bg-red-600 text-white hover:bg-red-700');
    // Idle contributes no classes — the caller supplies its own default look.
    expect(chatStatusButtonClass('idle')).toBe('');
  });

  it('titles: status-specific, idle falls back to the surface label', () => {
    expect(chatStatusTitle('success', 'AI Chat')).toBe('AI Chat — response ready');
    expect(chatStatusTitle('awaiting', 'AI Chat')).toBe('AI Chat — an edit needs your decision');
    expect(chatStatusTitle('error', 'AI Chat')).toBe('AI Chat — last request failed');
    expect(chatStatusTitle('idle', 'Show the AI chat')).toBe('Show the AI chat');
    expect(chatStatusTitle('idle', 'Hide the AI chat')).toBe('Hide the AI chat');
  });
});
