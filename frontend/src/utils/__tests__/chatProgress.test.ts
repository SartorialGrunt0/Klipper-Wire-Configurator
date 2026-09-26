import { describe, expect, it } from 'vitest';

import {
  EMPTY_PROGRESS,
  applyProgressSnapshot,
  mergeProgressTools,
  progressCollapseLabel,
} from '../chatProgress';

describe('mergeProgressTools', () => {
  it('unions tool names in first-seen order', () => {
    expect(mergeProgressTools(['read_user_config'], ['search_klipper_docs', 'read_user_config']))
      .toEqual(['read_user_config', 'search_klipper_docs']);
  });

  it('drops empty names', () => {
    expect(mergeProgressTools([], ['', 'config_edit', ''])).toEqual(['config_edit']);
  });

  it('is idempotent across repeated polls of the same batch', () => {
    const once = mergeProgressTools([], ['config_edit']);
    const twice = mergeProgressTools(once, ['config_edit']);
    expect(twice).toEqual(['config_edit']);
  });
});

describe('applyProgressSnapshot', () => {
  it('folds a snapshot into empty state', () => {
    const next = applyProgressSnapshot(EMPTY_PROGRESS, {
      turn: 1, narration: 'Reading printer.cfg.', toolNames: ['read_user_config'], elapsedMs: 1200,
    });
    expect(next).toEqual({
      tools: ['read_user_config'],
      narration: 'Reading printer.cfg.',
      turn: 1,
      elapsedMs: 1200,
    });
  });

  it('accumulates tools across turns and advances the turn high-water mark', () => {
    let d = applyProgressSnapshot(EMPTY_PROGRESS, {
      turn: 1, narration: 'Reading.', toolNames: ['read_user_config'], elapsedMs: 500,
    });
    d = applyProgressSnapshot(d, {
      turn: 2, narration: 'Applying.', toolNames: ['config_edit'], elapsedMs: 1500,
    });
    d = applyProgressSnapshot(d, {
      turn: 2, narration: 'Applying.', toolNames: ['config_edit'], elapsedMs: 2000,
    });
    expect(d.tools).toEqual(['read_user_config', 'config_edit']);
    expect(d.turn).toBe(2);
    expect(d.elapsedMs).toBe(2000);
  });

  it('keeps the previous narration when a poll carries none', () => {
    let d = applyProgressSnapshot(EMPTY_PROGRESS, {
      turn: 1, narration: 'Reading printer.cfg.', toolNames: ['read_user_config'], elapsedMs: 100,
    });
    d = applyProgressSnapshot(d, { turn: 2, narration: '', toolNames: ['config_edit'], elapsedMs: 200 });
    expect(d.narration).toBe('Reading printer.cfg.');
    expect(d.tools).toEqual(['read_user_config', 'config_edit']);
  });

  it('never rewinds the turn on an out-of-order poll', () => {
    let d = applyProgressSnapshot(EMPTY_PROGRESS, {
      turn: 4, narration: 'x', toolNames: [], elapsedMs: 10,
    });
    d = applyProgressSnapshot(d, { turn: 3, narration: 'stale', toolNames: [], elapsedMs: 5 });
    expect(d.turn).toBe(4);
  });
});

describe('progressCollapseLabel', () => {
  it('pluralizes', () => {
    expect(progressCollapseLabel({ ...EMPTY_PROGRESS, tools: ['a'] })).toBe('▸ 1 step');
    expect(progressCollapseLabel({ ...EMPTY_PROGRESS, tools: ['a', 'b'] })).toBe('▸ 2 steps');
    expect(progressCollapseLabel(EMPTY_PROGRESS)).toBe('▸ 0 steps');
  });
});
