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
  /** PR #43 review F5: conversation lineage counter (memory-only, never
   *  saved). Bumped whenever the visible trail is BRANCHED or SWITCHED
   *  (edit-resend truncation, hidden analyze send, loading another saved
   *  thread). Decision events carry the epoch they were recorded in; the
   *  builder overlays only same-epoch events, so a verdict from a dead
   *  lineage can never overwrite a fresh staging of the same file+section. */
  epoch: number;
  /** PR #43 review F6: first turn whose decision record is complete for
   *  this page session. Set once at mount from the RESTORED trail: staging
   *  before it may have been decided in a session whose events did not
   *  survive, so pending rows there render 'unknown', not 'awaiting
   *  review'. null = nothing to distrust (fresh chat, or a loaded save
   *  whose decisions came with it). */
  decisionTrustFrom: number | null;
  /** Record one human decision. The turn tag is read live from the
   *  conversation (user-message count), so no send-time bump hook can
   *  drift out of sync. */
  recordDecision: (file: string, section: string, verdict: 'kept' | 'undone') => void;
  /** Start a new decision lineage (branch/switch of the visible trail). */
  bumpEpoch: () => void;
  /** Set/clear the F6 trust boundary (mount restore: current user count;
   *  loaded save / new chat: null). */
  setDecisionTrustFrom: (turn: number | null) => void;
  /** Replace the events when a saved conversation is loaded (malformed
   *  entries dropped). Restored events are stamped with the CURRENT epoch:
   *  they arrive together with their conversation and are trustworthy as
   *  a set; any save-time epoch tag is stale and overwritten here. */
  hydrate: (events: readonly unknown[]) => void;
  /** Forget everything — a new chat. */
  clear: () => void;
}

export const useWorkLedgerStore = create<WorkLedgerState>((set, get) => ({
  events: [],
  epoch: 1,
  decisionTrustFrom: null,

  recordDecision: (file, section, verdict) => {
    const turnIndex = useAiStore.getState().messages
      .filter((m) => m.role === 'user').length;
    const { epoch } = get();
    set({
      events: [...get().events, { file, section, verdict, turnIndex, epoch }]
        .slice(-WORK_LEDGER_MAX_EVENTS),
    });
  },

  bumpEpoch: () => set({ epoch: get().epoch + 1 }),

  setDecisionTrustFrom: (turn) => set({ decisionTrustFrom: turn }),

  hydrate: (events) => {
    const epoch = get().epoch;
    set({
      events: Array.isArray(events)
        ? events.filter(isWorkLedgerDecision).map((e) => ({ ...e, epoch }))
        : [],
    });
  },

  clear: () => set({ events: [], decisionTrustFrom: null }),
}));
