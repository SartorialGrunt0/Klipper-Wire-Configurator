/**
 * W7 — context-pressure advisory state.
 *
 * Transient telemetry for the CURRENT provider+model pairing: the prompt
 * size of the latest provider request (from the /ai/chat usage block) and
 * the model's REAL context window (probed once per key via
 * /ai/context-window). The label itself is decided by the pure rule in
 * utils/contextPressure; nothing here guesses when data is missing.
 *
 * Deliberately NOT persisted: pressure belongs to the live conversation —
 * a reloaded page starts a fresh measurement, and `reset` clears it when
 * the chat is cleared.
 */
import { create } from 'zustand';
import { fetchContextWindow, type ContextWindowCredentials } from '../services/api';
import { evaluateContextPressure } from '../utils/contextPressure';
import { CONTEXT_OVERFLOW_BANNER_FALLBACK } from '../utils/contextOverflow';

/** Probe cache key: the endpoint + model decide the window; credentials don't. */
export function contextPressureWindowKey(creds: ContextWindowCredentials): string {
  return `${creds.apiUrl}::${creds.model}`;
}

interface ContextPressureState {
  /** Prompt tokens of the latest provider request (usage.lastPromptTokens). */
  lastPromptTokens: number | null;
  /** The provider's real context window for the current model, if probed. */
  contextWindow: number | null;
  /** Key whose probe last settled (a null result is cached too — no retry storm). */
  probedKey: string | null;
  /** Key whose probe is IN FLIGHT (C-01: dedupes probes AND fences a
   *  late answer — only the probe whose key still owns pendingKey may
   *  claim the cache). */
  pendingKey: string | null;
  /**
   * Conversation generation, bumped by reset() (C-01). Every async write
   * captures it before its await and drops the write when it moved — a
   * probe or usage report from before a new/loaded chat must never
   * re-populate the cleared state (the old post-await set was
   * unconditional while its comment promised exactly this fence).
   */
  epoch: number;
  /** Whether a probe is in flight (dedupes concurrent ensureWindow calls). */
  probing: boolean;
  /** Derived advisory flag — recomputed on every telemetry change. */
  advisory: boolean;
  /**
   * W8: the overflow banner's message, set when a send lands on the
   * backend's structured context_overflow error (pre-flight or mapped
   * provider failure). Null = no banner. Independent of `advisory` —
   * overflow is an event outcome, not a rolling measurement, so a later
   * quiet reply must not clear it; only `reset` (new/loaded chat) does.
   */
  overflowMessage: string | null;
  recordUsage: (lastPromptTokens: number | null | undefined) => void;
  setWindow: (window: number | null) => void;
  /** Raise the overflow banner. Empty/absent message falls back to the
   *  canonical label (utils/contextOverflow) — the banner is never blank. */
  recordOverflow: (message?: string | null) => void;
  /** Fetch + store the window for `creds`, at most once per key. Never throws. */
  ensureWindow: (creds: ContextWindowCredentials) => Promise<void>;
  reset: () => void;
}

export const useContextPressureStore = create<ContextPressureState>()((set, get) => ({
  lastPromptTokens: null,
  contextWindow: null,
  probedKey: null,
  pendingKey: null,
  epoch: 0,
  probing: false,
  advisory: false,
  overflowMessage: null,

  recordUsage: (lastPromptTokens) =>
    set((state) => {
      const tokens = typeof lastPromptTokens === 'number' && Number.isFinite(lastPromptTokens)
        ? lastPromptTokens
        : null;
      return {
        lastPromptTokens: tokens,
        advisory: evaluateContextPressure({
          lastPromptTokens: tokens,
          contextWindow: state.contextWindow,
        }).advisory,
      };
    }),

  setWindow: (window) =>
    set((state) => {
      const resolved = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
      return {
        contextWindow: resolved,
        advisory: evaluateContextPressure({
          lastPromptTokens: state.lastPromptTokens,
          contextWindow: resolved,
        }).advisory,
      };
    }),

  recordOverflow: (message) =>
    set({
      overflowMessage:
        typeof message === 'string' && message.trim() ? message : CONTEXT_OVERFLOW_BANNER_FALLBACK,
    }),

  ensureWindow: async (creds) => {
    const key = contextPressureWindowKey(creds);
    const state = get();
    if (state.probedKey === key || state.pendingKey !== null) return;
    const epoch = state.epoch;
    set({ probing: true, pendingKey: key });
    let window: number | null = null;
    try {
      window = await fetchContextWindow(creds);
    } catch {
      window = null;
    }
    // C-01 (PR #43): the fence the old comment promised but never
    // implemented. This answer may claim the cache only while its probe
    // still owns pendingKey AND the conversation generation is unchanged;
    // a late answer after reset() (new/loaded chat) or after a newer
    // probe took over is dropped, so a stale model's window can no
    // longer overwrite the current one or re-populate cleared state.
    set((current) => {
      if (current.epoch !== epoch || current.pendingKey !== key) return {};
      const resolved = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
      return {
        probing: false,
        pendingKey: null,
        probedKey: key,
        contextWindow: resolved,
        advisory: evaluateContextPressure({
          lastPromptTokens: current.lastPromptTokens,
          contextWindow: resolved,
        }).advisory,
      };
    });
  },

  reset: () =>
    set((state) => ({
      // C-01: bumping the generation fences out every in-flight probe /
      // usage report from the previous conversation; they land against
      // a moved epoch and write nothing.
      epoch: state.epoch + 1,
      lastPromptTokens: null,
      contextWindow: null,
      probedKey: null,
      pendingKey: null,
      probing: false,
      advisory: false,
      overflowMessage: null,
    })),
}));
