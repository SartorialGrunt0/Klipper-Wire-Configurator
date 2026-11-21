/**
 * W6 — conversation work-ledger: pure derivation tests.
 *
 * The ledger is the action record the model cannot see today: staged
 * sections and their verdicts (kept / undone / failed), names only, no
 * payloads. Rows derive from TWO sources with different guarantees:
 *
 *  - write-tool trace (`config_edit` / `config_write` in stored
 *    `toolCalls`): staged + failed rows. The `output` is the MODEL-FACING
 *    harness text (services/ai_edit_tools grammar), NOT JSON:
 *      single success : `"{name} applied — {summary}…"`
 *      single failure : `"{name} FAILED: {first-line error}"`
 *      batch          : `"{name} applied A of B ops — …"` + per-group
 *                       failure lines `- op[i(-j)] {op} [section]: {err}`
 *    Only these heads classify; unknown shapes produce NO row (absence
 *    never claims anything — a ledger line is a hard assertion).
 *
 *  - decision events (kept/undone): NOT derivable from state (the review
 *    ledger splices silently), so they arrive from the W6 store. They
 *    overlay staged rows by (file, section), later-verdict-wins, and only
 *    when recorded at or after the staging turn.
 *
 * Turn bucketing: user-message boundaries in the sent trail (which
 * INCLUDES the current message), so the previous turn's rows carry
 * turnOffset 1. Cap: ~10 turns, oldest dropped (law, not config).
 */
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../stores/aiStore';
import {
  buildWorkLedger,
  countUserTurns,
  WORK_LEDGER_MAX_TURNS,
  type WorkLedgerDecision,
} from '../chatWorkLedger';

// ── Fixtures in the exact backend harness grammar ────────────────────

const SINGLE_OK = [
  "config_edit applied — set 'red' in [led]",
  'Change is STAGED for the user\u2019s review (not saved).',
].join('\n');

const SINGLE_FAIL = [
  'config_edit FAILED: section [led] not found in printer.cfg',
  'Did you mean [leds]?',
].join('\n');

const BATCH_MIXED = [
  'config_edit applied 2 of 3 ops — applied ops are committed; failed ops are not',
  "Changes are STAGED for the user\u2019s review (not saved).",
  'Failed ops (fix ONLY these and re-send them):',
  "- op[2] set_param [pid_kp]: Unknown parameter 'pid_kp' — Klipper reads no such option",
].join('\n');

const BATCH_GROUPED_FAILS = [
  'config_edit applied 0 of 3 ops — applied ops are committed; failed ops are not',
  "Changes are STAGED for the user\u2019s review (not saved).",
  'Failed ops (fix ONLY these and re-send them):',
  '- op[0-2] set_param [extruder]: Unknown parameter (3 ops)',
].join('\n');

const WRITE_OK = 'config_write applied — created fan_generic.cfg\nSTAGED';

const assistant = (toolCalls: ChatMessage['toolCalls']): ChatMessage => ({
  role: 'assistant',
  content: 'done',
  toolCalls,
});
const user = (content: string): ChatMessage => ({ role: 'user', content });

const call = (name: string, args: unknown, output: string) => ({
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
  output,
});

// ── Classification of the write-tool grammar ─────────────────────────

