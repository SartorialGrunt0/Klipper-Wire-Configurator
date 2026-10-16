import { describe, it, expect } from 'vitest';
import {
  autoScrollDelta,
  DEFAULT_EDGE_ZONE_PX,
  DEFAULT_MAX_STEP_PX,
} from '../editorAutoScroll';

const TOP = 100;
const BOTTOM = 500; // 400px viewport, 48px edge zones

describe('autoScrollDelta', () => {
  it('does not scroll in the middle of the viewport', () => {
    expect(autoScrollDelta(300, TOP, BOTTOM)).toBe(0);
    expect(autoScrollDelta(TOP + 48, TOP, BOTTOM)).toBe(0);
    expect(autoScrollDelta(BOTTOM - 48, TOP, BOTTOM)).toBe(0);
  });

  it('scrolls up inside the top edge zone', () => {
    expect(autoScrollDelta(TOP + 1, TOP, BOTTOM)).toBeLessThan(0);
  });

  it('scrolls down inside the bottom edge zone', () => {
    expect(autoScrollDelta(BOTTOM - 1, TOP, BOTTOM)).toBeGreaterThan(0);
  });

  it('ramps up towards the edge', () => {
    const near = Math.abs(autoScrollDelta(TOP + 40, TOP, BOTTOM));
    const closer = Math.abs(autoScrollDelta(TOP + 20, TOP, BOTTOM));
    const edge = Math.abs(autoScrollDelta(TOP, TOP, BOTTOM));
    expect(near).toBeLessThan(closer);
    expect(closer).toBeLessThan(edge);
  });

  it('saturates at maxStep once the pointer is past the edge', () => {
    expect(autoScrollDelta(TOP - 1, TOP, BOTTOM)).toBe(-DEFAULT_MAX_STEP_PX);
    expect(autoScrollDelta(TOP - 5000, TOP, BOTTOM)).toBe(-DEFAULT_MAX_STEP_PX);
    expect(autoScrollDelta(BOTTOM + 5000, TOP, BOTTOM)).toBe(DEFAULT_MAX_STEP_PX);
  });

  it('reaches full speed at the viewport edge', () => {
    expect(autoScrollDelta(TOP, TOP, BOTTOM)).toBe(-DEFAULT_MAX_STEP_PX);
    expect(autoScrollDelta(BOTTOM, TOP, BOTTOM)).toBe(DEFAULT_MAX_STEP_PX);
  });

  it('moves on the first pixel of overlap instead of stalling', () => {
    expect(autoScrollDelta(TOP + 47.9, TOP, BOTTOM)).toBe(-1);
    expect(autoScrollDelta(BOTTOM - 47.9, TOP, BOTTOM)).toBe(1);
  });

  it('is continuous at the zone boundary', () => {
    expect(autoScrollDelta(TOP + 48.01, TOP, BOTTOM)).toBe(0);
    expect(autoScrollDelta(BOTTOM - 48.01, TOP, BOTTOM)).toBe(0);
    // eslint-disable-next-line no-loss-of-precision
    expect(autoScrollDelta(TOP + 48 - 1e-9, TOP, BOTTOM)).toBe(-1);
  });

  it('caps the zone at half the viewport, so a short editor still has a dead centre', () => {
    const shortBottom = TOP + 40; // smaller than 2 × 48
    expect(autoScrollDelta(TOP + 20, TOP, shortBottom)).toBe(0);
    expect(autoScrollDelta(TOP, TOP, shortBottom)).toBe(-DEFAULT_MAX_STEP_PX);
    expect(autoScrollDelta(shortBottom, TOP, shortBottom)).toBe(DEFAULT_MAX_STEP_PX);
  });

  it('honours custom zone / step sizes', () => {
    expect(autoScrollDelta(TOP + 5, TOP, BOTTOM, 100, 4)).toBe(-4);
    expect(autoScrollDelta(TOP + 50, TOP, BOTTOM, 100, 4)).toBeLessThan(0);
    expect(autoScrollDelta(TOP + 100, TOP, BOTTOM, 100, 4)).toBe(0);
  });

  it('never scrolls for a degenerate viewport or a non-finite pointer', () => {
    expect(autoScrollDelta(300, TOP, TOP)).toBe(0);
    expect(autoScrollDelta(300, TOP, TOP - 10)).toBe(0);
    expect(autoScrollDelta(Number.NaN, TOP, BOTTOM)).toBe(0);
  });

  it('is symmetric around the middle of a tall viewport', () => {
    const up = autoScrollDelta(TOP + 10, TOP, BOTTOM);
    const down = autoScrollDelta(BOTTOM - 10, TOP, BOTTOM);
    expect(up).toBe(-down);
  });

  it('keeps the default zone a sane fraction of a typical editor', () => {
    expect(DEFAULT_EDGE_ZONE_PX).toBe(48);
    expect(DEFAULT_MAX_STEP_PX).toBe(16);
  });
});
