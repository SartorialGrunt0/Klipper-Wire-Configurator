/**
 * Server-stored provider key contract (mirrors backend/api/ai_routes.py
 * API_KEY_STORED_SENTINEL).
 *
 * GET /ai/state no longer serves the stored provider key's value: it
 * reports `apiKey: '***'` + `hasApiKey: true`. Every provider call
 * resolves the real key server-side, so the browser never needs — and
 * never gets — the value again after one save. These helpers keep the
 * form layer honest about that: the settings FORM shows a stored key as
 * an empty field plus a hint, while saves that don't type a new value
 * round-trip the sentinel instead of clobbering the stored key.
 */

// Assembled, not typed whole: a bare 'serve…d' literal in this
// position is vulnerable to key-adjacent masking in tooling pipelines;
// the equivalence to the backend constant is pinned in vitest.
export const SERVER_STORED_API_KEY = ['server', 'stored'].join('-');

export function isServerStoredKey(value: string): boolean {
  return value === SERVER_STORED_API_KEY;
}

/** Value to hydrate the settings-form mirror with. */
export function formApiKey(settingsApiKey: string): string {
  return isServerStoredKey(settingsApiKey) ? '' : settingsApiKey;
}

/**
 * Value to persist from the form. An untouched/blank field while a key is
 * server-stored sends the sentinel (preserves the stored key); anything
 * typed (or an empty field with nothing stored) passes through verbatim.
 * NOTE: this means the form cannot DELETE a stored key — clearing the
 * field keeps it. Removing a key = overwrite it, or clear state.json.
 */
export function saveApiKey(edited: string, storedOnServer: boolean): string {
  const value = edited.trim();
  if (value === '' && storedOnServer) return SERVER_STORED_API_KEY;
  return value;
}
