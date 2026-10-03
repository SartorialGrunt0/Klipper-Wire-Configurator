/**
 * The ONE post-hoc decision engine.
 *
 * A change is kept or undone from two places — the chat's footer bar and the
 * text view's pending pane — and they must never be two implementations of
 * the same decision. Both call the functions here; what a surface *renders*
 * (`busy`, `note`) also lives in `changeSetStore`, so the two cannot disagree
 * about the state of the review either.
 *
 * The laws this file exists to keep:
 *
 *  1. **Keep changes no text.** The edit is already applied; keeping ends the
 *     decision. It does still refresh the pane's FRAME (the marks are defined
 *     by the decided set), so both verbs make the same call.
 *  2. **Undo is `replay(kept ops)`**, never a text revert here — reverting in
 *     the client would leave the residue of a dropped op behind. The server
 *     replays each request's kept ops onto the state the previous one left.
 *  3. **One mutation surface.** Text the server returns goes through the same
 *     apply path staged edits use, so stage / keep / undo cannot drift.
 *
 * No React: the docked panel and the text view are different trees (which is
 * why `pendingEditStore` exists), and this is the shared floor under both.
 */
import * as api from './api';
import type { PendingConfigEdit } from './api';
import { useChangeSetStore } from '../stores/changeSetStore';
import { useConfigStore } from '../stores/configStore';
import { planApprovedEditApply } from '../utils/approvalApply';

/** The one line both surfaces show when a set cannot be replayed. */
const GONE_NOTE = 'This change set is no longer available — the changes in the editor stand as they are.';

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
 * text wins" rule — so it is every loaded file, not a subset someone
 * remembered to send. Without it a replay could clobber a hand edit.
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

/**
 * Replay the current decisions and apply the result.
 *
 * Every terminal path reports through the store's `note` (stale ops, a
 * vanished set, a failed apply) so whichever surface the user is looking at
 * says the same thing.
 */
export async function resolveChangeSet(): Promise<void> {
  const store = useChangeSetStore.getState();
  const segments = store.resolveSegments();
  if (segments.length === 0) return;
  useChangeSetStore.setState({ busy: true, note: null });
  try {
    const contextFiles = await buildDecisionContext();
    const out = await api.resolveChangeSet({ segments, contextFiles });
    if (out.status !== 'ok' || !out.files) {
      useChangeSetStore.setState({ note: GONE_NOTE });
      return;
    }
    // The pane's frame follows the decisions (design B): the backend replays
    // the DECIDED-kept ops into it, so a kept edit stops being marked while
    // an undecided one stays. An empty map means nothing has been decided —
    // the pane then uses the file's pre-review text from the change set.
    useChangeSetStore.setState({ frames: out.frames ?? {} });
    const resolved: PendingConfigEdit[] = Object.entries(out.files).map(([file, entry]) => ({
      file,
      op: entry.deleted ? 'delete_file' : 'update',
      summary: '',
      newText: entry.content,
    }));
    const failed = await applyStagedEdits(resolved);
    // A rejected change set leaves the text exactly as it was on disk; the
    // dirty flag must say so rather than flag a project for saving nothing.
    useConfigStore.getState().markCleanIfMatchesDisk();
    if (failed.length > 0) {
      useChangeSetStore.setState({
        note: `${failed.join(', ')} could not be updated in the editor — check the file before saving.`,
      });
    } else if (out.stale && out.stale.length > 0) {
      useChangeSetStore.setState({
        note: `${out.stale.length} change(s) could not be re-applied: `
          + out.stale.map((entry) => entry.reason).join('; '),
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'resolve failed';
    useChangeSetStore.setState({ note: `Could not resolve the change set: ${message}` });
  } finally {
    useChangeSetStore.setState({ busy: false });
  }
}

// ── The decisions themselves ─────────────────────────────────────────
// Keep changes no text, but it DOES change the pane's frame: the marks are
// defined by the DECIDED set (design B), so a keep replays too. Both verbs
// therefore go through the same call — one path, one status, one note.
//
// `keepEdits`/`undoEdits` decide an EXPLICIT set of ids: that is the text
// view's per-change decision (one stop in the diff). The file- and
// section-level entry points below are the chat's summary bar.

export async function keepAll(): Promise<void> {
  useChangeSetStore.setState({ note: null });
  useChangeSetStore.getState().keepAll();
  await resolveChangeSet();
}

export async function undoAll(): Promise<void> {
  useChangeSetStore.getState().undoAll();
  await resolveChangeSet();
}

export async function keepEdits(file: string, ids: string[]): Promise<void> {
  useChangeSetStore.setState({ note: null });
  useChangeSetStore.getState().keepFile(file, ids);
  await resolveChangeSet();
}

export async function undoEdits(file: string, ids: string[]): Promise<void> {
  useChangeSetStore.getState().undoFile(file, ids);
  await resolveChangeSet();
}

export async function keepSection(file: string, section: string, ids: string[]): Promise<void> {
  useChangeSetStore.setState({ note: null });
  useChangeSetStore.getState().keepSection(file, section, ids);
  await resolveChangeSet();
}

export async function undoSection(file: string, section: string, ids: string[]): Promise<void> {
  useChangeSetStore.getState().undoSection(file, section, ids);
  await resolveChangeSet();
}

export async function keepFile(file: string, ids: string[]): Promise<void> {
  useChangeSetStore.setState({ note: null });
  useChangeSetStore.getState().keepFile(file, ids);
  await resolveChangeSet();
}

export async function undoFile(file: string, ids: string[]): Promise<void> {
  useChangeSetStore.getState().undoFile(file, ids);
  await resolveChangeSet();
}
