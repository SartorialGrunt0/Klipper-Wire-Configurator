/**
 * Ghost rows: the deleted line, INSIDE the edit view (Sir, 2026-10-08).
 *
 * The report: a replacement review must read old-red-above-new-green in the
 * TEXT VIEW ITSELF — the editable textarea, never a read-only stand-in. The
 * gutter numbers LIVE rows only: a ghost row takes no number (8d3cd42), so
 * every visible number is the line's real number at all times.
 *
 * The drift law (e482e63, eb61bf5) forbids rows positioned OUTSIDE the text's
 * flow: a floating band or injected per-line box rounds its offset
 * independently of the textarea's continuous line boxes and slides off. But a
 * ghost row that is a REAL line inside the textarea's own `value` cannot
 * drift — it IS the flow. So the architecture is:
 *
 *     DISPLAY = LIVE + ghost lines   (rendered into the textarea)
 *     everything else sees LIVE only (ledger, parse, save, chat)
 *
 * A ghost is frame content re-inserted above its run's top live line. Ghost
 * identity is CONTENT at the expected slot: an edit INTO a ghost breaks the
 * match, the typed text joins LIVE, and the ledger's next diff decides what
 * the run means —
 *  - edit the ghost, then UNDO → live takes the frame version: the line
 *    returns as the frame wrote it; the ghost-edit is discarded;
 *  - edit the ghost, then KEEP → frame takes the live version: the EDITED
 *    line is kept;
 *  - edit the ghost back to the frame's exact text → the run nets to zero,
 *    the marks disappear by themselves.
 * Stripping is content-matched, never positional, so a display line that no
 * longer equals its ghost is LIVE text and a round trip through the display
 * changes nothing the user did not type.
 */
import { reviewRuns, type ReviewRun } from './reviewLedger';

/**
 * The ledger runs of one reviewed file whose ghosts render into the display:
 * every run that removed frame lines (replacement or pure deletion).
 */
export function ghostedRuns(frame: string, live: string): ReviewRun[] {
  return reviewRuns(frame, live).filter((run) => run.removed.length > 0);
}

/**
 * A file's ghosts in LIVE space: frame lines to re-insert, grouped by the
 * live line each ghost sits ABOVE (an EOF run anchors past the last line and
 * renders below it). Built from the ledger on every derivation, so marks are
 * recomputed, never patched.
 */
export function ghostsByLiveLine(runs: readonly ReviewRun[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const run of runs) {
    if (run.removed.length === 0) continue;
    const anchor = Math.max(run.liveStart, 1);
    const existing = map.get(anchor) ?? [];
    existing.push(...run.removed);
    map.set(anchor, existing);
  }
  return map;
}

/**
 * Build the DISPLAY text: LIVE with every ghost re-inserted above its anchor
 * live line (a ghost anchored past the last line renders below it). Returns
 * the display text and the ASCENDING display rows that are ghosts (the red
 * rows) — that array is the coordinate system every offset map takes.
 */
export function buildReviewDisplay(
  live: string,
  ghosts: ReadonlyMap<number, string[]>,
): { display: string; ghostDisplayLines: number[] } {
  if (ghosts.size === 0) return { display: live, ghostDisplayLines: [] };
  const liveLines = live.split('\n');
  const displayLines: string[] = [];
  const ghostDisplayLines: number[] = [];
  for (let i = 0; i < liveLines.length; i += 1) {
    const above = ghosts.get(i + 1);
    if (above) {
      for (const g of above) {
        displayLines.push(g);
        ghostDisplayLines.push(displayLines.length);
      }
    }
    displayLines.push(liveLines[i]);
  }
  const eof = ghosts.get(liveLines.length + 1);
  if (eof) {
    for (const g of eof) {
      displayLines.push(g);
      ghostDisplayLines.push(displayLines.length);
    }
  }
  return { display: displayLines.join('\n'), ghostDisplayLines };
}

