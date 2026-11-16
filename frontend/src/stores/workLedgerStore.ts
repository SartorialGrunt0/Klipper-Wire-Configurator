/**
 * The conversation work-ledger decision store (W6).
 *
 * kept/undone verdicts are the ONE piece of conversation history that
 * cannot be derived after the fact: the review ledger is diff(FRAME,
 * LIVE) and a decision is a silent splice. So the four reviewEngine
 * decision sites append here the moment the human decides, tagged with
 * the user-message count — the same ordinaling the staging events use —
 * and `buildWorkLedger` overlays them onto the trace-derived rows.
 *
 * The backend never sees this store directly: rows are derived per send
 * and re-delivered verbatim as the trailing ledger message. The store
 * travels with the conversation ONLY through the saved-conversation
 * record (`SavedConversation.workLedger`); it is deliberately not
 * persisted on its own, so a new chat can never inherit stale verdicts.
 */
import { create } from 'zustand';

import type { WorkLedgerDecision } from '../utils/chatWorkLedger';
import { useAiStore } from './aiStore';

export type { WorkLedgerDecision };

/** Memory bound only — the DERIVATION cap (turns) is what the model
 *  sees; this cap just stops a marathon session growing the array. */
export const WORK_LEDGER_MAX_EVENTS = 200;

/** Loose validation for events restored from a saved conversation
 *  (untrusted JSON: legacy saves lack the field, malformed entries are
 *  dropped, never repaired). */
export function isWorkLedgerDecision(value: unknown): value is WorkLedgerDecision {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<WorkLedgerDecision>;
  return (
    typeof event.file === 'string' && event.file !== ''
    && typeof event.section === 'string'
    && (event.verdict === 'kept' || event.verdict === 'undone')
    && typeof event.turnIndex === 'number' && Number.isFinite(event.turnIndex)
  );
}

export interface WorkLedgerState {
  events: WorkLedgerDecision[];
  /** Record one human decision. The turn tag is read live from the
   *  conversation (user-message count), so no send-time bump hook can
   *  drift out of sync. */
  recordDecision: (file: string, section: string, verdict: 'kept' | 'undone') => void;
  /** Replace the events when a saved conversation is loaded (malformed
   *  entries dropped). */
  hydrate: (events: readonly unknown[]) => void;
  /** Forget everything — a new chat. */
  clear: () => void;
}

export const useWorkLedgerStore = create<WorkLedgerState>((set, get) => ({
  events: [],

  recordDecision: (file, section, verdict) => {
    const turnIndex = useAiStore.getState().messages
      .filter((m) => m.role === 'user').length;
    set({
      events: [...get().events, { file, section, verdict, turnIndex }]
        .slice(-WORK_LEDGER_MAX_EVENTS),
    });
  },

  hydrate: (events) => set({
    events: Array.isArray(events) ? events.filter(isWorkLedgerDecision) : [],
  }),

  clear: () => set({ events: [] }),
}));