describe('buildWorkLedger — harness-grammar classification', () => {
  it('single success → one pending row per section', () => {
    const rows = buildWorkLedger([
      user('make the LED red'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led', key: 'red', value: '1' }, SINGLE_OK)]),
      user('next question'),
    ], []);
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 1, file: 'printer.cfg', section: 'led', verdict: 'pending' },
    ]);
  });

  it('bracketed section names normalize identically on both sides', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'add_section', section: '[gcode_macro X]' }, SINGLE_OK)]),
      user('y'),
    ], []);
    expect(rows[0].section).toBe('gcode_macro X');
  });

  it('rename_section rows carry the NEW section (that is what the review shows)', () => {
    const rows = buildWorkLedger([
      user('rename'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'rename_section', section: 'old_name', new_section: 'new_name' }, SINGLE_OK)]),
      user('y'),
    ], []);
    expect(rows[0].section).toBe('new_name');
  });

  it('config_write → file-level row with empty section', () => {
    const rows = buildWorkLedger([
      user('create a fan file'),
      assistant([call('config_write', { file: 'fan_generic.cfg', content: '[fan_generic fan_cool]\n' }, WRITE_OK)]),
      user('y'),
    ], []);
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 1, file: 'fan_generic.cfg', section: '', verdict: 'pending' },
    ]);
  });

  it('single FAILED → failed row with the first error line as detail', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, SINGLE_FAIL)]),
      user('y'),
    ], []);
    expect(rows).toEqual([
      {
        turnOffset: 1,
        turnOrdinal: 1,
        file: 'printer.cfg',
        section: 'led',
        verdict: 'failed',
        detail: 'section [led] not found in printer.cfg',
      },
    ]);
  });

  it('batch mixed → applied sections pending, failed section failed', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', {
        file: 'printer.cfg',
        ops: [
          { op: 'set_param', section: 'stepper', key: 'a', value: '1' },
          { op: 'set_param', section: 'fan', key: 'b', value: '2' },
          { op: 'set_param', section: 'pid_kp', key: 'c', value: '3' },
        ],
      }, BATCH_MIXED)]),
      user('y'),
    ], []);
    const bySection = Object.fromEntries(rows.map((r) => [r.section, r.verdict]));
    expect(bySection).toEqual({ stepper: 'pending', fan: 'pending', pid_kp: 'failed' });
  });

  it('batch grouped failure range → the bracketed section still flags failed', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', {
        file: 'printer.cfg',
        ops: [
          { op: 'set_param', section: 'extruder', key: 'a', value: '1' },
          { op: 'set_param', section: 'extruder', key: 'b', value: '2' },
          { op: 'set_param', section: 'extruder', key: 'c', value: '3' },
        ],
      }, BATCH_GROUPED_FAILS)]),
      user('y'),
    ], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe('extruder');
    expect(rows[0].verdict).toBe('failed');
  });

  it('same section failed then re-staged (retry) later in the turn → last event wins', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([
        call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, SINGLE_FAIL),
        call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led', key: 'red', value: '1' }, SINGLE_OK),
      ]),
      user('y'),
    ], []);
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 1, file: 'printer.cfg', section: 'led', verdict: 'pending' },
    ]);
  });
});

// ── Non-claims: nothing is invented ──────────────────────────────────

describe('buildWorkLedger — absence never claims', () => {
  it('non-write tools produce no rows', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([
        call('read_user_config', { file: 'printer.cfg' }, '{"ok":true}'),
        call('validate_macro', { macro: 'X' }, 'macro OK'),
      ]),
      user('y'),
    ], []);
    expect(rows).toEqual([]);
  });

  it('unknown output shape produces no row (truncation heads survive, shapes do not)', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, 'some other harness text entirely')]),
      user('y'),
    ], []);
    expect(rows).toEqual([]);
  });

  it('unparseable arguments produce no row', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', '{"file": "printer.cfg", "ops": [{', SINGLE_OK)]),
      user('y'),
    ], []);
    expect(rows).toEqual([]);
  });

  it('no write calls at all → empty ledger', () => {
    expect(buildWorkLedger([user('hi'), assistant([]), user('yo')], [])).toEqual([]);
    expect(buildWorkLedger([], [])).toEqual([]);
  });
});

// ── Decision overlay ─────────────────────────────────────────────────

