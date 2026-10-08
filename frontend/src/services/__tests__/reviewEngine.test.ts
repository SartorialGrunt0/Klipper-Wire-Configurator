import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  parseConfigText: vi.fn(async (text: string, file: string) => ({
    config: { filename: file, raw_text: text, sections: [] },
  })),
  exportConfig: vi.fn(async (cf: { raw_text?: string }) => cf.raw_text ?? ''),
  validateConfig: vi.fn(async () => ({ has_errors: false, has_warnings: false, errors: [] })),
  validateProject: vi.fn(async () => ({})),
}));

import * as api from '@/services/api';
import type { ChangeSetPayload } from '@/services/api';
import { useChangeSetStore } from '@/stores/changeSetStore';
import { useConfigStore } from '@/stores/configStore';
import {
  framesFromChangeSet,
  groupLedgerSections,
  keepAll,
  keepAllIn,
  keepRun,
  ledgerFor,
  ledgerFrom,
  mirrorRowsFor,
  reviewStops,
  setLiveApplier,
  stopsFrom,
  undoAllIn,
  undoRun,
} from '@/services/reviewEngine';
import type { LedgerSnapshot } from '@/services/reviewEngine';

const L = (...lines: string[]) => lines.join('\n');

const snap = (over: Partial<LedgerSnapshot> = {}): LedgerSnapshot => ({
  reviewFrames: {},
  liveTexts: {},
  configFiles: {},
  ...over,
});

const cfg = (raw_text: string) => ({
  filename: 'printer.cfg',
  sections: [],
  includes: [],
  header_comments: [],
  raw_text,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChangeSetStore.getState().clear();
  useConfigStore.setState({
    configFiles: {},
    liveTexts: {},
    originalTexts: {},
    activeFile: 'printer.cfg',
    isDirty: false,
  });
  setLiveApplier('', null);
});

// ── The pure reading half ────────────────────────────────────────────

describe('ledgerFrom — the review is diff(FRAME, LIVE)', () => {
  it('no frame, no review', () => {
    expect(ledgerFrom(snap())).toEqual([]);
  });

  it('a frame against the live text is one run per difference', () => {
    const files = ledgerFrom(snap({
      reviewFrames: { 'printer.cfg': L('a', 'c') },
      liveTexts: { 'printer.cfg': L('a', 'b', 'c') },
    }));
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('printer.cfg');
    expect(files[0].created).toBe(false);
    expect(files[0].runs).toHaveLength(1);
    expect(files[0].runs[0].added).toEqual(['b']);
    expect(files[0].runs[0].liveStart).toBe(2);
  });

  it('falls back to raw_text when there is no live text for the file', () => {
    const files = ledgerFrom(snap({
      reviewFrames: { 'printer.cfg': L('a', 'c') },
      configFiles: { 'printer.cfg': cfg(L('a', 'b', 'c')) },
    }));
    expect(files[0].live).toBe(L('a', 'b', 'c'));
    expect(files[0].runs[0].added).toEqual(['b']);
  });

  it('the editor buffer beats a stale raw_text', () => {
    const files = ledgerFrom(snap({
      reviewFrames: { 'printer.cfg': L('a', 'c') },
      liveTexts: { 'printer.cfg': L('a', 'x', 'c') },
      configFiles: { 'printer.cfg': cfg(L('a', 'b', 'c')) },
    }));
    expect(files[0].runs[0].added).toEqual(['x']);
  });

  it('a created file (null frame) is one green run over the whole text', () => {
    const files = ledgerFrom(snap({
      reviewFrames: { 'new.cfg': null },
      liveTexts: { 'new.cfg': L('x', 'y') },
    }));
    expect(files).toHaveLength(1);
    expect(files[0].created).toBe(true);
    expect(files[0].runs).toHaveLength(1);
    expect(files[0].runs[0].added).toEqual(['x', 'y']);
  });

  it('a file whose frame equals its live text is not in the review', () => {
    expect(ledgerFrom(snap({
      reviewFrames: { 'printer.cfg': L('a', 'b') },
      liveTexts: { 'printer.cfg': L('a', 'b') },
    }))).toEqual([]);
  });

  it('a created file still present is kept even with no runs', () => {
    const files = ledgerFrom(snap({
      reviewFrames: { 'new.cfg': null },
      configFiles: { 'new.cfg': cfg('') },
    }));
    expect(files).toHaveLength(1);
    expect(files[0].created).toBe(true);
    expect(files[0].runs).toEqual([]);
  });
});

