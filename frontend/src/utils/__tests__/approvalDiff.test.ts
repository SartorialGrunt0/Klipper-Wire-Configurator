import { describe, expect, it } from 'vitest';
import {
  buildApprovalDiffLines,
  foldApprovalCountdown,
  remainingApprovalSeconds,
  summarizeAdvisorySeverities,
  type ApprovalCountdownAnchor,
} from '../approvalDiff';
import { createConfigPatch, parsePatch, type DiffLine } from '../configDiff';

const BEFORE = `[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 1000
`;
const AFTER = `[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 3000
`;

describe('buildApprovalDiffLines', () => {
  it('classifies the changed line as removed + added (mini-diff look)', () => {
    const lines = buildApprovalDiffLines('printer.cfg', BEFORE, AFTER);
    const removed = lines.filter((l) => l.type === 'removed').map((l) => l.content);
    const added = lines.filter((l) => l.type === 'added').map((l) => l.content);
    expect(removed).toContain('max_accel: 1000');
    expect(added).toContain('max_accel: 3000');
    // Context lines exist (the mini-diff feel: header/context neutral).
    expect(lines.some((l) => l.type === 'context')).toBe(true);
  });

  it('identical texts produce no added/removed lines', () => {
    const lines = buildApprovalDiffLines('printer.cfg', BEFORE, BEFORE);
    expect(lines.some((l) => l.type === 'added' || l.type === 'removed')).toBe(false);
  });

  it('new-file diff (before empty) is all additions', () => {
    const lines = buildApprovalDiffLines('macros.cfg', '', '[gcode_macro X]\ngcode:\n    G28\n');
    expect(lines.every((l) => l.type !== 'removed')).toBe(true);
    expect(lines.some((l) => l.type === 'added' && l.content.includes('gcode_macro X'))).toBe(true);
  });

  it('caps long diffs with an explicit truncation line', () => {
    const bigBefore = Array.from({ length: 300 }, (_, i) => `p${i}: ${i}`).join('\n');
    const bigAfter = Array.from({ length: 300 }, (_, i) => `p${i}: ${i + 1}`).join('\n');
    const lines = buildApprovalDiffLines('big.cfg', bigBefore, bigAfter, 40);
    expect(lines.length).toBeLessThanOrEqual(41);
    expect(lines[lines.length - 1].content).toMatch(/more diff lines/);
  });
});

describe('remainingApprovalSeconds', () => {
  it('counts down from the server-reported remainder', () => {
    expect(remainingApprovalSeconds(90, 1000, 1000)).toBe(90);
    expect(remainingApprovalSeconds(90, 1000, 1000 + 12_000)).toBe(78);
  });

  it('clamps at zero and never goes negative or above the reported value', () => {
    expect(remainingApprovalSeconds(5, 0, 60_000)).toBe(0);
    expect(remainingApprovalSeconds(0, 0, 0)).toBe(0);
    // Clock skew (nowMs before receivedAt) must not inflate the number.
    expect(remainingApprovalSeconds(5, 10_000, 9_000)).toBe(5);
  });
});

