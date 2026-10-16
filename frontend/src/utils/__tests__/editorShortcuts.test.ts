import { describe, expect, it } from 'vitest';

import { isSaveShortcut, matchEditorShortcut } from '@/utils/editorShortcuts';

function key(over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  return { key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over };
}

describe('matchEditorShortcut', () => {
  it('matches Ctrl+F as find', () => {
    expect(matchEditorShortcut(key({ key: 'f', ctrlKey: true }))).toBe('find');
  });

  it('matches Cmd+F as find (Mac)', () => {
    expect(matchEditorShortcut(key({ key: 'F', metaKey: true }))).toBe('find');
  });

  it('matches Ctrl+H as replace', () => {
    expect(matchEditorShortcut(key({ key: 'h', ctrlKey: true }))).toBe('replace');
  });

  it('matches Cmd+H as replace (Mac)', () => {
    expect(matchEditorShortcut(key({ key: 'H', metaKey: true }))).toBe('replace');
  });

  it('ignores bare letters — no modifier means plain typing', () => {
    expect(matchEditorShortcut(key({ key: 'f' }))).toBeNull();
    expect(matchEditorShortcut(key({ key: 'h' }))).toBeNull();
  });

  it('ignores Ctrl+Shift+F and Ctrl+Shift+H — those stay unbound', () => {
    expect(matchEditorShortcut(key({ key: 'f', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchEditorShortcut(key({ key: 'h', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Alt combos — Alt belongs to the OS/browser', () => {
    expect(matchEditorShortcut(key({ key: 'f', ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('ignores other Ctrl letters', () => {
    expect(matchEditorShortcut(key({ key: 's', ctrlKey: true }))).toBeNull();
    expect(matchEditorShortcut(key({ key: ' ', ctrlKey: true }))).toBeNull();
  });
});

describe('isSaveShortcut', () => {
  it('matches Ctrl+S and Cmd+S', () => {
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: 'S', metaKey: true }))).toBe(true);
  });

  it('ignores bare s — plain typing', () => {
    expect(isSaveShortcut(key({ key: 's' }))).toBe(false);
  });

  it('ignores modifier variants — only the plain chord is bound', () => {
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true, altKey: true }))).toBe(false);
  });
});