describe('stopsFrom / groupLedgerSections', () => {
  const files = ledgerFrom(snap({
    reviewFrames: { 'printer.cfg': L('[printer]', 'max_accel: 1000', '[stepper_x]', 'microsteps: 16') },
    liveTexts: { 'printer.cfg': L('[printer]', 'max_accel: 3000', '[stepper_x]', 'microsteps: 32') },
  }));

  it('a stop names the run key, file and its live line', () => {
    const stops = stopsFrom(files);
    expect(stops).toHaveLength(2);
    expect(stops[0].key).toBe(files[0].runs[0].key);
    expect(stops[0].file).toBe('printer.cfg');
    expect(stops[0].line).toBe(files[0].runs[0].liveStart);
  });

  it('groups each run with its section label and preview', () => {
    const [file] = groupLedgerSections(files);
    expect(file.file).toBe('printer.cfg');
    expect(file.added).toBe(2);
    expect(file.removed).toBe(2);
    expect(file.runs.map((run) => run.label)).toEqual(['[printer]', '[stepper_x]']);
    expect(file.runs[0].preview).toBe('max_accel: 3000');
    expect(file.runs[0].key).toBe(files[0].runs[0].key);
    expect(file.runs[0].run.added).toEqual(['max_accel: 3000']);
  });

  it('a pure deletion previews its first removed line', () => {
    const deleted = ledgerFrom(snap({
      reviewFrames: { 'printer.cfg': L('a', 'gone', 'c') },
      liveTexts: { 'printer.cfg': L('a', 'c') },
    }));
    expect(groupLedgerSections(deleted)[0].runs[0].preview).toBe('gone');
  });
});

describe('mirrorRowsFor — the mirror rows and their line numbers (Sir 2026-10-08)', () => {
  const sections = (frames: Record<string, string | null>, live: Record<string, string>) =>
    groupLedgerSections(ledgerFrom(snap({ reviewFrames: frames, liveTexts: live })))[0];

  it('a replacement reads old-red at the FRAME number over new-green at the LIVE number', () => {
    // frame line 5 changed → live line 5 too (same position, different text).
    const file = sections(
      { 'printer.cfg': L('a', 'b', 'max_velocity: 500', 'c') },
      { 'printer.cfg': L('a', 'b', 'max_velocity: 300', 'c') },
    );
    const rows = mirrorRowsFor(file);
    expect(rows.map((r) => r.type)).toEqual(['header', 'removed', 'added']);
    expect(rows[1]).toMatchObject({ content: 'max_velocity: 500', line: 3 }); // frame number
    expect(rows[2]).toMatchObject({ content: 'max_velocity: 300', line: 3 }); // live number
    expect(rows[0].line).toBeNull();
  });

  it('an insertion shifts the numbering: red keeps the frame number, green the live', () => {
    // A line inserted at 2 means everything after moved: frame 3 == live 4.
    const file = sections(
      { 'printer.cfg': L('a', 'x = 1', 'b') },
      { 'printer.cfg': L('a', 'new = 0', 'x = 2', 'b') },
    );
    const rows = mirrorRowsFor(file);
    // One run: removed x = 1 (frame line 2) + added new = 0 / x = 2 (live 2, 3).
    expect(rows.map((r) => [r.type, r.line])).toEqual([
      ['header', null],
      ['removed', 2],
      ['added', 2],
      ['added', 3],
    ]);
  });

  it('a pure deletion numbers only the red row, at its frame line', () => {
    const file = sections(
      { 'printer.cfg': L('a', 'gone', 'c') },
      { 'printer.cfg': L('a', 'c') },
    );
    const rows = mirrorRowsFor(file);
    expect(rows.map((r) => [r.type, r.line])).toEqual([
      ['header', null],
      ['removed', 2],
    ]);
  });

  it('a created-but-empty file still gets a row for its Keep/Undo', () => {
    const files = ledgerFrom(snap({ reviewFrames: { 'new.cfg': null }, liveTexts: { 'new.cfg': '' } }));
    const file = groupLedgerSections(files)[0];
    const rows = mirrorRowsFor(file);
    expect(rows).toEqual([{ type: 'context', content: 'new.cfg (empty)', line: null }]);
  });

  it('multi-run files: each run gets its own header and per-space numbers', () => {
    const file = sections(
      { 'printer.cfg': L('a', 'b', 'c', 'd', 'e', 'f') },
      { 'printer.cfg': L('a', 'B', 'c', 'd', 'e', 'F') },
    );
    const rows = mirrorRowsFor(file);
    expect(rows.filter((r) => r.type === 'header')).toHaveLength(2);
    expect(rows.map((r) => [r.type, r.content, r.line])).toEqual([
      ['header', 'printer.cfg', null],
      ['removed', 'b', 2],
      ['added', 'B', 2],
      ['header', 'printer.cfg', null],
      ['removed', 'f', 6],
      ['added', 'F', 6],
    ]);
  });
});