/**
 * Turn the textarea's text (after an edit) back into LIVE text.
 *
 * Ghost blocks are matched in ascending anchor order at the slot the display
 * builder gave them: `anchor - 1` live rows plus the ghost rows already
 * consumed, with a one-row soft edge for the blank line an Enter leaves at
 * either boundary of the slot. A match there is decisive — the ghost sits
 * where it was built, whatever the user did elsewhere.
 *
 * A block whose content duplicates a LIVE line above the slot strips at the
 * SLOT, never at the twin: content alone cannot tell a ghost from a repeat
 * of the same text the user always had, and stripping the twin relocated
 * live text (PR #36 review, B-1). Row arithmetic is the tiebreaker.
 *
 * When the slot does NOT match, the walk emits live rows up to the slot,
 * stopping EARLY at a full-block content match: a match below the slot that
 * does not collide with live's own row (see twin retirement above) is the
 * ghost riding up with rows the user deleted above it, so it strips there.
 * A one-row soft edge handles the blank an Enter leaves at the slot
 * boundary. Failing all of that the block is retired — the user's edit
 * consumed it at the slot — and its rows become LIVE text; the ledger's
 * next diff decides what that means.
 *
 * Each stripped row is reported in `strippedDisplayLines` (row numbers in
 * the NEW text) — the caret bridge needs them: the caret sat at a row of
 * the OLD display, and it lands at that row minus the ghosts stripped
 * before it.
 *
 * Round trip: `liveFromDisplay(buildReviewDisplay(live, g).display, g) ===
 * live` for every live text and ghost map.
 */
