import { describe, expect, it } from 'vitest';
import {
  PANE_DIFF_CONTEXT,
  buildPendingDiffModel,
  addedRanges,
  liveLineForContentRow,
  livePendingLines,
  paneModeFor,
  selectionOverlapsChange,
  type PendingDiffModel,
} from '../pendingDiff';
import { APPROVAL_DIFF_MAX_LINES, buildApprovalDiffLines } from '../approvalDiff';
import { createConfigPatch, parsePatch } from '../configDiff';
import { buildUnreviewedDiffModel } from '../pendingDiff';
import type { ChangeSetRow } from '../changeSet';
import type { ApprovalCard } from '../../services/api';
import type { ChatReference } from '../chatReferences';

const BEFORE = `[printer]
kinematics: corexy
max_velocity: 300
max_accel: 8000
`;
const AFTER = `[printer]
kinematics: corexy
max_velocity: 300
max_accel: 12000
`;

const card = (over: Partial<ApprovalCard> = {}): ApprovalCard => ({
  approvalId: 'a1',
  file: 'printer.cfg',
  op: 'set_param',
  summary: 'set max_accel to 12000',
  diff: { file: 'printer.cfg', before: BEFORE, after: AFTER },
  advisories: [],
  timeoutSeconds: 90,
  ...over,
});

const lines = (startLine: number, endLine: number): ChatReference => ({
  id: `lines:printer.cfg:${startLine}-${endLine}`,
  kind: 'lines',
  file: 'printer.cfg',
  startLine,
  endLine,
  text: '',
});

describe('buildPendingDiffModel', () => {
  it('uses the card\'s builder, with the whole file as context', () => {
    const model = buildPendingDiffModel(card());
    expect(model).not.toBeNull();
    // Same builder + renderer as the card; the pane just widens the context
    // from the card's 2 lines to the entire file.
    expect(model!.lines).toEqual(
      parsePatch(createConfigPatch(
        'printer.cfg', BEFORE, AFTER, 'before', 'after', PANE_DIFF_CONTEXT,
      )),
    );
    expect(PANE_DIFF_CONTEXT).toBeGreaterThan(2);
  });

  it('shows the WHOLE file — untouched lines far from the change are present', () => {
    const before = [
      '# top of the file',
      '[printer]',
      'kinematics: corexy',
      ...Array.from({ length: 60 }, (_, i) => `filler_${i}: ${i}`),
      'max_accel: 8000',
      ...Array.from({ length: 20 }, (_, i) => `tail_${i}: ${i}`),
      '',
    ].join('\n');
    const after = before.replace('max_accel: 8000', 'max_accel: 12000');
    const model = buildPendingDiffModel(
      card({ diff: { file: 'printer.cfg', before, after } }),
    )!;
    const contents = model.lines.map((l) => l.content);
    const body = model.lines.filter((l) => l.type !== 'header').map((l) => l.content);
    expect(body[0]).toBe('# top of the file');
    expect(body[body.length - 1]).toBe('tail_19: 19');
    expect(contents).toContain('filler_0: 0');
    expect(contents).toContain('tail_19: 19');
    expect(model.added).toBe(1);
    expect(model.removed).toBe(1);
    // Every line of the file is represented (no hunk collapsing).
    expect(model.lines.filter((l) => l.type === 'header').length).toBe(1);
  });

  it('counts added/removed rows and finds the first changed row', () => {
    const model = buildPendingDiffModel(card())!;
    expect(model.added).toBe(1);
    expect(model.removed).toBe(1);
    expect(model.lines[model.firstChangedRow].type).toBe('removed');
  });

  it('maps the change onto the BEFORE file line numbers (editor coordinates)', () => {
    const model = buildPendingDiffModel(card())!;
    // max_accel is line 4 of the current text.
    expect(model.changedLines).toEqual([4]);
  });

  it('maps an APPENDED line onto its insertion point', () => {
    const before = '[gcode_macro PURGE]\ngcode:\n    G28\n';
    const after = '[gcode_macro PURGE]\ngcode:\n    G28\n    M117 Purging\n';
    const model = buildPendingDiffModel(card({
      op: 'patch_section',
      diff: { file: 'printer.cfg', before, after },
    }))!;
    expect(model.removed).toBe(0);
    expect(model.added).toBe(1);
    expect(model.changedLines).toEqual([4]);
  });

  it('is UNCAPPED where the card is capped, and carries no truncation row', () => {
    const before = Array.from({ length: 400 }, (_, i) => `param_${i}: ${i}`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `param_${i}: ${i + 1}`).join('\n');
    const model = buildPendingDiffModel(card({ diff: { file: 'f.cfg', before, after } }))!;
    const cardLines = buildApprovalDiffLines(
      'f.cfg', before, after, APPROVAL_DIFF_MAX_LINES,
    );
    expect(model.lines.length).toBeGreaterThan(cardLines.length);
    expect(model.lines.some((l) => l.content.includes('more diff lines'))).toBe(false);
  });

  it('returns null when the card carries no diff', () => {
    expect(buildPendingDiffModel(card({ diff: null }))).toBeNull();
  });

  it('carries the card identity for stale-response guards', () => {
    const model = buildPendingDiffModel(card({ approvalId: 'a7' }))!;
    expect(model.approvalId).toBe('a7');
    expect(model.file).toBe('printer.cfg');
    expect(model.op).toBe('set_param');
  });
});