describe('framesFromChangeSet', () => {
  it('beforeText is the frame and createdFiles are null', () => {
    const payload: ChangeSetPayload = {
      edits: [],
      files: [
        { file: 'printer.cfg', added: 0, removed: 0, sections: [], beforeText: 'OLD' },
        { file: 'new.cfg', added: 1, removed: 0, sections: [], beforeText: '' },
      ],
      totalAdded: 1,
      totalRemoved: 0,
      createdFiles: ['new.cfg'],
    };
    expect(framesFromChangeSet(payload)).toEqual({ 'printer.cfg': 'OLD', 'new.cfg': null });
  });

  it('is empty for no payload', () => {
    expect(framesFromChangeSet(null)).toEqual({});
  });
});

// ── The decisions ────────────────────────────────────────────────────

const seed = (file: string, frame: string, live: string) => {
  useChangeSetStore.setState({ reviewFrames: { [file]: frame } });
  useConfigStore.setState({ liveTexts: { [file]: live } });
};

describe('keepRun / keepAllIn / keepAll', () => {
  it('keep freezes the live run into the frame; the run leaves the diff', () => {
    seed('printer.cfg', L('a', 'c'), L('a', 'b', 'c'));
    const [run] = ledgerFor('printer.cfg');
    keepRun('printer.cfg', run.key);
    expect(useChangeSetStore.getState().reviewFrames['printer.cfg']).toBe(L('a', 'b', 'c'));
    expect(ledgerFor('printer.cfg')).toEqual([]);
  });

  it('keeps only the named run, leaving the other pending', () => {
    seed('printer.cfg', L('a', 'b', 'c', 'd', 'e'), L('A', 'b', 'c', 'd', 'E'));
    const runs = ledgerFor('printer.cfg');
    keepRun('printer.cfg', runs[0].key);
    const left = ledgerFor('printer.cfg');
    expect(left).toHaveLength(1);
    expect(left[0].removed).toEqual(['e']);
  });

  it('a keep with an unknown key changes nothing', () => {
    seed('printer.cfg', L('a', 'c'), L('a', 'b', 'c'));
    keepRun('printer.cfg', 'nope');
    expect(useChangeSetStore.getState().reviewFrames['printer.cfg']).toBe(L('a', 'c'));
    expect(ledgerFor('printer.cfg')).toHaveLength(1);
  });

  it('keepAllIn keeps every run of one file', () => {
    seed('printer.cfg', L('a', 'b'), L('A', 'B'));
    keepAllIn('printer.cfg');
    expect(useChangeSetStore.getState().reviewFrames['printer.cfg']).toBe(L('A', 'B'));
  });

  it('keepAll keeps every file', () => {
    useChangeSetStore.setState({ reviewFrames: { 'a.cfg': L('a'), 'b.cfg': L('x') } });
    useConfigStore.setState({ liveTexts: { 'a.cfg': L('A'), 'b.cfg': L('X') } });
    keepAll();
    expect(useChangeSetStore.getState().reviewFrames).toEqual({ 'a.cfg': 'A', 'b.cfg': 'X' });
  });

  it('keeping a created file freezes its whole text as the frame', () => {
    useChangeSetStore.setState({ reviewFrames: { 'new.cfg': null } });
    useConfigStore.setState({ liveTexts: { 'new.cfg': L('x', 'y') } });
    keepAllIn('new.cfg');
    expect(useChangeSetStore.getState().reviewFrames['new.cfg']).toBe(L('x', 'y'));
  });
});