describe('approval countdown anchor (the poll replaces the payload)', () => {
  // 90s backend window polled every second: each payload's timeoutSeconds is
  // the backend's CURRENT remainder, so the anchor must move with it.
  const polls = [
    { t: 0, remaining: 90 },
    { t: 45_000, remaining: 45 },
    { t: 60_000, remaining: 30 },
  ];

  it('a payload whose timeoutSeconds is already-remaining is not double-decremented', () => {
    const shown: number[] = [];
    let anchor: ApprovalCountdownAnchor | null = null;
    for (const { t, remaining } of polls) {
      anchor = foldApprovalCountdown(anchor, { approvalId: 'ap-1', timeoutSeconds: remaining }, t, false);
      if (!anchor) throw new Error('an idle poll must produce an anchor');
      shown.push(remainingApprovalSeconds(remaining, anchor.receivedAtMs, t));
    }
    // The display tracks the backend remainder exactly — the time the backend
    // already counted is not subtracted a second time.
    expect(shown).toEqual([90, 45, 30]);
    // ...and the local tick still interpolates BETWEEN polls.
    expect(remainingApprovalSeconds(30, 60_000, 62_400)).toBe(28);
    // The pre-fix wiring (anchor pinned at the first sighting) rendered 0 on
    // the t=45s payload with 45s still on the backend clock. This is the bug
    // the re-anchor removes.
    expect(remainingApprovalSeconds(45, 0, 45_000)).toBe(0);
  });

  it('a new approvalId starts a fresh countdown window', () => {
    const first = foldApprovalCountdown(null, { approvalId: 'ap-1', timeoutSeconds: 90 }, 0, false);
    const next = foldApprovalCountdown(first, { approvalId: 'ap-2', timeoutSeconds: 90 }, 30_000, false);
    expect(next).toEqual({ approvalId: 'ap-2', receivedAtMs: 30_000 });
    expect(remainingApprovalSeconds(90, next?.receivedAtMs ?? 0, 30_000)).toBe(90);
  });

  it('keeps the previous anchor while a decision POST is in flight', () => {
    const anchor = foldApprovalCountdown(null, { approvalId: 'ap-1', timeoutSeconds: 90 }, 0, false);
    expect(foldApprovalCountdown(anchor, { approvalId: 'ap-1', timeoutSeconds: 80 }, 10_000, true))
      .toBe(anchor);
    expect(foldApprovalCountdown(null, { approvalId: 'ap-1', timeoutSeconds: 80 }, 10_000, true))
      .toBeNull();
  });
});

describe('summarizeAdvisorySeverities', () => {
  it('counts by severity (case-insensitive)', () => {
    const counts = summarizeAdvisorySeverities([
      { severity: 'warning' },
      { severity: 'WARNING' },
      { severity: 'error' },
      { severity: 'info' },
    ]);
    expect(counts).toEqual({ error: 1, warning: 2, other: 1 });
  });

  it('missing/empty severities count as other', () => {
    const counts = summarizeAdvisorySeverities([{}, { severity: '' }]);
    expect(counts).toEqual({ error: 0, warning: 0, other: 2 });
  });

  it('empty list is all-zero (no badges)', () => {
    expect(summarizeAdvisorySeverities([])).toEqual({ error: 0, warning: 0, other: 0 });
  });
});

describe('approval card vs toolbar diff parity (Gate 4)', () => {
  // The toolbar DiffDialog pipeline, exactly as it composes there.
  const toolbarLines = (file: string, before: string, after: string) =>
    parsePatch(createConfigPatch(file, before, after, 'imported', 'current', 3));

  const changed = (lines: DiffLine[]) =>
    lines.filter((l) => l.type === 'added' || l.type === 'removed').map((l) => `${l.type}:${l.content}`);

  const cases: Array<[string, string, string]> = [
    // edit
    ['printer.cfg', BEFORE, AFTER],
    // new file (before empty)
    ['aux_fan.cfg', '', '[fan]\ncycle_time: 0.02\n'],
    // deleted file (after empty)
    ['old.cfg', '[gcode_macro X]\ngcode:\n    G28\n', ''],
    // multi-section edit with header context
    ['printer.cfg', BEFORE + '[extruder]\nnozzle_diameter: 0.4\n', BEFORE + '[extruder]\nnozzle_diameter: 0.6\nmax_extrude_only_distance: 100\n'],
  ];

  it.each(cases)('%s: card shows identical changed lines as the toolbar diff', (_f, before, after) => {
    const card = changed(buildApprovalDiffLines(_f, before, after));
    const toolbar = changed(toolbarLines(_f, before, after));
    expect(card).toEqual(toolbar);
  });

  it('header lines render in both (section headers visible)', () => {
    const lines = buildApprovalDiffLines('printer.cfg', BEFORE, BEFORE + '[extruder]\nnozzle_diameter: 0.4\n');
    expect(lines.some((l) => l.type === 'header')).toBe(true);
  });
});