describe('buildWorkLedger — decision overlay', () => {
  const staged = [
    user('stage two'),
    assistant([call('config_edit', {
      file: 'printer.cfg',
      ops: [{ op: 'set_param', section: 'led' }, { op: 'set_param', section: 'fan' }],
    }, 'config_edit applied 2 of 2 ops — all ops committed')]),
  ];
  const send = (decisions: WorkLedgerDecision[]) =>
    buildWorkLedger([...staged, user('why')], decisions);

  it('kept / undone overlay onto the staged row', () => {
    const rows = send([
      { file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1 },
      { file: 'printer.cfg', section: 'fan', verdict: 'undone', turnIndex: 1 },
    ]);
    const bySection = Object.fromEntries(rows.map((r) => [r.section, r.verdict]));
    expect(bySection).toEqual({ led: 'kept', fan: 'undone' });
  });

  it('later decision wins (kept then undone reads undone)', () => {
    const rows = send([
      { file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1 },
      { file: 'printer.cfg', section: 'led', verdict: 'undone', turnIndex: 1 },
    ]);
    expect(rows.find((r) => r.section === 'led')?.verdict).toBe('undone');
  });

  it('a decision recorded BEFORE the staging turn does not apply', () => {
    // turnIndex 0 decisions predate the (turnOrdinal 1) staging event.
    const rows = send([
      { file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 0 },
    ]);
    expect(rows.find((r) => r.section === 'led')?.verdict).toBe('pending');
  });

  it('decisions attach to the LATEST staging (re-stage after undo → pending again)', () => {
    const rows = buildWorkLedger([
      user('a'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, SINGLE_OK)]),
      user('b'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, SINGLE_OK)]),
      user('c'),
    ], [
      { file: 'printer.cfg', section: 'led', verdict: 'undone', turnIndex: 1 },
    ]);
    // The undo (turn 1) applies to the first staging only; the second
    // staging (turn 2) has no decision → pending. ONE row per
    // (file, section) — the newest staging wins, and its ABSOLUTE
    // turnOrdinal is the turn that staged it (C1).
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 2, file: 'printer.cfg', section: 'led', verdict: 'pending' },
    ]);
  });

  it('file-level decision matches a section-level row when either side is empty', () => {
    const rows = buildWorkLedger([
      user('create'),
      assistant([call('config_write', { file: 'fan.cfg', content: '[fan_generic f]' }, WRITE_OK)]),
      user('y'),
    ], [
      { file: 'fan.cfg', section: '', verdict: 'undone', turnIndex: 1 },
    ]);
    expect(rows[0].verdict).toBe('undone');
  });

  it('decisions for sections never staged are ignored (no orphan rows)', () => {
    const rows = send([
      { file: 'printer.cfg', section: 'ghost', verdict: 'kept', turnIndex: 1 },
    ]);
    expect(rows.some((r) => r.section === 'ghost')).toBe(false);
  });

  it('a failed write stays failed — decisions never overlay failures', () => {
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, SINGLE_FAIL)]),
      user('y'),
    ], [
      { file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1 },
    ]);
    expect(rows[0].verdict).toBe('failed');
  });
});

// ── Turn bucketing + cap ─────────────────────────────────────────────

describe('buildWorkLedger — turn buckets and cap', () => {
  it('rows bucket by turns since staging; newest turn last', () => {
    const rows = buildWorkLedger([
      user('u1'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'a' }, SINGLE_OK)]),
      user('u2'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'b' }, SINGLE_OK)]),
      user('u3 (current)'),
    ], []);
    expect(rows.map((r) => [r.turnOffset, r.section])).toEqual([[2, 'a'], [1, 'b']]);
  });

  it('rows older than the cap drop; cap boundary is inclusive', () => {
    const messages: ChatMessage[] = [];
    for (let i = 1; i <= WORK_LEDGER_MAX_TURNS + 2; i += 1) {
      messages.push(user(`u${i}`));
      messages.push(assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: `s${i}` }, SINGLE_OK)]));
    }
    messages.push(user('current'));
    const rows = buildWorkLedger(messages, []);
    const offsets = rows.map((r) => r.turnOffset);
    expect(offsets.every((o) => o >= 1 && o <= WORK_LEDGER_MAX_TURNS)).toBe(true);
    expect(offsets).toContain(WORK_LEDGER_MAX_TURNS);
    expect(offsets).not.toContain(WORK_LEDGER_MAX_TURNS + 1);
    expect(offsets).not.toContain(WORK_LEDGER_MAX_TURNS + 2);
  });
});

// ── Detail hygiene ───────────────────────────────────────────────────

describe('buildWorkLedger — detail is one bounded line', () => {
  it('multi-line error collapses to its first line, whitespace-clean, ≤ 120 chars', () => {
    const long = `config_edit FAILED: ${'e'.repeat(300)}\nsecond line\n\tthird`;
    const rows = buildWorkLedger([
      user('x'),
      assistant([call('config_edit', { file: 'printer.cfg', op: 'set_param', section: 'led' }, long)]),
      user('y'),
    ], []);
    const detail = rows[0].detail ?? '';
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.endsWith('…')).toBe(true);
  });
});

