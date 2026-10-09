/**
 * The post-hoc review, re-homed on the mechanical ledger (Sir, 2026-10-07).
 *
 * This module is the ONE place the frontend reads the ledger and the ONE place
 * a keep/undo is applied. Both review surfaces — the chat's footer bar and the
 * text view — call these verbs, so there is no second implementation to drift.
 *
 * The law: `review(file) = diff(FRAME, LIVE)`. The FRAME is the one per file
 * the change-set payload seeded (null = the review CREATED the file); LIVE is
 * the editor's current text (`configStore.liveTexts` beats `raw_text`, which
 * lags typing by the debounce). A KEEP writes the live version of a run into
 * the frame; an UNDO writes the frame version of a run into the live text.
 * Splices self-record — a decided run stops being a difference — so there is
 * no kept/undone id bookkeeping, no server call, and no stale operation.
 *
 * The reading half is pure (`ledgerFrom`/`stopsFrom`/`groupLedgerSections`
 * take a plain snapshot) so it is tested without React; the verbs read the
 * stores live and are the only place that mutates them.
 */
import type { ChangeSetPayload } from './api';
import {
  keepRunsInFrame,
  reviewRuns,
  runSectionLabel,
  undoRunsInLive,
  type ReviewRun,
} from '../utils/reviewLedger';
import { useChangeSetStore } from '../stores/changeSetStore';
import { useConfigStore } from '../stores/configStore';
import { applyStagedEdits } from './changeSetReview';

/** The pure inputs the ledger reads — a snapshot of the two stores. */
export interface LedgerSnapshot {
  /** file → FRAME text; null when the review CREATED the file. Absent = no review. */
  reviewFrames: Record<string, string | null>;
  /** file → the editor's current text (beats the debounced raw_text). */
  liveTexts: Record<string, string>;
  /** file → the stored config (its raw_text is the fallback live text). */
  configFiles: Record<string, { raw_text?: string } | undefined>;
}

/** One file in the review: its frame, its live text, and the runs between. */
export interface LedgerFile {
  file: string;
  /** The review CREATED this file (its frame is null). */
  created: boolean;
  frame: string | null;
  live: string;
  runs: ReviewRun[];
}

/** One run, annotated for a decision row (the chat bar). */
export interface LedgerSectionRun {
  run: ReviewRun;
  key: string;
  /** `[stepper_x]` — the nearest header at/above the run, or ''. */
  label: string;
  /** The run's first added line, or first removed line for a pure deletion. */
  preview: string;
  added: number;
  removed: number;
}

/** A file's runs as the chat bar renders them (= `groupLedgerSections`). */
export interface LedgerSectionFile {
  file: string;
  created: boolean;
  added: number;
  removed: number;
  runs: LedgerSectionRun[];
}

/**
 * One stop for the review strip: a run plus where it lives. `line` is the run's
 * first LIVE line (`run.liveStart` — the return line for a pure deletion), so
 * the strip can scroll the live editor to it.
 */
export interface ReviewStop {
  key: string;
  file: string;
  line: number;
  label: string;
  added: number;
  removed: number;
}

// ── The pure reading half ────────────────────────────────────────────

/** The live text the ledger diffs: the editor buffer, else the stored text. */
export function liveTextFor(snap: LedgerSnapshot, file: string): string {
  if (file in snap.liveTexts) return snap.liveTexts[file];
  return snap.configFiles[file]?.raw_text ?? '';
}

function filePresent(snap: LedgerSnapshot, file: string): boolean {
  return file in snap.configFiles || file in snap.liveTexts;
}

/** The runs of ONE file, or [] when it is not under review. */
export function ledgerForIn(snap: LedgerSnapshot, file: string): ReviewRun[] {
  const frame = snap.reviewFrames[file];
  if (frame === undefined) return [];
  return reviewRuns(frame, liveTextFor(snap, file));
}

/**
 * Every file under review. A file with runs is in; so is a created file still
 * present (a created file can be empty — zero runs — and the user must still be
 * able to undo it away).
 */
export function ledgerFrom(snap: LedgerSnapshot): LedgerFile[] {
  const files: LedgerFile[] = [];
  for (const file of Object.keys(snap.reviewFrames)) {
    const frame = snap.reviewFrames[file];
    const live = liveTextFor(snap, file);
    const runs = reviewRuns(frame, live);
    if (runs.length === 0 && !(frame === null && filePresent(snap, file))) continue;
    files.push({ file, created: frame === null, frame, live, runs });
  }
  return files;
}

