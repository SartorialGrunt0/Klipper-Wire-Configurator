/**
 * The staged-edit apply path, shared by stage and the review engine.
 *
 * What is LEFT of the old decision engine after the mechanical ledger took
 * over the decisions (Sir, 2026-10-07). The keep/undo verbs and the server
 * `resolve` replay are gone — `services/reviewEngine` owns them now, as
 * splices on the frame/live texts with no server involvement. This module
 * keeps only the two things the ledger still needs:
 *
 *  - `applyStagedEdits`: write backend-produced file texts through the ONE
 *    apply path, so stage / undo cannot drift. (The engine reuses it for a
 *    decision on a file the text view is not holding.)
 *  - `buildDecisionContext`: the client's current text per file, for the
 *    approval-card decision POST (a different, still server-side flow).
 *
 * No React: this is the shared floor under the chat and the text view.
 */
import * as api from './api';
import type { PendingConfigEdit } from './api';
import { useChangeSetStore } from '../stores/changeSetStore';
import { useConfigStore } from '../stores/configStore';
import { usePendingEditStore } from '../stores/pendingEditStore';
import { planApprovedEditApply } from '../utils/approvalApply';

/**
 * Apply backend-produced file texts to the editor draft.
 *
 * The texts are server truth (the backend's own writer), so a failure here is
 * a bug worth surfacing rather than a silent drop. Returns the files that
 * could not be applied, for the caller to report in its own surface.
 */
export async function applyStagedEdits(edits: PendingConfigEdit[]): Promise<string[]> {
  const { upserts, deletes } = planApprovedEditApply(edits);
  if (upserts.length === 0 && deletes.length === 0) return [];
  const failed: string[] = [];
  for (const { file, newText } of upserts) {
    try {
      const parsed = await api.parseConfigText(newText, file);
      // updateConfigFile (NOT setConfigFile + single-file validateConfig): the
      // store's debounced revalidation validates the WHOLE project, so
      // include-graph-aware findings (gcode registry macros defined in
      // included files, cross-file dups/pins) re-derive correctly. A
      // single-file result written here flags every included-file macro as
      // unknown_gcode_command (live report 2026-09-20: CLEAN_NOZZLE,
      // AUX_FAN_ON/OFF from clean.cfg / aux_fan.cfg).
      useConfigStore.getState().updateConfigFile(file, { ...parsed.config, raw_text: newText });
    } catch (err: unknown) {
      console.error('[ChangeSet] Failed to apply edit to', file, err);
      failed.push(file);
    }
  }
  deletes.forEach((file) => useConfigStore.getState().removeConfigFile(file));
  if (upserts.length > 0 || deletes.length > 0) useConfigStore.getState().markDirty();
  if (deletes.length > 0) {
    // Deletion alone schedules nothing (removeConfigFile only drops the file's
    // own entry) — re-derive the OTHER files' findings (e.g. a dangling
    // include) against the surviving project now.
    void useConfigStore.getState().revalidateAll();
  }
  return failed;
}

/**
 * The client's current working text per file.
 *
 * This is the evidence behind the server's "the human edited this file, their
 * text wins" rule for the approval-card decision POST — so it is every loaded
 * file, not a subset someone remembered to send. Without it a decision could
 * clobber a hand edit.
 */
export async function buildDecisionContext(): Promise<Record<string, { content: string; label: string }>> {
  const store = useConfigStore.getState();
  const ctx: Record<string, { content: string; label: string }> = {};
  for (const filename of Object.keys(store.configFiles)) {
    const config = store.configFiles[filename];
    if (!config) continue;
    const content = await api.exportConfig(config);
    if (content == null) continue;
    ctx[filename] = {
      content,
      label: filename === store.activeFile
        ? 'Active Klipper config draft'
        : 'Loaded Klipper config file',
    };
  }
  return ctx;
}

// ── Discarding the buffer discards the review ────────────────────────

/**
 * A wholesale replacement of the working buffer takes the review with it.
 *
 * A review is `diff(FRAME, LIVE)`, and the frame belongs to a file state that
 * no longer exists the moment the buffer is thrown away. Left standing, a
 * keep/undo would splice a decided run against a frame from a document the
 * user already discarded. So every path that replaces the buffer — Revert
 * (both branches), a re-read from the Pi with "clear existing", a fresh
 * generate — calls this first.
 */
export function discardReview(): void {
  useChangeSetStore.getState().clear();
  usePendingEditStore.getState().clearPending();
}