// ── W6.5 enrichment: touched (read) files ────────────────────────────

describe('buildWorkLedger — touched files (W6.5 enrichment)', () => {
  it('read_user_config contributes a file-level touched row', () => {
    const rows = buildWorkLedger([
      user('look'),
      assistant([call('read_user_config', { file: 'printer.cfg' }, '# printer.cfg  (User Config - whole file)\n# 120 bytes\n\n[printer]')]),
      user('y'),
    ], []);
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 1, file: 'printer.cfg', section: '', verdict: 'touched' },
    ]);
  });

  it('touched rows are a SEPARATE key space from file-level write rows', () => {
    const rows = buildWorkLedger([
      user('a'),
      assistant([
        call('read_user_config', { file: 'fan.cfg' }, '# fan.cfg  (User Config - whole file)\n# 8 bytes\n\n[fan_generic f]'),
        call('config_write', { file: 'fan.cfg', content: '[fan_generic f]' }, WRITE_OK),
      ]),
      user('y'),
    ], []);
    const fan = rows.filter((r) => r.file === 'fan.cfg');
    expect(fan.map((r) => r.verdict).sort()).toEqual(['pending', 'touched']);
  });

  it('decisions never overlay touched rows (nothing to review in a read)', () => {
    const rows = buildWorkLedger([
      user('look'),
      assistant([call('read_user_config', { file: 'printer.cfg' }, '# printer.cfg  (User Config - whole file)\n# 120 bytes\n\n[printer]')]),
      user('y'),
    ], [
      { file: 'printer.cfg', section: '', verdict: 'kept', turnIndex: 1 },
    ]);
    expect(rows).toEqual([
      { turnOffset: 1, turnOrdinal: 1, file: 'printer.cfg', section: '', verdict: 'touched' },
    ]);
  });

  it('failed reads produce no row (output that is not a successful read claims nothing)', () => {
    const rows = buildWorkLedger([
      user('look'),
      assistant([call('read_user_config', { file: 'nope.cfg' }, '{"status": "not_found"}')]),
      user('y'),
    ], []);
    expect(rows).toEqual([]);
  });
});

// ── PR #43 review F5/F6: lineage epoch and trust boundary ───────────