describe('undoRun / undoAllIn', () => {
  it('undo in the ACTIVE file hands the frame version to the applier', async () => {
    seed('printer.cfg', L('a', 'c'), L('a', 'b', 'c'));
    const applied: string[] = [];
    setLiveApplier('printer.cfg', (text) => applied.push(text));
    const [run] = ledgerFor('printer.cfg');
    await undoRun('printer.cfg', run.key);
    expect(applied).toEqual([L('a', 'c')]);
    expect(useConfigStore.getState().liveTexts['printer.cfg']).toBe(L('a', 'c'));
    // The frame is the pre-review state; an undo never touches it.
    expect(useChangeSetStore.getState().reviewFrames['printer.cfg']).toBe(L('a', 'c'));
  });

  it('undo in an INACTIVE file writes the model through the shared apply path', async () => {
    useChangeSetStore.setState({ reviewFrames: { 'printer.cfg': L('a', 'c') } });
    useConfigStore.setState({
      configFiles: { 'printer.cfg': cfg(L('a', 'b', 'c')) },
      liveTexts: {},
    });
    const [run] = ledgerFor('printer.cfg');
    await undoRun('printer.cfg', run.key);
    expect(api.parseConfigText).toHaveBeenCalled();
    expect(useConfigStore.getState().configFiles['printer.cfg'].raw_text).toBe(L('a', 'c'));
  });

  it('an undo that restores the on-disk text clears the dirty flag', async () => {
    useChangeSetStore.setState({ reviewFrames: { 'printer.cfg': L('a', 'c') } });
    useConfigStore.setState({
      configFiles: { 'printer.cfg': cfg(L('a', 'b', 'c')) },
      originalTexts: { 'printer.cfg': L('a', 'c') },
      isDirty: true,
    });
    await undoAllIn('printer.cfg');
    expect(useConfigStore.getState().configFiles['printer.cfg'].raw_text).toBe(L('a', 'c'));
    expect(useConfigStore.getState().isDirty).toBe(false);
  });

  it('undoing a review-created file removes the file and its frame', async () => {
    useChangeSetStore.setState({ reviewFrames: { 'new.cfg': null } });
    useConfigStore.setState({
      configFiles: { 'new.cfg': cfg(L('x', 'y')), 'printer.cfg': cfg(L('a')) },
      activeFile: 'printer.cfg',
    });
    const [run] = ledgerFor('new.cfg');
    await undoRun('new.cfg', run.key);
    expect(useConfigStore.getState().configFiles['new.cfg']).toBeUndefined();
    expect('new.cfg' in useChangeSetStore.getState().reviewFrames).toBe(false);
  });

  it('undo with an unknown key changes nothing', async () => {
    seed('printer.cfg', L('a', 'c'), L('a', 'b', 'c'));
    await undoRun('printer.cfg', 'nope');
    expect(useConfigStore.getState().liveTexts['printer.cfg']).toBe(L('a', 'b', 'c'));
  });

  it('undoAllIn restores the whole frame into the live text', async () => {
    seed('printer.cfg', L('one', 'two', 'three'), L('ONE', 'two', 'THREE'));
    await undoAllIn('printer.cfg');
    expect(useConfigStore.getState().liveTexts['printer.cfg']).toBe(L('one', 'two', 'three'));
  });
});

describe('reviewStops (store-reading)', () => {
  it('walks the live ledger', () => {
    seed('printer.cfg', L('a', 'c'), L('a', 'b', 'c'));
    const stops = reviewStops();
    expect(stops).toHaveLength(1);
    expect(stops[0].file).toBe('printer.cfg');
    expect(stops[0].line).toBe(2);
  });
});