describe('selectionOverlapsChange', () => {
  const model = buildPendingDiffModel(card())!;

  it('is true when the highlighted range covers a changed line', () => {
    expect(selectionOverlapsChange(model, lines(4, 4))).toBe(true);
    expect(selectionOverlapsChange(model, lines(1, 5))).toBe(true);
    expect(selectionOverlapsChange(model, lines(5, 4))).toBe(true); // reversed range
  });

  it('is false for a highlight that avoids the changed lines', () => {
    expect(selectionOverlapsChange(model, lines(1, 3))).toBe(false);
    expect(selectionOverlapsChange(model, lines(6, 9))).toBe(false);
  });

  it('is false for a bare caret (no selection reference) or another kind', () => {
    expect(selectionOverlapsChange(model, null)).toBe(false);
    expect(selectionOverlapsChange(model, { ...lines(4, 4), kind: 'section' })).toBe(false);
    expect(selectionOverlapsChange(model, { ...lines(4, 4), startLine: undefined })).toBe(false);
  });
});

describe('paneModeFor', () => {
  const model = buildPendingDiffModel(card())!;
  const base = { isActive: true, selection: null } as const;

  it('stays on the editor with no card, or when the text view is not showing', () => {
    expect(paneModeFor({ ...base, model: null, takeover: 'auto' })).toBe('editor');
    expect(paneModeFor({ model, takeover: 'auto', isActive: false, selection: null })).toBe('editor');
    // Even an explicit request cannot force the takeover from another view.
    expect(paneModeFor({ model, takeover: 'shown', isActive: false, selection: null })).toBe('editor');
  });

  it('takes over by default, including with a bare caret elsewhere', () => {
    expect(paneModeFor({ ...base, model, takeover: 'auto' })).toBe('diff');
    expect(paneModeFor({ ...base, model, takeover: 'auto', selection: lines(1, 2) })).toBe('diff');
  });

  it('shows the chip instead when the highlight covers the changed lines', () => {
    expect(paneModeFor({ ...base, model, takeover: 'auto', selection: lines(4, 6) })).toBe('chip');
  });

  it('lets the user override in both directions', () => {
    expect(paneModeFor({ ...base, model, takeover: 'shown', selection: lines(4, 6) })).toBe('diff');
    expect(paneModeFor({ ...base, model, takeover: 'hidden', selection: null })).toBe('chip');
  });
});

describe('model ↔ card agreement on non-op payloads', () => {
  it('keeps working when the card is a new-file write', () => {
    // The model reads ONLY card.diff — never pendingEdits — so an op whose
    // after-text is a whole new file is just rows with nothing removed.
    const model = buildPendingDiffModel(card({
      op: 'new_file',
      diff: { file: 'macros.cfg', before: '', after: '[gcode_macro X]\ngcode:\n    G28\n' },
    })) as PendingDiffModel;
    expect(model.removed).toBe(0);
    expect(model.changedLines).toEqual([1]);
  });
});

