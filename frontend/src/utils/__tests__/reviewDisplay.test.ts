import { describe, expect, it } from 'vitest';
import {
  buildReviewDisplay,
  displayLineToLiveLine,
  displayToLiveOffset,
  ghostedRuns,
  ghostsByLiveLine,
  liveFromDisplay,
  liveLineToDisplayLine,
  stripGhostsFromDisplay,
  liveToDisplayOffset,
} from '../reviewDisplay';
import { reviewRuns } from '../reviewLedger';

/** A frame with one value line at 3; live replaced it (the Sir scenario). */
const FRAME = ['[printer]', 'max_velocity: 600', 'max_accel: 15500'].join('\n');
const LIVE = ['[printer]', 'max_velocity: 300', 'max_accel: 15500'].join('\n');

function displayOf(frame: string, live: string) {
  const ghosts = ghostsByLiveLine(ghostedRuns(frame, live));
  return { live, ghosts, ...buildReviewDisplay(live, ghosts) };
}

describe('ghostedRuns', () => {
  it('picks the runs that removed frame lines', () => {
    const runs = ghostedRuns(FRAME, LIVE);
    expect(runs).toHaveLength(1);
    expect(runs[0].removed).toEqual(['max_velocity: 600']);
  });

  it('ignores add-only runs', () => {
    // Trailing newlines on both sides: a frame whose last line is
    // unterminated diffs its last line as replaced when live appends
    // (diffLines quirk), which is its own honest run, not this case.
    const live = `${FRAME}\nextra: 1\n`;
    expect(ghostedRuns(`${FRAME}\n`, live)).toHaveLength(0);
  });

  it('ignores a created file (no frame to be ghosted from)', () => {
    // reviewRuns(null, live) yields one add-only run — no removals either way.
    const runs = reviewRuns(null, 'anything\n').filter((r) => r.removed.length > 0);
    expect(runs).toHaveLength(0);
  });
});

describe('buildReviewDisplay', () => {
  it('inserts the old red line directly above the green replacement', () => {
    const { display, ghostDisplayLines } = displayOf(FRAME, LIVE);
    // rows: 1 [printer] / 2 600 (ghost) / 3 300 / 4 15500
    expect(display.split('\n')).toEqual([
      '[printer]',
      'max_velocity: 600',
      'max_velocity: 300',
      'max_accel: 15500',
    ]);
    expect(ghostDisplayLines).toEqual([2]);
  });

  it('renders pure deletions as ghosts above the return line', () => {
    const frame = ['a', 'gone', 'b'].join('\n');
    const live = ['a', 'b'].join('\n');
    const { display, ghostDisplayLines } = displayOf(frame, live);
    expect(display.split('\n')).toEqual(['a', 'gone', 'b']);
    expect(ghostDisplayLines).toEqual([2]);
  });

  it('handles several runs each with its own ghosts', () => {
    const frame = ['x1', 'x2', 'keep', 'y1', 'y2'].join('\n');
    const live = ['X', 'keep', 'Y'].join('\n');
    const { display, ghostDisplayLines } = displayOf(frame, live);
    expect(display.split('\n')).toEqual(['x1', 'x2', 'X', 'keep', 'y1', 'y2', 'Y']);
    expect(ghostDisplayLines).toEqual([1, 2, 5, 6]);
  });

  it('anchors a tail deletion above the empty final row', () => {
    const frame = 'a\nb\ntail\n';
    const live = 'a\nb\n';
    const { display, ghostDisplayLines } = displayOf(frame, live);
    // live rows: a / b / '' (the empty tail row a trailing newline creates)
    expect(display.split('\n')).toEqual(['a', 'b', 'tail', '']);
    expect(ghostDisplayLines).toEqual([3]);
  });

  it('is identity when nothing was removed', () => {
    const live = `${FRAME}\nadded: 1\n`;
    const { display, ghostDisplayLines } = displayOf(`${FRAME}\n`, live);
    expect(display).toBe(live);
    expect(ghostDisplayLines).toEqual([]);
  });

  it('ends every file with a newline exactly like the live text', () => {
    const { display } = displayOf(`${FRAME}\n`, `${LIVE}\n`);
    expect(display.endsWith('\n')).toBe(true);
    // The ghost sits before the newline-terminated tail row, not after it.
    expect(display.split('\n')).toEqual(['[printer]', 'max_velocity: 600', 'max_velocity: 300', 'max_accel: 15500', '']);
  });
});

