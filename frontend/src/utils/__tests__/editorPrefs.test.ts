import { describe, it, expect } from 'vitest';
import {
  ISSUE_STRIP_KEY,
  readIssueStripCollapsed,
  writeIssueStripCollapsed,
  type PrefStorage,
} from '../editorPrefs';

function memoryStore(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwingStore: PrefStorage = {
  getItem() {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('denied');
  },
};

describe('findings strip preference', () => {
  it('is collapsed by default', () => {
    expect(readIssueStripCollapsed(memoryStore())).toBe(true);
  });

  it('round-trips expanded and collapsed', () => {
    const store = memoryStore();
    writeIssueStripCollapsed(false, store);
    expect(store.data[ISSUE_STRIP_KEY]).toBe('expanded');
    expect(readIssueStripCollapsed(store)).toBe(false);

    writeIssueStripCollapsed(true, store);
    expect(readIssueStripCollapsed(store)).toBe(true);
  });

  it('falls back to collapsed for an unrecognised stored value', () => {
    expect(readIssueStripCollapsed(memoryStore({ [ISSUE_STRIP_KEY]: 'nonsense' }))).toBe(true);
  });

  it('never throws when storage is unavailable', () => {
    expect(readIssueStripCollapsed(null)).toBe(true);
    expect(() => writeIssueStripCollapsed(false, null)).not.toThrow();
  });

  it('never throws when storage access is denied', () => {
    expect(readIssueStripCollapsed(throwingStore)).toBe(true);
    expect(() => writeIssueStripCollapsed(false, throwingStore)).not.toThrow();
  });
});