export function stripGhostsFromDisplay(
  newText: string,
  ghosts: ReadonlyMap<number, string[]>,
  live?: string,
): { live: string; strippedDisplayLines: number[] } {
  if (ghosts.size === 0) return { live: newText, strippedDisplayLines: [] };
  const lines = newText.split('\n');
  // AMBIGUOUS-DELETE BIAS (round-2 N1): when the edited text has come to
  // EQUAL the caller's live text byte-for-byte, every ghost row is gone
  // from the textarea. Deleting a ghost whose content duplicates a live
  // line produces exactly this state — and is byte-identical to deleting
  // the live twin instead (undecidable from text alone). The safe reading
  // is the one that never loses live text: retire every ghost, return the
  // live text unchanged. If the user actually deleted a live twin, the
  // deletion visibly bounces back (the row stays, the ledger re-derives
  // the run) — recoverable annoyance, never silent corruption.
  if (live !== undefined && newText === live) {
    return { live, strippedDisplayLines: [] };
  }
  const strippedDisplayLines: number[] = [];
  const out: string[] = [];
  const anchors = [...ghosts.keys()].sort((a, b) => a - b);
  const matchAt = (start: number, block: readonly string[]): boolean =>
    block.length > 0 && block.every((g, k) => start + k < lines.length && lines[start + k] === g);
  // TWIN RETIREMENT (round-2 N1, round-3 R3). A content match found ABOVE
  // the slot (walk stop / Enter-boundary / forward search) is normally a
  // ghost that rode up with deleted rows — but it is indistinguishable from
  // the LIVE twin of a ghost the user deleted at its slot whenever the
  // ghost's content duplicates a live line: both readings produce the same
  // text (delete ghost = delete twin; byte-identical rows). Proof: frame
  // '...a / a / ... / b / b', delete either 'a' row of the display — same
  // newText, and row counts cannot separate the readings. So when `live`
  // is given and the match at p would consume live's OWN line — live's row
  // at out.length + (p - i) equals the block — retire the ghost instead of
  // stripping: live is returned with that line intact. If the user really
  // deleted the live twin, the deletion bounces (the ledger's next diff
  // re-raises the run) — recoverable, never silent live loss. Without a
  // twin at p the match is a genuine ride-up and strips as before.
  const liveRows = live !== undefined ? live.split('\n') : null;
  const isLiveTwinAt = (p: number, i: number, block: readonly string[]): boolean =>
    liveRows !== null
    && out.length + (p - i) < liveRows.length
    && block.every((g, k) => liveRows[out.length + (p - i) + k] === g);
  let i = 0;
  for (const anchor of anchors) {
    const block = ghosts.get(anchor) ?? [];
    // Live rows that must precede this block's slot: anchor - 1. (Row
    // numbers — out.length IS the live-row count, so ghosts consumed
    // earlier never skew it.)
    const slotLive = anchor - 1;
    // SLOT-FIRST. The builder placed this block after exactly `slotLive`
    // live rows, so its position in the text is i + (slotLive − out.length)
    // — deterministic while the ghost sits where it was built. A match at
    // that slot is decisive, and content matches ABOVE it are then live
    // text the user has (a frame line duplicated in the buffer), NOT a
    // shifted ghost: stripping a twin above the slot relocated text
    // (PR #36 review, B-1). Only when the slot itself does NOT match is
    // an above-slot content match meaningful — it means rows above were
    // deleted and the ghost rode up with them.
    const slot = i + (slotLive - out.length);
    if (matchAt(slot, block)) {
      for (let q = i; q < slot; q += 1) out.push(lines[q]);
      for (let q = 0; q < block.length; q += 1) strippedDisplayLines.push(slot + q + 1);
      i = slot + block.length;
      continue;
    }
    // Emit live rows up to the slot, stopping EARLY (robust to the user
    // deleting rows above this ghost) once the block matches at the walk.
    // A twin match RETIRES the ghost: the walk stops there without
    // stripping and the rows flow to LIVE through the slot walk below.
    while (out.length < slotLive && !matchAt(i, block)) {
      out.push(lines[i]);
      i += 1;
    }
    if (matchAt(i, block)) {
      if (isLiveTwinAt(i, i, block)) {
        // Ambiguous twin at the walk stop — retire: emit rows up to the
        // slot as LIVE (the match row included) and move on.
        while (out.length < slotLive) {
          out.push(lines[i]);
          i += 1;
        }
        continue;
      }
      for (let q = 0; q < block.length; q += 1) strippedDisplayLines.push(i + q + 1);
      i += block.length;
      continue;
    }
    if (lines[i] === '' && matchAt(i + 1, block) && !isLiveTwinAt(i + 1, i + 1, block)) {
      // Enter-at-boundary: the blank row is the user's (live); the block
      // matches just below it.
      out.push(lines[i]);
      i += 1;
      for (let q = 0; q < block.length; q += 1) strippedDisplayLines.push(i + q + 1);
      i += block.length;
      continue;
    }
    // Slot does not match. Either the user's edit consumed the ghost (typed
    // over / deleted at the slot) or added rows above it and pushed the
    // block down. A forward exact search answers both without counting:
    // consumed → the exact block appears nowhere (barring a duplicate of
    // the frame text further down, a benign edge: the ghost just rides the
    // other copy and the next diff re-reads the run); pushed → first exact
    // match wins, everything before it is live.
    let j = i;
    let found = -1;
    while (j < lines.length) {
      if (matchAt(j, block)) { found = j; break; }
      j += 1;
    }
    if (found >= 0) {
      for (let q = i; q < found; q += 1) out.push(lines[q]);
      for (let q = 0; q < block.length; q += 1) strippedDisplayLines.push(found + q + 1);
      i = found + block.length;
      continue;
    }
    // retired: frame text at the slot is live now (or gone). The rows at the
    // slot are LIVE text the user typed — the next anchor's walk (or the tail
    // walk) emits them; nothing special happens here.
  }
  while (i < lines.length) {
    out.push(lines[i]);
    i += 1;
  }
  return { live: out.join('\n'), strippedDisplayLines };
}

/** Round-trip convenience: strip returning just the live text. Pass the
 *  caller's CURRENT live text to arm the twin-retirement law (N1) — the
 *  strip alone cannot see it, and without it the ambiguous delete keeps
 *  its historical content-search behavior. */
export function liveFromDisplay(
  display: string,
  ghosts: ReadonlyMap<number, string[]>,
  live?: string,
): string {
  return stripGhostsFromDisplay(display, ghosts, live).live;
}

/**
 * Translate a caret/selection from the EDITED display text to LIVE, given
 * the rows `stripGhostsFromDisplay` just dropped. Stripped rows cost a line
 * + newline of display chars and no live chars; a caret inside a stripped
 * row collapses to the row's start. `text` is the edited display the offsets
 * were read from (the same text the strip was given).
 */
