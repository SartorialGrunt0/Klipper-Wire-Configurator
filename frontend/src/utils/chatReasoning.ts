/**
 * Reasoning-effort option model (pure logic, unit-tested).
 *
 * The setting value is a plain string:
 *   'default'  -> the request sends NOTHING (omitted field = model default
 *                 on every OpenAI-compatible server; a literal 'default'
 *                 token is not a valid level anywhere).
 *   any other  -> forwarded verbatim as top-level `reasoning_effort`.
 *
 * Which levels are OFFERABLE comes from the /ai/reasoning-levels probe
 * (see backend route docstring for the contract):
 *   source === 'props' -> authoritative. The server told us exactly what
 *       it accepts. [] means "this model has no configurable effort" —
 *       the panel must show Default ALONE, never an assumed ladder
 *       (that's the gemma-4-12b case: a real server, a real empty answer).
 *   source === null    -> nothing advertised (vLLM cards, older llama.cpp
 *       builds, unreachable /props). The panel may offer the conservative
 *       assumed ladder, clearly labelled — the industry pattern (every
 *       serious tool ships a static table for undisclosed models).
 */

export const REASONING_DEFAULT = 'default';

/** Levels accepted by essentially every reasoning-capable endpoint. */
export const ASSUMED_REASONING_LEVELS = ['low', 'medium', 'high'];

export interface ReasoningProbe {
  levels: string[];
  source: 'props' | null;
  error?: string | null;
}

export const EMPTY_REASONING_PROBE: ReasoningProbe = { levels: [], source: null };

/** The setting is only wired for the OpenAI-compatible provider (scope 2026-11-21). */
export function reasoningSettingApplies(apiProvider: string): boolean {
  return apiProvider === 'openai-compatible';
}

/**
 * Ordered option list: 'default' first, then the advertised levels (props
 * order is already lowest->highest), else the assumed ladder. A saved value
 * the current probe does not list is APPENDED (labelled stale by the panel)
 * rather than silently rewritten — dropping-on-incompatible applies to what
 * gets SENT (the backend's reject-retry is the wire-side guard); the form
 * must still show the user what is currently saved.
 */
export function reasoningEffortOptions(
  probe: ReasoningProbe,
  savedValue: string,
): string[] {
  const base =
    probe.source === 'props'
      ? [...probe.levels]
      : [...ASSUMED_REASONING_LEVELS];
  const saved = (savedValue || REASONING_DEFAULT).trim();
  if (saved !== REASONING_DEFAULT && !base.includes(saved)) {
    base.push(saved);
  }
  return [REASONING_DEFAULT, ...base];
}

/** True when a saved level is not in what the endpoint advertised (props only). */
export function isStaleEffort(probe: ReasoningProbe, savedValue: string): boolean {
  const saved = (savedValue || REASONING_DEFAULT).trim();
  if (probe.source !== 'props' || saved === REASONING_DEFAULT) return false;
  return !probe.levels.includes(saved);
}

/** Human hint under the select. */
export function reasoningEffortHint(probe: ReasoningProbe, selected: string): string {
  const sel = (selected || REASONING_DEFAULT).trim();
  if (probe.source === 'props') {
    if (probe.levels.length === 0) {
      return 'This endpoint reports no configurable reasoning levels.';
    }
    if (isStaleEffort(probe, sel)) {
      return `"${sel}" is not on this endpoint's advertised list.`;
    }
    return 'Levels discovered from the endpoint.';
  }
  return 'Endpoint reports no reasoning metadata — levels shown are assumed (only low/medium/high are universal).';
}

// NOTE on the send path: the panel's probe drives the FORM only. At send
// time the value rides whatever the store holds; the wire-side guard is
// server-side (ai_routes._query_provider) — after one documented rejection
// for a (url, model) it omits the field proactively for the rest of the
// server's life. That placement is deliberate: the request builder reads
// committed store truth only (chatRequestBase law), and the probe result
// belongs to the settings form, not to it.
