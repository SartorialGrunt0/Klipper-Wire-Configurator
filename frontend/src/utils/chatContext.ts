/**
 * Selection logic for the per-request chat contextFiles seed.
 *
 * The edit session's working state is seeded from contextFiles (the app's
 * live working state, Sir's decision 2026-09-12). With auto-attach off,
 * only files the user checks are sent — which HIDES unsaved drafts from
 * the session, including files the AI itself created and the user approved
 * in an earlier turn (live report 2026-09-25: config_write created
 * prepare_bed_mesh.cfg, approved → dirty draft in the store; next turn's
 * add_include kicked back 'Include file not found' because the draft was
 * in neither the checked files nor the saved-file mirror; the same include
 * added by hand validated clean, since editor validation runs against the
 * full store).
 *
 * Fix shape: send the *unsaved delta* — files whose current text differs
 * from the saved baseline (originalTexts) or that have no baseline at all
 * (never saved). Files identical to disk stay out; the payload stays lean
 * and the validation strictness is untouched (an include pointing at a
 * truly nonexistent file still kicks back).
 */

const normalizeNewlines = (s: string): string => s.replace(/\r\n?/g, '\n');

/** Total-content cap for the unsaved-delta addition (bytes), mirroring the
 *  backend mirror-seed caps: the delta is small by nature; the cap is a
 *  guard against a pathological session, not a normal-path limit. */
export const UNSAVED_DELTA_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Pick the unsaved-delta files to append to a contextFiles payload.
 *
 * @param configFiles  current store files (keyed by filename)
 * @param originalTexts saved baseline per file (absent = never saved)
 * @param texts        current exported text per filename (only entries for
 *                     configFiles are consulted)
 * @param existingKeys keys already present in the payload (never duplicated)
 * @returns filenames to include, in configFiles order, capped by total bytes
 */
export function selectUnsavedDrafts(
  configFiles: Record<string, unknown>,
  originalTexts: Record<string, string>,
  texts: Record<string, string>,
  existingKeys: ReadonlySet<string>,
  maxTotalBytes: number = UNSAVED_DELTA_MAX_TOTAL_BYTES,
): string[] {
  const picked: string[] = [];
  let total = 0;
  for (const filename of Object.keys(configFiles)) {
    if (existingKeys.has(filename)) continue;
    const text = texts[filename];
    if (text == null) continue;
    const baseline = originalTexts[filename];
    if (baseline !== undefined && normalizeNewlines(baseline) === normalizeNewlines(text)) {
      continue; // matches the saved state — the mirror already carries it
    }
    const size = new TextEncoder().encode(text).length;
    if (total + size > maxTotalBytes) break; // store order is stable; stop adding
    total += size;
    picked.push(filename);
  }
  return picked;
}
