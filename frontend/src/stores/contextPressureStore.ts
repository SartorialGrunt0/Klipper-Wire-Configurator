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
  /** Whether a probe is in flight (dedupes concurrent ensureWindow calls). */
  probing: boolean;
  /** Derived advisory flag — recomputed on every telemetry change. */
  advisory: boolean;
  recordUsage: (lastPromptTokens: number | null | undefined) => void;
  setWindow: (window: number | null) => void;
  /** Fetch + store the window for `creds`, at most once per key. Never throws. */
  ensureWindow: (creds: ContextWindowCredentials) => Promise<void>;
  reset: () => void;
}

export const useContextPressureStore = create<ContextPressureState>()((set, get) => ({
  lastPromptTokens: null,
  contextWindow: null,
  probedKey: null,
  probing: false,
  advisory: false,

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

  ensureWindow: async (creds) => {
    const key = contextPressureWindowKey(creds);
    const state = get();
    if (state.probedKey === key || state.probing) return;
    set({ probing: true });
    let window: number | null = null;
    try {
      window = await fetchContextWindow(creds);
    } catch {
      window = null;
    }
    // A model/provider switch mid-probe: only the matching probe may claim
    // the cache; a late answer for an old key still sets the window only if
    // nothing newer has arrived.
    set((current) => {
      const resolved = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
      return {
        probing: false,
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
    set({
      lastPromptTokens: null,
      contextWindow: null,
      probedKey: null,
      probing: false,
      advisory: false,
    }),
}));