describe('buildUnreviewedDiffModel (post-hoc review rows)', () => {
  const row = (over: Partial<ChangeSetRow> = {}): ChangeSetRow => ({
    id: 'req-1:e0',
    file: 'printer.cfg',
    section: 'printer',
    key: 'max_accel',
    op: 'set_param',
    summary: 'set max_accel to 12000',
    added: 1,
    removed: 1,
    diffText: '-max_accel: 8000\n+max_accel: 12000',
    advisories: [],
    superseded: false,
    supersededBy: '',
    badge: { error: 0, warning: 0, other: 0 },
    label: 'printer.cfg / [printer] max_accel',
    requestId: 'req-1',
    ...over,
  });

  it('renders the rows as red/green lines, whichever chat made them', () => {
    const model = buildUnreviewedDiffModel([row()], 'printer.cfg');
    expect(model).not.toBeNull();
    expect(model?.lines.map((line) => line.type)).toEqual(['removed', 'added']);
    expect(model?.lines[0].content).toBe('max_accel: 8000');
    expect(model?.added).toBe(1);
    expect(model?.removed).toBe(1);
    expect(model?.firstChangedRow).toBe(0);
    expect(model?.op).toBe('[printer] max_accel');
  });

  it('is null when there is nothing pending for that file', () => {
    expect(buildUnreviewedDiffModel([], 'printer.cfg')).toBeNull();
    expect(buildUnreviewedDiffModel([row()], '')).toBeNull();
  });

  // ── The frame: the WHOLE document (Sir, 2026-10-03) ──────────────
  // The pane stands in for the buffer, so it shows all of the file with the
  // changes marked — not the neighbourhood of each hunk. `before` is the
  // server's pre-review text; `after` is the text the editor is holding.
  const DOC_BEFORE = `[printer]
kinematics: corexy
max_velocity: 300
max_accel: 8000

[stepper_x]
microsteps: 16
`;
  const DOC_AFTER = DOC_BEFORE.replace('max_accel: 8000', 'max_accel: 12000');

  it('renders the WHOLE document when a frame is supplied', () => {
    const model = buildUnreviewedDiffModel([row()], 'printer.cfg', {
      before: DOC_BEFORE, after: DOC_AFTER,
    }) as PendingDiffModel;
    const contents = model.lines.map((line) => line.content);
    expect(contents[0]).toMatch(/^@@/);           // one hunk spanning the file
    expect(contents[1]).toBe('[printer]');        // the file's first line
    expect(contents[contents.length - 1]).toBe('microsteps: 16');  // and its last
    // Lines the change never touched are on screen too — the whole reason the
    // row's own diffText cannot be what the pane renders.
    expect(contents).toContain('kinematics: corexy');
    expect(contents).toContain('[stepper_x]');
    expect(model.lines.filter((line) => line.type === 'context')).toHaveLength(6);
    expect(model.added).toBe(1);
    expect(model.removed).toBe(1);
    expect(model.changedLines).toEqual([4]);      // before-file line space
  });

  it('counts what it draws, so a decided-but-unsaved edit stays in the header', () => {
    // Design A (Sir, 2026-10-03): the frame is the document before the review,
    // so an edit that was KEPT (the text does not change on keep) is still a
    // mark on screen while it is unsaved. The badge counts the rows rendered.
    const after = DOC_AFTER.replace('microsteps: 16', 'microsteps: 32');
    const model = buildUnreviewedDiffModel([row()], 'printer.cfg', {
      before: DOC_BEFORE, after,
    }) as PendingDiffModel;
    expect(model.added).toBe(2);   // both edits are in the document…
    expect(model.removed).toBe(2);
    expect(row().added).toBe(1);   // …though one row is no longer undecided
  });

  it('keeps the rows\' own diffs as the path when no frame is supplied', () => {
    // A payload from a server that predates the frame still renders.
    const model = buildUnreviewedDiffModel([row()], 'printer.cfg') as PendingDiffModel;
    expect(model.lines.map((line) => line.type)).toEqual(['removed', 'added']);
  });

  it('concatenates every pending op of the file, in order', () => {
    const model = buildUnreviewedDiffModel([
      row(),
      row({ id: 'req-1:e1', section: 'stepper_x', key: 'microsteps',
        diffText: '-microsteps: 16\n+microsteps: 32' }),
    ], 'printer.cfg');
    expect(model?.lines).toHaveLength(4);
    expect(model?.added).toBe(2);
    expect(model?.op).toBe('[printer] max_accel, [stepper_x] microsteps');
  });

  it('keeps a stable identity per file so a decision does not re-take the pane', () => {
    const before = buildUnreviewedDiffModel([row()], 'printer.cfg');
    const after = buildUnreviewedDiffModel([row({ id: 'req-1:e1' })], 'printer.cfg');
    expect(before?.approvalId).toBe(after?.approvalId);
    expect(before?.approvalId).toBe('changeset:printer.cfg');
  });

  it('reports the lines the change touches (the highlight-overlap guard)', () => {
    const model = buildUnreviewedDiffModel([
      row({ diffText: '@@ -4,3 +4,3 @@\n context\n-max_accel: 8000\n+max_accel: 12000' }),
    ], 'printer.cfg');
    expect(model?.changedLines).toEqual([5]);
  });
});

