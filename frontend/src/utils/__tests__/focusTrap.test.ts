import { describe, expect, it } from 'vitest';
import { isTabbable, nextTrapIndex, type TabbableProbe } from '../focusTrap';

function probe(over: Partial<TabbableProbe> = {}): TabbableProbe {
  return {
    tagName: 'BUTTON',
    disabled: false,
    tabIndex: 0,
    ariaHidden: false,
    hiddenAttr: false,
    inert: false,
    displayNone: false,
    visibilityHidden: false,
    ...over,
  };
}

describe('isTabbable', () => {
  it('accepts enabled buttons and inputs', () => {
    expect(isTabbable(probe())).toBe(true);
    expect(isTabbable(probe({ tagName: 'INPUT' }))).toBe(true);
    expect(isTabbable(probe({ tagName: 'SELECT' }))).toBe(true);
    expect(isTabbable(probe({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isTabbable(probe({ tagName: 'A' }))).toBe(true);
  });

  it('rejects disabled, tabIndex<0, aria-hidden, hidden, inert', () => {
    expect(isTabbable(probe({ disabled: true }))).toBe(false);
    expect(isTabbable(probe({ tabIndex: -1 }))).toBe(false);
    expect(isTabbable(probe({ ariaHidden: true }))).toBe(false);
    expect(isTabbable(probe({ hiddenAttr: true }))).toBe(false);
    expect(isTabbable(probe({ inert: true }))).toBe(false);
    expect(isTabbable(probe({ displayNone: true }))).toBe(false);
    expect(isTabbable(probe({ visibilityHidden: true }))).toBe(false);
  });

  it('rejects non-interactive tags without an explicit tabIndex', () => {
    expect(isTabbable(probe({ tagName: 'DIV', tabIndex: Number.NaN }))).toBe(false);
    expect(isTabbable(probe({ tagName: 'SPAN', tabIndex: Number.NaN }))).toBe(false);
    expect(isTabbable(probe({ tagName: 'DIV', tabIndex: 0 }))).toBe(true);
    expect(isTabbable(probe({ tagName: 'DIV', tabIndex: 2 }))).toBe(true);
  });

  it('treats tabIndex NaN (attribute absent) as default 0 semantics', () => {
    expect(isTabbable(probe({ tabIndex: Number.NaN }))).toBe(true);
    expect(isTabbable(probe({ tagName: 'DIV', tabIndex: Number.NaN }))).toBe(false);
  });
});

describe('nextTrapIndex', () => {
  const flags = [true, false, true, true]; // tabbables at 0, 2, 3

  it('moves forward skipping non-tabbables', () => {
    expect(nextTrapIndex(flags, 0, false)).toBe(2);
    expect(nextTrapIndex(flags, 2, false)).toBe(3);
  });

  it('wraps forward from last tabbable to first', () => {
    expect(nextTrapIndex(flags, 3, false)).toBe(0);
  });

  it('moves backward skipping non-tabbables and wraps', () => {
    expect(nextTrapIndex(flags, 2, true)).toBe(0);
    expect(nextTrapIndex(flags, 0, true)).toBe(3);
  });

  it('handles the no-tabbable list by staying put (null)', () => {
    expect(nextTrapIndex([false, false], 0, false)).toBeNull();
  });

  it('handles active index outside the list (focus elsewhere in DOM)', () => {
    // Nothing focused inside: forward goes to first tabbable, backward to last.
    expect(nextTrapIndex(flags, -1, false)).toBe(0);
    expect(nextTrapIndex(flags, -1, true)).toBe(3);
  });

  it('handles active pointing at a non-tabbable element', () => {
    expect(nextTrapIndex(flags, 1, false)).toBe(2);
    expect(nextTrapIndex(flags, 1, true)).toBe(0);
  });
});