/** The strip's walk: every run of every file, in file order then run order. */
export function stopsFrom(files: readonly LedgerFile[]): ReviewStop[] {
  const stops: ReviewStop[] = [];
  for (const file of files) {
    for (const run of file.runs) {
      stops.push({
        key: run.key,
        file: file.file,
        line: run.liveStart,
        label: runSectionLabel(file.live, file.frame ?? '', run),
        added: run.added.length,
        removed: run.removed.length,
      });
    }
  }
  return stops;
}

/** A run's one-line preview: its section header when it introduces/retires
 * one (split runs start at the blank separator — `added[0]` there is ''),
 * else the first non-empty line, else as written. */
function runPreview(run: { added: string[]; removed: string[] }): string {
  for (const lines of [run.added, run.removed]) {
    const header = lines.find((line) => /^\s*\[[^\]]+\]/.test(line));
    if (header) return header.trim();
    const first = lines.find((line) => line.trim() !== '');
    if (first) return first;
  }
  return '';
}

/** The chat bar's rows: each file with its runs labelled and previewed. */
export function groupLedgerSections(files: readonly LedgerFile[]): LedgerSectionFile[] {
  return files.map((file) => {
    let added = 0;
    let removed = 0;
    const runs = file.runs.map((run) => {
      added += run.added.length;
      removed += run.removed.length;
      return {
        run,
        key: run.key,
        label: runSectionLabel(file.live, file.frame ?? '', run),
        preview: runPreview(run),
        added: run.added.length,
        removed: run.removed.length,
      };
    });
    return { file: file.file, created: file.created, added, removed, runs };
  });
}

// ── The mirror's rows ────────────────────────────────────────────────

/** One mirror row plus its gutter number (see `mirrorRowsFor`). */
export interface MirrorRow {
  type: 'header' | 'removed' | 'added' | 'context';
  content: string;
  /** Gutter number in the row's OWN space, or null (header/context). */
  line: number | null;
}

/**
 * One file's changed runs as the review mirror's rows (Sir, 2026-10-08).
 *
 * Each row carries its own line number, in the space that moment of the
 * file's life uses: a REMOVED row shows the number the line held in the
 * FRAME (`frameStart + i`), an ADDED row the number it holds in the LIVE
 * text (`liveStart + i`). A replacement run then reads exactly as asked —
 * the old line in red at its old number above the new line in green at its
 * new one — and keep/undo leave exactly one of the pair. Header rows carry
 * the file/section name and no number; a created-but-empty file still gets
 * one context row so its Keep/Undo has something to ride.
 */
export function mirrorRowsFor(file: LedgerSectionFile): MirrorRow[] {
  const rows: MirrorRow[] = [];
  for (const entry of file.runs) {
    rows.push({
      type: 'header',
      content: `${file.file}${entry.label ? ` · ${entry.label}` : ''}`,
      line: null,
    });
    entry.run.removed.forEach((text, i) => rows.push({ type: 'removed', content: text, line: entry.run.frameStart + i }));
    entry.run.added.forEach((text, i) => rows.push({ type: 'added', content: text, line: entry.run.liveStart + i }));
  }
  if (rows.length === 0) {
    rows.push({ type: 'context', content: `${file.file} (empty)`, line: null });
  }
  return rows;
}

/**
 * The FRAMES a change-set payload seeds. A created file's frame is `null` (its
 * whole live text is one green run); every other file's is its pre-review text.
 */
export function framesFromChangeSet(set: ChangeSetPayload | null | undefined): Record<string, string | null> {
  const frames: Record<string, string | null> = {};
  if (!set) return frames;
  for (const file of set.files ?? []) {
    frames[file.file] = typeof file.beforeText === 'string' ? file.beforeText : '';
  }
  for (const created of set.createdFiles ?? []) frames[created] = null;
  return frames;
}

// ── The store-reading half ───────────────────────────────────────────

function snapshot(): LedgerSnapshot {
  return {
    reviewFrames: useChangeSetStore.getState().reviewFrames,
    liveTexts: useConfigStore.getState().liveTexts,
    configFiles: useConfigStore.getState().configFiles,
  };
}

/** The runs of one file, read live from the stores. */
export function ledgerFor(file: string): ReviewRun[] {
  return ledgerForIn(snapshot(), file);
}

/** Every file under review, read live from the stores. */
export function reviewFiles(): LedgerFile[] {
  return ledgerFrom(snapshot());
}

/** Every run, read live from the stores, in walk order. */
export function reviewStops(): ReviewStop[] {
  return stopsFrom(reviewFiles());
}

