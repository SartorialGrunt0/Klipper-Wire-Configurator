/**
 * Graph sync for MODEL-level writes (Sir, 2026-10-11).
 *
 * `syncGraphWithConfig` used to have exactly one caller — the text editor's
 * debounced live-parse, on the real-user-edit branch. An AI edit writes the
 * model through `applyStagedEdits`, and the editor's re-parse of that text is
 * an echo that returns before the sync line — so a staged section (e.g.
 * `[gcode_arcs]`) had no card until an unrelated hand edit or full rebuild
 * rescued it. This module is the missing trigger: after any write that goes
 * straight to the config model, sync the graph here.
 *
 * Two branches:
 *  - The file already owns a hardware node → incremental per-file sync
 *    (adds new cards, removes gone ones, updates suppression — battle-tested
 *    from the text editor path, and idempotent).
 *  - No hardware node for the file (a review-CREATED file, or a staged edit
 *    that introduced a whole new board file) → a per-file sync has nowhere to
 *    parent new cards, so take the full-rebuild idiom: clearGraph +
 *    buildProjectGraph + restore the saved layout (mirrors Import/Revert/
 *    reference-add).
 */
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import { useNativeStore } from '../stores/nativeStore';
import { buildProjectGraph } from '../utils/graphBuilder';
import { restoreLayoutAfterRebuild } from '../utils/layoutPersistence';

/**
 * Full rebuild from the CURRENT config store, then re-apply the saved layout
 * so the user's arrangement survives the renumbered node ids. An empty store
 * means an empty canvas.
 */
export function rebuildProjectGraph(): Promise<void> {
  const configStore = useConfigStore.getState();
  const graphStore = useGraphStore.getState();
  if (Object.keys(configStore.configFiles).length === 0) {
    graphStore.clearGraph();
    return Promise.resolve();
  }
  // buildProjectGraph is ADDITIVE — clear first or every node duplicates.
  graphStore.clearGraph();
  buildProjectGraph(configStore.configFiles, graphStore, configStore.schemas, configStore.validation);
  // Pass the STATE GETTER, not a snapshot: the nodes must be the rebuilt ones
  // (see restoreLayoutAfterRebuild's contract in utils/layoutPersistence).
  return restoreLayoutAfterRebuild(useGraphStore.getState, useNativeStore.getState().isNative);
}

/** True when some hardware node represents `file` (exact or basename —
 *  webkitdirectory imports carry path prefixes; mirrors the fallback inside
 *  syncGraphWithConfig). */
function hasHardwareNodeFor(file: string): boolean {
  const bn = file.replace(/^.*[\\/]/, '');
  return useGraphStore.getState().nodes.some((n) => {
    if (n.type !== 'hardware') return false;
    const nodeFile = ((n.data as Record<string, unknown>).configFile as string) || '';
    return nodeFile === file || nodeFile.replace(/^.*[\\/]/, '') === bn;
  });
}

/**
 * Bring the graph in line with the model for one file the caller just wrote.
 * Await it: the incremental branch is synchronous, the rebuild branch awaits
 * only the saved-layout load.
 */
export async function syncGraphForFile(file: string): Promise<void> {
  const exists = file in useConfigStore.getState().configFiles;
  if (exists && hasHardwareNodeFor(file)) {
    useGraphStore.getState().syncGraphWithConfig(file);
    return;
  }
  // Either the file is GONE (its cards now dangle in the graph — a per-file
  // sync can only manage a file's own model) or it is NEW (no parent hardware
  // node exists yet). Both need the whole project re-derived.
  await rebuildProjectGraph();
}

/**
 * The batch form for an apply path that wrote several files at once.
 * A deleted file forces the rebuild (its orphaned cards live under other
 * files' nodes too); pure upserts sync each file on its own.
 */
export async function syncGraphAfterModelWrite(
  updatedFiles: readonly string[],
  deletedFiles: readonly string[],
): Promise<void> {
  if (deletedFiles.length > 0) {
    await rebuildProjectGraph();
    return;
  }
  for (const file of updatedFiles) await syncGraphForFile(file);
}
