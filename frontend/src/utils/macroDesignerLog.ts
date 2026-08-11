/**
 * Macro Designer trace logging.
 *
 * Posts structured events to the backend `/api/log/macro-designer`
 * endpoint, which appends them as timestamped JSON lines to
 * `backend/macro_designer.log` — a durable, grep-able trace that
 * survives browser reloads and can be read/tailed without asking the
 * user to copy anything (companion to ai_chat.log).
 *
 * Design constraints:
 * - Import-safe in node (vitest runs in `environment: 'node'`): never
 *   touches `window`/`fetch` at module load, and no-ops outside a
 *   browser so pure util tests don't need mocks.
 * - Fire-and-forget: batching + silent failure, logging must never
 *   throw or block the caller.
 */
type MacroDesignerLogEvent = Record<string, unknown>;

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '/api';
const LOG_URL = `${API_BASE}/log/macro-designer`;
const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH = 50;

let pending: MacroDesignerLogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function';
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) {
    return;
  }
  const batch = pending;
  pending = [];
  try {
    void fetch(LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {
      // Backend absent/offline — drop silently; logging never blocks.
    });
  } catch {
    // Never throw from logging.
  }
}

/** Record a macro-designer event (browser only; no-op elsewhere). */
export function logMacroDesignerEvent(event: MacroDesignerLogEvent): void {
  if (!isBrowser()) {
    return;
  }
  if (import.meta.env.DEV) {
    // Live mirror in DevTools while working.
    console.debug('[MacroDesigner]', event);
  }
  pending.push({ ts: new Date().toISOString(), ...event });
  if (pending.length >= MAX_BATCH) {
    flush();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

/** Flush any buffered events immediately (e.g. before dialog close). */
export function flushMacroDesignerLog(): void {
  if (isBrowser()) {
    flush();
  }
}