/** The chat bar's rows, read live from the stores. */
export function reviewSections(): LedgerSectionFile[] {
  return groupLedgerSections(reviewFiles());
}

// ── The active-file applier ──────────────────────────────────────────
// A splice into the ACTIVE file must move the textarea's own state, not the
// model (the editor is the source of truth there, and its debounced parse will
// write the model afterwards). `TextEditor` registers a callback while it is
// showing a file; an inactive file is written through the model instead.

type LiveApplier = { file: string; apply: (text: string) => void };
let liveApplier: LiveApplier | null = null;

/** Register (fn) or clear (null) the active file's live-text applier. */
export function setLiveApplier(file: string, fn: ((text: string) => void) | null): void {
  if (fn === null) {
    // Clear whatever is registered: the editor's effect cleanup runs before it
    // registers the next file's applier, so there is never a live one to keep.
    liveApplier = null;
    return;
  }
  liveApplier = { file, apply: fn };
}

/**
 * Make `newLive` the live text of `file`.
 *
 * Active file → hand it to the editor (its debounced parse writes the model).
 * Inactive file → write the model directly, exactly as a staged edit does, so
 * a decision on a file the text view is not holding still lands. Afterwards
 * the dirty flag is re-derived: an undo can put the file back exactly as it
 * was on disk, and leaving "Unsaved changes" would be a lie.
 */
async function applyLive(file: string, newLive: string): Promise<void> {
  useConfigStore.getState().setLiveText(file, newLive);
  if (liveApplier && liveApplier.file === file) {
    liveApplier.apply(newLive);
    return;
  }
  await applyStagedEdits([{ file, op: 'update', summary: '', newText: newLive }]);
  useConfigStore.getState().markCleanIfMatchesDisk();
}

/** Undo a review-CREATED file: the run was the whole file, so the file goes. */
function removeCreatedFile(file: string): void {
  // removeConfigFile also drops the file's liveTexts entry; drop the frame so
  // the file leaves the review entirely.
  useConfigStore.getState().removeConfigFile(file);
  useChangeSetStore.getState().removeReviewFrame(file);
}

// ── The decisions ────────────────────────────────────────────────────

/** KEEP one run: the frame takes the live version of it. Text does not move. */
export function keepRun(file: string, key: string): void {
  const store = useChangeSetStore.getState();
  const frame = store.reviewFrames[file];
  if (frame === undefined) return;              // no review for this file
  const live = liveTextFor(snapshot(), file);
  const runs = reviewRuns(frame, live);
  if (!runs.some((run) => run.key === key)) return;   // no matching run: no-op
  store.setReviewFrame(file, keepRunsInFrame(frame, live, runs, new Set([key])));
}

/** KEEP every run of one file. */
export function keepAllIn(file: string): void {
  const store = useChangeSetStore.getState();
  const frame = store.reviewFrames[file];
  if (frame === undefined) return;
  const live = liveTextFor(snapshot(), file);
  const runs = reviewRuns(frame, live);
  if (runs.length === 0) return;
  store.setReviewFrame(file, keepRunsInFrame(frame, live, runs, new Set(runs.map((run) => run.key))));
}

/** UNDO one run: live takes the frame version of it. */
export async function undoRun(file: string, key: string): Promise<void> {
  const store = useChangeSetStore.getState();
  const frame = store.reviewFrames[file];
  if (frame === undefined) return;
  const live = liveTextFor(snapshot(), file);
  const runs = reviewRuns(frame, live);
  if (!runs.some((run) => run.key === key)) return;   // no matching run: no-op
  if (frame === null) {
    removeCreatedFile(file);
    return;
  }
  await applyLive(file, undoRunsInLive(frame, live, runs, new Set([key])));
}

/** UNDO every run of one file. */
export async function undoAllIn(file: string): Promise<void> {
  const store = useChangeSetStore.getState();
  const frame = store.reviewFrames[file];
  if (frame === undefined) return;
  const live = liveTextFor(snapshot(), file);
  const runs = reviewRuns(frame, live);
  if (runs.length === 0) return;
  if (frame === null) {
    removeCreatedFile(file);
    return;
  }
  await applyLive(file, undoRunsInLive(frame, live, runs, new Set(runs.map((run) => run.key))));
}

/** KEEP every run everywhere. */
export function keepAll(): void {
  for (const file of reviewFiles()) keepAllIn(file.file);
}

/** UNDO every run everywhere. */
export async function undoAll(): Promise<void> {
  for (const file of reviewFiles()) await undoAllIn(file.file);
}