export function displayToLiveOffsetAfterStrip(
  text: string,
  strippedDisplayLines: readonly number[],
  displayOffset: number,
): number {
  if (strippedDisplayLines.length === 0) return displayOffset;
  const lines = text.split('\n');
  const stripped = new Set(strippedDisplayLines);
  let pos = 0;
  let livePos = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineEnd = pos + lines[i].length + 1;
    if (stripped.has(i + 1)) {
      if (displayOffset < lineEnd) return livePos; // caret in a dying ghost row
    } else {
      if (displayOffset <= lineEnd) return livePos + (displayOffset - pos);
      livePos += lines[i].length + 1;
    }
    pos = lineEnd;
  }
  return livePos;
}

// ── Offset mapping ───────────────────────────────────────────────────
// Handlers that read the textarea (caret, selection, key edits) exchange
// coordinates between the two texts. Ghost rows cost display chars but no
// live chars, so every map is a walk of the display lines with the ghost
// membership known.

/** LIVE offset → DISPLAY offset (caret moves driven from live state). */
export function liveToDisplayOffset(
  live: string,
  display: string,
  ghostDisplayLines: readonly number[],
  liveOffset: number,
): number {
  if (ghostDisplayLines.length === 0) return Math.min(liveOffset, live.length);
  const ghosts = new Set(ghostDisplayLines);
  const liveLines = live.split('\n');
  const displayLines = display.split('\n');
  let liveAcc = 0;     // live chars before the current live row
  let liveIdx = 0;
  let displayAcc = 0;  // display chars before the current display row
  for (let d = 0; d < displayLines.length; d += 1) {
    if (ghosts.has(d + 1)) {
      displayAcc += displayLines[d].length + 1;
      continue;
    }
    const liveLine = liveLines[liveIdx] ?? '';
    if (liveOffset <= liveAcc + liveLine.length) {
      return displayAcc + (liveOffset - liveAcc);
    }
    liveAcc += liveLine.length + 1;
    liveIdx += 1;
    displayAcc += displayLines[d].length + 1;
  }
  return display.length;
}

/**
 * DISPLAY offset → LIVE offset. Ghost rows cost no live chars, so their span
 * collapses to the live position just BELOW the ghost — the run's anchor —
 * which is where a caret parked on a ghost line belongs (typing continues
 * the live buffer at the line the frame text would return to).
 */
export function displayToLiveOffset(
  display: string,
  ghostDisplayLines: readonly number[],
  displayOffset: number,
): number {
  if (ghostDisplayLines.length === 0) return displayOffset;
  const ghosts = new Set(ghostDisplayLines);
  const lines = display.split('\n');
  let pos = 0;
  let livePos = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineEnd = pos + lines[i].length + 1; // end including the '\n'
    if (ghosts.has(i + 1)) {
      if (displayOffset < lineEnd) return livePos; // caret inside ghost → below it
    } else {
      if (displayOffset <= lineEnd) return livePos + (displayOffset - pos);
      livePos += lines[i].length + 1;
    }
    pos = lineEnd;
  }
  return livePos; // displayOffset at/after EOF
}

/**
 * LIVE line → DISPLAY row (scrolling: findings jumps, strip stops). A ghost
 * anchored at live line `a` sits above it, so live line L renders at
 * L + (ghosts anchored at or above L).
 */
export function liveLineToDisplayLine(
  ghosts: ReadonlyMap<number, string[]>,
  liveLine: number,
): number {
  let extra = 0;
  for (const [anchor, block] of ghosts) {
    if (anchor <= liveLine) extra += block.length;
  }
  return liveLine + extra;
}

/**
 * DISPLAY row → LIVE line (caret bookkeeping, completion, current-line
 * highlight). Every display row maps to `row − (ghosts strictly above it)`;
 * a ghost row itself lands on the live line it sits above — its anchor —
 * so the caret reading a ghost line still points at the live row the frame
 * text belongs to.
 */
export function displayLineToLiveLine(
  ghostDisplayLines: readonly number[],
  displayLine: number,
): number {
  let ghostsAbove = 0;
  for (const g of ghostDisplayLines) {
    if (g < displayLine) ghostsAbove += 1;
  }
  return Math.max(1, displayLine - ghostsAbove);
}
