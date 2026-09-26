import { describe, expect, it } from 'vitest';

import {
  CHAT_STICK_THRESHOLD_PX,
  isNearBottom,
  nextStickToBottom,
} from '../chatScroll';

describe('isNearBottom', () => {
  it('is true when scrolled to the very bottom', () => {
    expect(isNearBottom(500, 1000, 500)).toBe(true);
  });

  it('is true within the stick threshold', () => {
    expect(isNearBottom(500 - CHAT_STICK_THRESHOLD_PX, 1000, 500)).toBe(true);
    expect(isNearBottom(500 - CHAT_STICK_THRESHOLD_PX + 1, 1000, 500)).toBe(true);
  });

  it('is false beyond the stick threshold', () => {
    expect(isNearBottom(500 - CHAT_STICK_THRESHOLD_PX - 1, 1000, 500)).toBe(false);
    expect(isNearBottom(0, 1000, 500)).toBe(false);
  });

  it('treats non-overflowing content as bottom (always stick)', () => {
    expect(isNearBottom(0, 300, 500)).toBe(true);
    expect(isNearBottom(0, 0, 0)).toBe(true);
  });

  it('never unsticks on bottom growth: distance is measured fresh each call', () => {
    // Container 500px tall, content grew to 1400 while the user sat at the
    // old bottom (scrollTop 500): 400px of new content — beyond threshold,
    // so the FOLLOW decision belongs to the stick state, not here.
    expect(isNearBottom(500, 1400, 500)).toBe(false);
  });
});

describe('nextStickToBottom', () => {
  it('resticks whenever the viewport reaches the bottom', () => {
    expect(nextStickToBottom(false, true, false)).toBe(true);
    expect(nextStickToBottom(false, true, true)).toBe(true);
  });

  it('unsticks on an upward scroll away from the bottom', () => {
    expect(nextStickToBottom(true, false, true)).toBe(false);
  });

  it('stays stuck through downward scroll events (including programmatic smooth scrolls)', () => {
    // Mid-animation smooth scroll-to-bottom fires scroll events with a
    // downward delta that are not yet near the bottom; they must not
    // unstick the follow.
    expect(nextStickToBottom(true, false, false)).toBe(true);
  });

  it('stays unstuck while the user scrolls through history (not at bottom)', () => {
    expect(nextStickToBottom(false, false, false)).toBe(false);
    expect(nextStickToBottom(false, false, true)).toBe(false);
  });

  it('reflow clamp at the bottom (content shrink) keeps the stick', () => {
    // Shrinking content clamps scrollTop down; the clamped position is
    // near-bottom, so the stick survives the negative delta.
    expect(nextStickToBottom(true, true, true)).toBe(true);
  });
});
