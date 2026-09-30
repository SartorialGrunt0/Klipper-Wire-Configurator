/**
 * Mid-loop chat progress (Phase 6.5.4) — pure display-state logic.
 *
 * The backend publishes the extracted-but-not-yet-executed tool batch to
 * GET /ai/chat/progress while a request is in flight. The poller feeds
 * successive snapshots here; this module keeps the display accumulation
 * (deduped tool checklist + latest narration) free of component state.
 *
 * Hermes invariants carried: display-only — progress text NEVER counts as
 * the answer (response-loss class #65919); identical consecutive narration
 * never re-appends.
 */

export interface ProgressSnapshot {
  turn: number;
  narration: string;
  toolNames: string[];
  elapsedMs: number;
}

export interface ProgressDisplay {
  /** Tool names accumulated across turns, execution order, deduped. */
  tools: string[];
  /** Latest non-empty narration (model's own words for the current step). */
  narration: string;
  /** Highest turn number seen. */
  turn: number;
  /** Last reported elapsed time (backend clock). */
  elapsedMs: number;
}

export const EMPTY_PROGRESS: ProgressDisplay = {
  tools: [],
  narration: '',
  turn: 0,
  elapsedMs: 0,
};

/** Ordered-union merge of tool names across poll snapshots (dedupe). */
export function mergeProgressTools(prev: readonly string[], next: readonly string[]): string[] {
  const seen = new Set(prev);
  const merged = [...prev];
  for (const name of next) {
    if (name && !seen.has(name)) {
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

/** Fold one poll snapshot into the display state.
 *  Empty narration keeps the previous narration (never blanks the strip);
 *  identical consecutive narration is not treated as a new step. */
export function applyProgressSnapshot(
  prev: ProgressDisplay,
  snap: ProgressSnapshot,
): ProgressDisplay {
  return {
    tools: mergeProgressTools(prev.tools, snap.toolNames ?? []),
    narration: snap.narration || prev.narration,
    turn: Math.max(prev.turn, snap.turn),
    elapsedMs: snap.elapsedMs,
  };
}

/** Compact collapse label shown while the strip is folded ("▸ 4 steps").
 *  Counts executed/announced tool calls, which is what the user scanned. */
export function progressCollapseLabel(d: ProgressDisplay): string {
  return `▸ ${d.tools.length} step${d.tools.length === 1 ? '' : 's'}`;
}