describe('livePendingLines', () => {
  it('marks nothing when the frame equals the live text', () => {
    const marks = livePendingLines(BEFORE, BEFORE);
    expect(marks.addedLines.size).toBe(0);
    expect(marks.removedAnchors.size).toBe(0);
  });

  it('marks an added line and anchors a removal to the line it would return to', () => {
    const frame = 'a\nb\nc\n';
    const live = 'a\nB\nc\nd\n';
    const marks = livePendingLines(frame, live);
    expect([...marks.addedLines]).toEqual([2, 4]); // 'B' added; 'd' added
    // 'b' removed; the live line following the deletion is 'c' at line 3.
    expect(marks.removedAnchors.get(3)).toBe(1);
  });

  it('tracks the marks as the user hand-edits ABOVE a pending change', () => {
    // The frame is the pre-review text; the live text grew a line at the top.
    // The pending mark must ride the added line, not stay at the old number.
    const frame = 'x = 1\n';
    const pending = 'x = 2\n';
    const marks1 = livePendingLines(frame, pending);
    expect([...marks1.addedLines]).toEqual([1]);
    const handEdited = '# note\nx = 2\n';
    const marks2 = livePendingLines(frame, handEdited);
    expect([...marks2.addedLines]).toEqual([1, 2]); // note (human) + x = 2 (AI)
  });

  it('anchors an end-of-file deletion to the last live line', () => {
    const marks = livePendingLines('a\nb\nc\n', 'a\nb\n');
    expect(marks.removedAnchors.get(2)).toBe(1);
  });

  it('anchors everything to line 1 when the live text is empty', () => {
    const marks = livePendingLines('a\nb\n', '');
    expect(marks.removedAnchors.get(1)).toBe(2);
  });

  it('counts a multi-line chunk, newline-terminated or not', () => {
    const marks = livePendingLines('a\n', 'a\nb\nc');
    expect([...marks.addedLines]).toEqual([2, 3]);
  });
});

describe('liveLineForContentRow', () => {
  const rows = parsePatch(createConfigPatch('f', 'a\nb\nc\n', 'a\nB\nc\n'));
  const contentRows = rows.filter((r) => r.type !== 'header');
  // content rows: context 'a', removed 'b', added 'B', context 'c', (EOF ctx)

  it('maps rows before a removal to their live lines', () => {
    expect(liveLineForContentRow(contentRows, 0)).toBe(1); // 'a'
  });

  it('does not let a removed row advance the live line count', () => {
    // row 2 is the added 'B': one context line ('a') lives before it.
    expect(liveLineForContentRow(contentRows, 2)).toBe(2);
    // the trailing context 'c' sits on live line 3 despite the removal above.
    expect(liveLineForContentRow(contentRows, 3)).toBe(3);
  });
});

describe('paneModeFor with the live (change-set) path', () => {
  const model = buildPendingDiffModel(card())!;
  const base = { isActive: true } as const;

  it('reviews in place, even while the highlight covers the changed lines', () => {
    // The tints paint the very lines the reader is pointing at — there is no
    // pane to take away from them, so the chip rule does not apply.
    expect(paneModeFor({ ...base, model, takeover: 'auto', selection: null, live: true })).toBe('review');
    expect(paneModeFor({ ...base, model, takeover: 'auto', selection: lines(4, 4), live: true })).toBe('review');
  });

  it('keeps the explicit overrides: chip click shows the read-only diff, Back to editing chips', () => {
    expect(paneModeFor({ ...base, model, takeover: 'shown', selection: null, live: true })).toBe('diff');
    expect(paneModeFor({ ...base, model, takeover: 'hidden', selection: null, live: true })).toBe('chip');
  });

  it('never reviews from another view or with no model', () => {
    expect(paneModeFor({ model, takeover: 'auto', isActive: false, selection: null, live: true })).toBe('editor');
    expect(paneModeFor({ model: null, takeover: 'auto', isActive: true, selection: null, live: true })).toBe('editor');
  });
});

describe('addedRanges', () => {
  it('merges contiguous lines into one run', () => {
    expect(addedRanges(new Set([2, 3, 4]))).toEqual([[2, 4]]);
  });

  it('splits runs at gaps and handles the empty set', () => {
    expect(addedRanges(new Set([1, 3, 4, 9]))).toEqual([[1, 1], [3, 4], [9, 9]]);
    expect(addedRanges(new Set())).toEqual([]);
  });

  it('sorts unsorted input', () => {
    expect(addedRanges(new Set([7, 2, 1]))).toEqual([[1, 2], [7, 7]]);
  });
});
