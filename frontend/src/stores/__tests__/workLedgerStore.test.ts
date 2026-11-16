/**
 * W6.2 — the work-ledger decision store.
 *
 * kept/undone verdicts are the ONE piece of conversation history that
 * cannot be derived (the review ledger splices silently), so they are
 * appended here at decision time, tagged with the user-message count —
 * the same ordinaling `buildWorkLedger` uses for staging events, so the
 * two sources compare without a send-time bump hook.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useAiStore } from '../aiStore';
import {
  isWorkLedgerDecision,
  useWorkLedgerStore,
  WORK_LEDGER_MAX_EVENTS,
} from '../workLedgerStore';
import type { ChatMessage } from '../aiStore';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

beforeEach(() => {
  useWorkLedgerStore.getState().clear();
  useAiStore.setState({ messages: [] });
});

describe('recordDecision — turn tagging from live conversation state', () => {
  it('tags the current user-message count at decision time', () => {
    useAiStore.setState({ messages: [user('a'), assistant('b'), user('c')] });
    useWorkLedgerStore.getState().recordDecision('printer.cfg', 'led', 'kept');
    expect(useWorkLedgerStore.getState().events).toEqual([
      { file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 2 },
    ]);
  });

  it('appends in order; later-wins resolution is the derivation job', () => {
    useWorkLedgerStore.getState().recordDecision('printer.cfg', 'led', 'kept');
    useWorkLedgerStore.getState().recordDecision('printer.cfg', 'led', 'undone');
    const verdicts = useWorkLedgerStore.getState().events.map((e) => e.verdict);
    expect(verdicts).toEqual(['kept', 'undone']);
  });

  it('memory-bounded: oldest events drop beyond the cap', () => {
    for (let i = 0; i < WORK_LEDGER_MAX_EVENTS + 5; i += 1) {
      useWorkLedgerStore.getState().recordDecision('printer.cfg', `s${i}`, 'kept');
    }
    const events = useWorkLedgerStore.getState().events;
    expect(events).toHaveLength(WORK_LEDGER_MAX_EVENTS);
    // Oldest dropped: the last recorded section is still there.
    expect(events[events.length - 1].section).toBe(`s${WORK_LEDGER_MAX_EVENTS + 4}`);
  });
});

describe('hydrate — restoring a saved conversation', () => {
  it('replaces the events wholesale', () => {
    useWorkLedgerStore.getState().recordDecision('a.cfg', 'x', 'kept');
    useWorkLedgerStore.getState().hydrate([
      { file: 'b.cfg', section: 'y', verdict: 'undone', turnIndex: 3 },
    ]);
    expect(useWorkLedgerStore.getState().events).toEqual([
      { file: 'b.cfg', section: 'y', verdict: 'undone', turnIndex: 3 },
    ]);
  });

  it('filters malformed entries from legacy/untrusted saves', () => {
    useWorkLedgerStore.getState().hydrate([
      { file: 'ok.cfg', section: '', verdict: 'kept', turnIndex: 1 },
      { file: 'bad.cfg', section: 'x', verdict: 'deleted', turnIndex: 1 },
      { file: 'bad2.cfg', verdict: 'kept' },
      { section: 'x', verdict: 'kept', turnIndex: 0 },
      { file: 'bad3.cfg', section: 'x', verdict: 'kept', turnIndex: 'two' },
      null,
      'nope',
    ] as never);
    expect(useWorkLedgerStore.getState().events).toEqual([
      { file: 'ok.cfg', section: '', verdict: 'kept', turnIndex: 1 },
    ]);
  });
});

describe('isWorkLedgerDecision', () => {
  it('accepts a file-level (empty section) event', () => {
    expect(isWorkLedgerDecision({ file: 'f.cfg', section: '', verdict: 'undone', turnIndex: 0 })).toBe(true);
  });
});