describe('liveFromDisplay', () => {
  it('round-trips the untouched display back to live exactly', () => {
    for (const [frame, live] of [
      [FRAME, LIVE],
      ['a\ngone\nb', 'a\nb'],
      ['x1\nx2\nkeep\ny1\ny2', 'X\nkeep\nY'],
      ['a\nb\ntail', 'a\nb'],
    ] as const) {
      const built = displayOf(frame, live);
      expect(liveFromDisplay(built.display, built.ghosts)).toBe(live);
    }
  });

  it('strips the SLOT ghost, not a duplicate live line above it (PR #36 B-1)', () => {
    // frame: A DUP B DUP C — live deleted the SECOND DUP. The ghost (DUP)
    // is identical to the live DUP two rows above it, so a content-first
    // walk strips the wrong row and relocates text. The slot's row
    // arithmetic is decisive: the ghost sits at slotLive + ghosts-stripped.
    const ghosts = new Map<number, string[]>([[4, ['DUP']]]);
    const live = 'A\nDUP\nB\nC\n';
    const built = buildReviewDisplay(live, ghosts);
    expect(built.display).toBe('A\nDUP\nB\nDUP\nC\n');
    expect(liveFromDisplay(built.display, ghosts)).toBe(live);
  });

  it('identity round trip survives a fuzz over duplicate-heavy texts (B-1)', () => {
    const alpha = ['A', 'B', 'C', ''];
    const seqs: string[][] = [];
    const build = (n: number, prefix: string[]) => {
      if (n === 0) { seqs.push(prefix); return; }
      for (const a of alpha) build(n - 1, [...prefix, a]);
    };
    build(4, []);
    let checked = 0;
    for (const frameLines of seqs) {
      for (let del = 0; del <= 2; del += 1) {
        for (let d = 0; d + del <= frameLines.length; d += 1) {
          const live = [...frameLines.slice(0, d), ...frameLines.slice(d + del)].join('\n');
          const built = displayOf(frameLines.join('\n'), live);
          checked += 1;
          expect(liveFromDisplay(built.display, built.ghosts),
            `frame=${JSON.stringify(frameLines)} live=${JSON.stringify(live)}`).toBe(live);
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('a macro that deletes one of two identical gcode: lines round-trips', () => {
    const frame = '[gcode_macro X]\ngcode:\n  M117 a\n  M117 a\n  M117 b\n';
    const live = '[gcode_macro X]\ngcode:\n  M117 a\n  M117 b\n';
    const built = displayOf(frame, live);
    expect(built.display.split('\n')).toEqual(
      ['[gcode_macro X]', 'gcode:', '  M117 a', '  M117 a', '  M117 b', '']);
    expect(liveFromDisplay(built.display, built.ghosts)).toBe(live);
  });

  it('keeps a live edit made far from the ghost', () => {
    const built = displayOf(FRAME, LIVE);
    const editedDisplay = built.display.replace('max_accel: 15500', 'max_accel: 9999');
    expect(liveFromDisplay(editedDisplay, built.ghosts)).toBe(
      LIVE.replace('max_accel: 15500', 'max_accel: 9999'),
    );
  });

  it('dissolves an EDITED ghost into live text (edited line survives)', () => {
    const built = displayOf(FRAME, LIVE);
    const editedDisplay = built.display.replace('max_velocity: 600', 'max_velocity: 700');
    const next = liveFromDisplay(editedDisplay, built.ghosts);
    // The ghost content broke: the edited line joins live...
    expect(next).toBe(['[printer]', 'max_velocity: 700', 'max_velocity: 300', 'max_accel: 15500'].join('\n'));
    // ...and the NEXT diff sees the frame line still gone, so a fresh ghost
    // appears above it: red 600 over 700 over green 300.
    const again = displayOf(FRAME, next);
    expect(again.display.split('\n')).toEqual([
      '[printer]',
      'max_velocity: 600',
      'max_velocity: 700',
      'max_velocity: 300',
      'max_accel: 15500',
    ]);
    // Keep then takes the edited version (frame ← live); Undo restores 600.
  });

  it('deleting a ghost row that duplicates a live line keeps the LIVE twin (N1)', () => {
    // Ghost content equals a live line. Deleting the ghost row at its slot
    // leaves the display with only the LIVE twin — a forward content search
    // strips THAT and destroys live text. Positional reasoning must retire
    // the ghost instead: live unchanged.
    const frame = '[gcode_macro X]\ngcode:\n  M117 a\n  M117 a\n';
    const live = '[gcode_macro X]\ngcode:\n  M117 a\n';
    const built = displayOf(frame, live);
    const rows = built.display.split('\n');
    const ghostRow = built.ghostDisplayLines[0];
    const deleted = [...rows.slice(0, ghostRow - 1), ...rows.slice(ghostRow)].join('\n');
    expect(liveFromDisplay(deleted, built.ghosts, live)).toBe(live);
  });

  it('deleting a blank ghost row that duplicates a live blank keeps live (N1)', () => {
    const built = displayOf('a\n\nb\n', 'a\nb\n');
    const rows = built.display.split('\n');
    const ghostRow = built.ghostDisplayLines[0];
    const deleted = [...rows.slice(0, ghostRow - 1), ...rows.slice(ghostRow)].join('\n');
    expect(liveFromDisplay(deleted, built.ghosts, 'a\nb\n')).toBe('a\nb\n');
  });

  it('keeps the LIVE twin when a SECOND ghost exists elsewhere (N1 residual)', () => {
    // The newText===live short-circuit cannot fire here: after deleting
    // ghost row 4 the text still differs from live (ghost Y remains). The
    // old forward content search ran past the next anchor's slot and
    // stripped the live '  M117 a' twin (round-3 R3 finding). The search
    // window must end at the next ghost's slot.
    const frame = '[gcode_macro X]\ngcode:\n  M117 a\n  M117 a\n\n[gcode_macro Y]\ngcode:\n  M117 b\n  M117 b\n';
    const live = '[gcode_macro X]\ngcode:\n  M117 a\n\n[gcode_macro Y]\ngcode:\n  M117 b\n';
    const built = displayOf(frame, live);
    const rows = built.display.split('\n');
    // Two ghost rows: the duplicated '  M117 a' and the duplicated '  M117 b'.
    expect(built.ghostDisplayLines.length).toBe(2);
    const ghostX = built.ghostDisplayLines.find((r) => rows[r - 1] === '  M117 a');
    expect(ghostX).toBeDefined();
    const deleted = [...rows.slice(0, ghostX! - 1), ...rows.slice(ghostX!)].join('\n');
    const strip = stripGhostsFromDisplay(deleted, built.ghosts, live);
    // Live '  M117 a' must survive; the X run retires, ghost Y still
    // strips at its own slot (live has each line once).
    expect(strip.live.split('\n').filter((l) => l === '  M117 a').length).toBe(1);
    expect(strip.live.split('\n').filter((l) => l === '  M117 b').length).toBe(1);
    expect(strip.live).toBe(live);
  });

  it('recovers a ghost pushed up by deletes above it (window must not break push-up)', () => {
    // Deleting live rows ABOVE a ghost shifts it toward row 1; the block is
    // no longer at its slot but must still be found and stripped — the
    // fix for the twin case must not turn slot-miss into always-retire.
    const frame = 'l1\nl2\ngone\nmid\ntail\n';
    const live = 'l1\nl2\nmid\ntail\n';
    const built = displayOf(frame, live);
    const displayRows = built.display.split('\n');
    // Delete live row 'l1': ghosts ride up but keep their relative order.
    const kept = displayRows.filter((_, idx) => idx !== displayRows.indexOf('l1'));
    const strip = stripGhostsFromDisplay(kept.join('\n'), built.ghosts, live);
    expect(strip.live.split('\n')).toEqual(['l2', 'mid', 'tail', '']);
  });

  it('resolves the all-identical delete safe: bounce, never silent loss (N1 accepted-risk)', () => {
    // Two byte-identical rows, one deleted: undecidable which was the
    // ghost. Safe direction = treat as ghost-deleted (row effectively
    // stays; ledger re-raises). Pinning this so the bounce is a tested
    // behavior, not an accident.
    const frame = 'a\nx\nx\n';
    const live = 'a\nx\n';
    const built = displayOf(frame, live);
    const rows = built.display.split('\n');
    const ghostRow = built.ghostDisplayLines[0];
    // Delete the GHOST twin.
    const delGhost = [...rows.slice(0, ghostRow - 1), ...rows.slice(ghostRow)].join('\n');
    expect(stripGhostsFromDisplay(delGhost, built.ghosts, live).live).toBe(live);
    // Delete the LIVE twin: byte-identical input → same safe output (the
    // delete 'bounces'; the run is still under review).
    const liveIdx = rows.findIndex((l, idx) => l === 'x' && idx + 1 !== ghostRow);
    const delLive = [...rows.slice(0, liveIdx), ...rows.slice(liveIdx + 1)].join('\n');
    expect(delGhost).toBe(delLive); // the undecidability proof: identical inputs
    expect(stripGhostsFromDisplay(delLive, built.ghosts, live).live).toBe(live);
  });

  it('forward-search twin: byte-distinguishable ghost delete keeps the LIVE twin (R4 HIGH)', () => {
    // live 'x y z B' + ghost B (above y) + ghost Z (above EOF) →
    // display 'x B y z B Z'. Deleting ghost B leaves text that is NOT
    // equal to live (ghost Z still shows), so the newText===live
    // short-circuit cannot fire and the forward search runs; it must not
    // strip the LIVE 'B' it finds further down.
    const frame = 'x\nB\ny\nz\nB\nZ\n';
    const live = 'x\ny\nz\nB\n';
    const built = displayOf(frame, live);
    expect(built.ghostDisplayLines).toEqual([2, 6]);
    const rows = built.display.split('\n');
    const deleted = [...rows.slice(0, 1), ...rows.slice(2)].join('\n');
    expect(stripGhostsFromDisplay(deleted, built.ghosts, live).live).toBe(live);
  });

  it('retirement never grows the row count (R4 MEDIUM)', () => {
    // Multi-delete ending in a twin-retire: the retire loop must stop at
    // the text's end, not pad LIVE with phantom blank rows.
    const frame = 'A\nB\nC\nD\nE\nA\nF\n';
    const live = 'A\nB\nC\nD\nE\nF\n';
    const built = displayOf(frame, live);
    const deleted = 'A\nB\nF\n';
    const strip = stripGhostsFromDisplay(deleted, built.ghosts, live);
    expect(strip.live.split('\n').length).toBeLessThanOrEqual(deleted.split('\n').length);
    expect(strip.live).toBe('A\nB\nF\n');
  });

  it('lets the user delete the ghost row without touching live', () => {
    const built = displayOf(FRAME, LIVE);
    // Deleting the ghost line in the textarea removes the whole row INCLUDING
    // its newline: live must be unchanged.
    const noGhost = built.display.replace('max_velocity: 600\n', '');
    expect(liveFromDisplay(noGhost, built.ghosts)).toBe(LIVE);
  });

  it('treats typing INTO the ghost slot as an edit, not a ghost loss', () => {
    const built = displayOf(FRAME, LIVE);
    // User places the caret at the end of the ghost and appends a char: the
    // slot content breaks → it becomes live text.
    const typed = built.display.replace('max_velocity: 600', 'max_velocity: 600#');
    const next = liveFromDisplay(typed, built.ghosts);
    expect(next).toBe(['[printer]', 'max_velocity: 600#', 'max_velocity: 300', 'max_accel: 15500'].join('\n'));
  });

  it('survives an empty live text (whole file removed)', () => {
    const built = displayOf('a\nb', '');
    // live='' is still ONE (empty) live row; the ghost block rides above it.
    expect(built.display.split('\n')).toEqual(['a', 'b', '']);
    expect(liveFromDisplay(built.display, built.ghosts)).toBe('');
  });
});

describe('offset maps', () => {
  const built = displayOf(FRAME, LIVE);
  // display rows: 1 [printer] / 2 GHOST600 / 3 300 / 4 15500

  it('maps live offsets around the ghost block', () => {
    // start of line 2 (live) = '[printer]\n'.length = 10
    expect(liveToDisplayOffset(LIVE, built.display, built.ghostDisplayLines, 10)).toBe(10 + 'max_velocity: 600'.length + 1);
    // mid line 3: live offset 10 + 'max_velocity: 300'.length → after the 300 row
    const after300 = LIVE.indexOf('300') + 3;
    expect(liveToDisplayOffset(LIVE, built.display, built.ghostDisplayLines, after300))
      .toBe(built.display.indexOf('300') + 3);
  });

  it('maps display offsets back, collapsing the ghost span', () => {
    // caret at the start of the 300 row in DISPLAY = end of line 2 in live
    const dispStartOf300 = built.display.indexOf('max_velocity: 300');
    expect(displayToLiveOffset(built.display, built.ghostDisplayLines, dispStartOf300))
      .toBe(LIVE.indexOf('max_velocity: 300'));
    // caret INSIDE the ghost row maps to just below it (the live anchor)
    const midGhost = built.display.indexOf('600') + 1;
    expect(displayToLiveOffset(built.display, built.ghostDisplayLines, midGhost))
      .toBe(10); // just before the 300 row in live
  });

  it('is identity with no ghosts', () => {
    expect(displayToLiveOffset('abc\ndef', [], 5)).toBe(5);
    expect(liveToDisplayOffset('abc\ndef', 'abc\ndef', [], 5)).toBe(5);
  });

  it('caret survives a ghost appearing above it (the typing scenario)', () => {
    // User edits the ghost row content: caret was after 'max_velocity: 60' +
    // typed '1' at display offset 10+16+... compute through the real cycle.
    const typedDisplay = built.display.replace('max_velocity: 600', 'max_velocity: 601');
    const caretDisplay = typedDisplay.indexOf('601') + 3;
    // caret in live = the live prefix length up to the caret.
    const caretLive = liveFromDisplay(typedDisplay.slice(0, caretDisplay), built.ghosts).length;
    // After the ledger re-derives (new ghost 600 above the 601 line):
    const next = displayOf(FRAME, liveFromDisplay(typedDisplay, built.ghosts));
    const caretNext = liveToDisplayOffset(next.live, next.display, next.ghostDisplayLines, caretLive);
    expect(next.display.slice(0, caretNext)).toBe('[printer]\nmax_velocity: 600\nmax_velocity: 601');
  });
});

describe('line maps', () => {
  const built = displayOf(FRAME, LIVE);

  it('pushes live lines below the ghost down by the ghost count', () => {
    expect(liveLineToDisplayLine(built.ghosts, 1)).toBe(1);
    expect(liveLineToDisplayLine(built.ghosts, 2)).toBe(3); // 300 row
    expect(liveLineToDisplayLine(built.ghosts, 3)).toBe(4);
  });

  it('maps display rows back to live lines, ghosts to their anchor', () => {
    expect(displayLineToLiveLine(built.ghostDisplayLines, 1)).toBe(1);
    expect(displayLineToLiveLine(built.ghostDisplayLines, 2)).toBe(2); // ghost → anchor (the 300 row)
    expect(displayLineToLiveLine(built.ghostDisplayLines, 3)).toBe(2);
    expect(displayLineToLiveLine(built.ghostDisplayLines, 4)).toBe(3);
  });

  it('stays identity with no ghosts', () => {
    expect(liveLineToDisplayLine(new Map(), 42)).toBe(42);
    expect(displayLineToLiveLine([], 42)).toBe(42);
  });
});
