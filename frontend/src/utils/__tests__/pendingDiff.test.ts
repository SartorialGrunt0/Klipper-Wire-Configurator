import { describe, expect, it } from 'vitest';
import {
  PANE_DIFF_CONTEXT,
  buildPendingDiffModel,
  paneModeFor,
  selectionOverlapsChange,
  type PendingDiffModel,
} from '../pendingDiff';
import { APPROVAL_DIFF_MAX_LINES, buildApprovalDiffLines } from '../approvalDiff';
import { createConfigPatch, parsePatch } from '../configDiff';
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