describe('buildWorkLedger — lineage epoch and trust boundary (PR #43 F5/F6)', () => {
  const trail: ChatMessage[] = [
    user('one'),
    assistant([call('config_edit', { file: 'printer.cfg', section: 'led' }, SINGLE_OK)]),
    user('two'),
  ];

  it('overlays only same-epoch decisions (F5)', () => {
    const led: WorkLedgerDecision = {
      file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1, epoch: 7,
    };
    // Dead lineage (epoch 8 built, event from epoch 7): no overlay.
    expect(buildWorkLedger(trail, [led], { epoch: 8 })[0].verdict).toBe('pending');
    expect(buildWorkLedger(trail, [led], { epoch: 7 })[0].verdict).toBe('kept');
    // No options at all: no epoch gate (legacy call sites keep working).
    expect(buildWorkLedger(trail, [led])[0].verdict).toBe('kept');
  });

  it('an event without an epoch cannot overlay when an epoch is required', () => {
    const legacy = {
      file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1,
    } as WorkLedgerDecision;
    expect(buildWorkLedger(trail, [legacy], { epoch: 1 })[0].verdict).toBe('pending');
  });

  it('a turnIndex beyond the trail end is ignored (F5 upper bound)', () => {
    const beyond: WorkLedgerDecision = {
      file: 'printer.cfg', section: 'led', verdict: 'undone', turnIndex: 99, epoch: 1,
    };
    expect(buildWorkLedger(trail, [beyond], { epoch: 1 })[0].verdict).toBe('pending');
  });

  it('trustFrom renders pre-bound pending rows as unknown (F6)', () => {
    // Staging sits at turnOrdinal 1; the boundary at 2 means the decision
    // record for turn 1 did not survive — never claim 'awaiting review'.
    expect(buildWorkLedger(trail, [], { epoch: 1, trustFrom: 2 })[0].verdict)
      .toBe('unknown');
    // Boundary at/below the staging turn: normal pending.
    expect(buildWorkLedger(trail, [], { epoch: 1, trustFrom: 1 })[0].verdict)
      .toBe('pending');
  });

  it('a matching decision outranks the trust boundary', () => {
    const kept: WorkLedgerDecision = {
      file: 'printer.cfg', section: 'led', verdict: 'kept', turnIndex: 1, epoch: 1,
    };
    expect(buildWorkLedger(trail, [kept], { epoch: 1, trustFrom: 5 })[0].verdict)
      .toBe('kept');
  });

  it('L-2: the boundary covers the LAST restored turn (users + 1)', () => {
    // Restored trail with two staged turns: ordinals 1 and 2, users = 2.
    // ChatDialog arms the boundary at users + 1 = 3 — the newest
    // restored staging (ordinal == users, which `trustFrom: 2` would
    // spare) must render 'unknown' too…
    const twoTurnTrail: ChatMessage[] = [
      user('one'),
      assistant([call('config_edit', { file: 'printer.cfg', section: 'led' }, SINGLE_OK)]),
      user('two'),
      assistant([call('config_edit', { file: 'printer.cfg', section: 'fan' }, SINGLE_OK)]),
      user('three'),
    ];
    const rows = buildWorkLedger(twoTurnTrail, [], { epoch: 1, trustFrom: 3 });
    const bySection = Object.fromEntries(rows.map((r) => [r.section, r.verdict]));
    expect(bySection).toEqual({ led: 'unknown', fan: 'unknown' });
    // …while a decision made NOW on that last row (turnIndex == users)
    // still outranks the boundary.
    const keptFan: WorkLedgerDecision = {
      file: 'printer.cfg', section: 'fan', verdict: 'kept', turnIndex: 2, epoch: 1,
    };
    const rows2 = buildWorkLedger(twoTurnTrail, [keptFan], { epoch: 1, trustFrom: 3 });
    const fanRow = rows2.find((r) => r.section === 'fan')!;
    expect(fanRow.verdict).toBe('kept');
  });

  it('failed rows never become unknown (trace-derived, trustworthy after reload)', () => {
    const failTrail: ChatMessage[] = [
      user('one'),
      assistant([call('config_edit', { file: 'printer.cfg', section: 'led' }, SINGLE_FAIL)]),
      user('two'),
    ];
    expect(buildWorkLedger(failTrail, [], { epoch: 1, trustFrom: 2 })[0].verdict)
      .toBe('failed');
  });
});

describe('C1 ledger byte-stability across sends', () => {
  // The cache contract behind '- turn N:' rendering (plan
  // 2026-11-20_ai-chat-cache-hit-miss.md): the relative turnOffset
  // recomputes every send by design, but the ABSOLUTE turnOrdinal —
  // what the backend renders from — must be identical on every later
  // send while the event and its verdict are unchanged. Otherwise one
  // mutated header byte ahead of the whole transcript busts the
  // provider prefix cache on every turn (measured: warm cached share
  // 0.312 with a ledger vs 0.982 without).
  const trail = (extra: ChatMessage[]): ChatMessage[] => [
    user('stage the led edit'),
    assistant([call('config_edit', { file: 'printer.cfg', section: 'led' }, SINGLE_OK)]),
    ...extra,
  ];

  it('rendered identity is identical when only later turns were appended', () => {
    // The renderer consumes turnOrdinal + the row fields; turnOffset is
    // the one field that legitimately moves per send (and the one the
    // absolute header no longer reads).
    const stripOffset = (r: { turnOffset: number }) => {
      const { turnOffset, ...rest } = r;
      return rest;
    };
    const a = buildWorkLedger(trail([user('next')]), []);
    const b = buildWorkLedger(
      trail([user('next'), assistant([]), user('and next'), assistant([]), user('and more')]),
      [],
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(JSON.stringify(stripOffset(b[0]))).toBe(JSON.stringify(stripOffset(a[0])));
  });

  it('turnOffset still moves while turnOrdinal holds (law pair)', () => {
    const b = buildWorkLedger(
      trail([user('next'), assistant([]), user('and next')]),
      [],
    );
    expect(b[0].turnOffset).toBe(2);
    expect(b[0].turnOrdinal).toBe(1);
  });

  it('countUserTurns matches the ledger count law', () => {
    expect(countUserTurns(trail([user('two'), user('three')]))).toBe(3);
  });
});
