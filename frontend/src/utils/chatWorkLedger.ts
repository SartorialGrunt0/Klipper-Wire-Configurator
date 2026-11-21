/**
 * The conversation work-ledger (W6) — pure derivation.
 *
 * Closes action/failure/UNDO amnesia: KWC's lean prose replay gives the
 * model no record of what it staged, what failed, or what the human
 * undid, so a follow-up turn cannot distinguish "my edit failed" from
 * "the user reverted it" — the confabulated-edit-claim substrate named by
 * the 8-harness research (W0+W6 are the compensations that make prose-only
 * replay a valid bet).
 *
 * Two sources, different guarantees:
 *
 *  - WRITE-TOOL TRACE (staged + failed rows): `config_edit`/`config_write`
 *    calls stored in `ChatMessage.toolCalls` — persisted with the
 *    conversation, so this derivation re-runs identically after a reload.
 *    The `output` is the model-facing HARNESS text produced by
 *    backend/services/ai_edit_tools (not JSON); exactly three heads
 *    classify it (`{name} applied — `, `{name} FAILED: `,
 *    `{name} applied A of B ops`). Anything else yields NO row: a ledger
 *    line is a hard assertion, and absence never claims.
 *
 *  - DECISION EVENTS (kept/undone): NOT derivable from state — the review
 *    ledger is diff(FRAME, LIVE) and keep/undo are silent splices. They
 *    are appended by `workLedgerStore` at the four reviewEngine decision
 *    sites, tagged with the user-message count at decision time. They
 *    overlay staged rows by (file, section), later-wins, gated to the
 *    turn at-or-after the latest staging. A FAILED write is never
 *    overlaid: nothing staged there can be reviewed.
 *
 * Laws: names + verdicts only — no payloads, no prose parsing of MODEL
 * text (parsing OUR OWN harness output is parsing the harness, not
 * prose). Turn cap ~10, oldest dropped. Backend re-delivers the rows
 * verbatim as one trailing system message; it never interprets them.
 */
import type { ChatMessage } from '../stores/aiStore';

/** Turn window: rows older than this are dropped (law, not config). */
export const WORK_LEDGER_MAX_TURNS = 10;

/** One bounded error line per failed row (display law). */
const DETAIL_MAX_CHARS = 120;

const WRITE_TOOLS: ReadonlySet<string> = new Set(['config_edit', 'config_write']);

/** W6.5 enrichment: read calls mark files/sections TOUCHED — the skill
 *  body rule ("re-read a touched section before editing it in a later
 *  turn") needs the model to see what it grounded on earlier. Touched
 *  rows are a SEPARATE key space from write rows (a file can be both
 *  read and file-level created in one turn) and are never overlaid by
 *  review decisions — there is nothing to review in a read. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read_user_config']);

/** kept/undone event recorded by workLedgerStore at a reviewEngine site. */
export interface WorkLedgerDecision {
  file: string;
  /** Bare section name ('led'); '' = file-level (a created file). */
  section: string;
  verdict: 'kept' | 'undone';
  /** Number of user messages in the conversation at decision time —
   *  the same ordinaling the staging events use, so the two sources
   *  compare directly. */
  turnIndex: number;
  /** PR #43 review F5: conversation LINEAGE tag. turnIndex alone is a
   *  lower bound over a trail that can be branched (edit-resend truncates,
   *  hidden analyze sends replace) or switched (loading another saved
   *  thread), and a stale event then silently overwrites a NEW staging of
   *  the same file+section with a verdict from the dead lineage. Events
   *  carry the epoch their conversation lived in; the builder overlays
   *  only same-epoch events. Restored events are stamped with the current
   *  epoch (they arrive together with their conversation — trustworthy
   *  as a set). */
  epoch?: number;
}

/** One ledger row: one section's final state in one turn. */
export interface WorkLedgerRow {
  /** Turns since the (latest) staging: 1 = previous turn. Sorted
   *  DESCENDING — oldest first, newest last (render order).
   *  C1: still exact (current turn - turnOrdinal), kept for wire
   *  compatibility; the CACHE-stable identity is turnOrdinal. */
  turnOffset: number;
  /** C1 ledger byte-stability: the ABSOLUTE user-turn the event was
   *  created in (same count law as turnOffset's `totalUsers`). The
   *  backend renders '- turn N:' headers from this so a row's rendered
   *  bytes never change on later sends — the relative label used to
   *  mutate one header byte every turn ahead of the whole transcript,
   *  busting the provider prefix cache on every turn (measured 2026-11-20:
   *  warm cached share 0.312 vs 0.982 without a ledger). */
  turnOrdinal: number;
  file: string;
  /** Bare section name; '' = file-level. */
  section: string;
  verdict: 'pending' | 'kept' | 'undone' | 'failed' | 'touched' | 'unknown';
  /** failed only — the harness's own error line, single, bounded. */
  detail?: string;
}

/** `[led]`, `led`, `[gcode_macro X]` → one canonical bare name.
 *  Shared with the reviewEngine's decision sites so staged rows and
 *  decision events key identically. */
export function normalizeSection(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const m = text.match(/^\[\s*([^\]]*?)\s*\]$/);
  return (m ? m[1] : text).trim();
}

function boundedDetail(raw: string): string {
  const line = raw.split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  if (line.length <= DETAIL_MAX_CHARS) return line;
  return `${line.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/** A staged write event parsed out of one tool call. */
interface StagedEvent {
  file: string;
  /** Per-section outcomes of this single call (batch mixes pending/failed). */
  sections: Array<{ section: string; failed: boolean; detail?: string; touched?: boolean }>;
  /** User-message ordinal of the turn that produced the call. */
  turnOrdinal: number;
}

/** Parse one read-tool call into touched-file events (W6.5). Success in
 *  the harness grammar always carries the `# {name}` header line for the
 *  file (whole-file, WORKING copy, and section modes all format through
 *  the same header); not-found / error / "please provide" never do — so
 *  absence of the header means no row, never a false touched. */
function parseReadCall(
  argsJson: string,
  output: string,
  turnOrdinal: number,
): StagedEvent[] {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    args = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const names: string[] = [];
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      const name = String(f ?? '').trim();
      if (name) names.push(name);
    }
  } else {
    const single = String(args.filename ?? args.file ?? '').trim();
    if (single) names.push(single);
  }
  if (names.length === 0) return [];
  // Section-scoped reads name the sections they grounded on; whole-file
  // and list_sections modes are file-level.
  const sections: string[] = [];
  if (!args.list_sections) {
    if (typeof args.section === 'string' && args.section.trim()) {
      sections.push(normalizeSection(args.section));
    }
    if (Array.isArray(args.sections)) {
      for (const s of args.sections) {
        const sec = normalizeSection(s);
        if (sec) sections.push(sec);
      }
    }
  }
  // C-03 (PR #43): a section only counts as touched when its header is
  // actually IN THE RETURNED CONTENT. The call arguments echo a requested
  // section that does not exist in the file ('read_user_config' answers
  // 'section not found' style payloads WITHOUT that header), and the old
  // code trusted the arguments — so the ledger told the model it grounded
  // on a section that was never returned. Requested-but-absent sections
  // drop; if none survive, fall back to the file-level row (the file WAS
  // genuinely read, no section claimed).
  const grounded = sections.filter((section) =>
    new RegExp(`^\\[\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\]|#)`, "im").test(output));
  const evSections = grounded.length > 0
    ? grounded.map((section) => ({ section, failed: false, touched: true }))
    : [{ section: '', failed: false, touched: true }];
  // Batch reads succeed per file; only files whose header is present
  // touch (one event each — never a joined pseudo-file).
  return names
    .filter((name) => output.includes(`# ${name}`))
    .map((file) => ({ file, sections: evSections, turnOrdinal }));
}

/** Parse one write-tool call's harness result into a staged event. */
function parseWriteCall(
  name: string,
  argsJson: string,
  output: string,
  turnOrdinal: number,
): StagedEvent | null {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null; // unparseable args: absence never claims
  }
  const file = String(args.file ?? '').trim();
  if (!file) return null;

  const argSections: string[] = [];
  if (name === 'config_edit') {
    const ops = Array.isArray(args.ops) ? args.ops : null;
    if (ops) {
      for (const op of ops) {
        const o = (op ?? {}) as Record<string, unknown>;
        // rename rows carry the NEW header — that is what the review run shows.
        const section = normalizeSection(o.new_section ?? o.section);
        if (section) argSections.push(section);
      }
    } else {
      const section = normalizeSection(args.new_section ?? args.section);
      if (section) argSections.push(section);
    }
  } else {
    argSections.push(''); // config_write creates a FILE; no single section
  }
  if (argSections.length === 0) return null;

  const firstLine = output.split('\n', 1)[0];
  if (firstLine.startsWith(`${name} FAILED:`)) {
    const detail = boundedDetail(firstLine.slice(`${name} FAILED:`.length));
    return {
      file,
      sections: argSections.map((section) => ({ section, failed: true, detail })),
      turnOrdinal,
    };
  }
  if (firstLine.startsWith(`${name} applied — `)) {
    return {
      file,
      sections: argSections.map((section) => ({ section, failed: false })),
      turnOrdinal,
    };
  }
  const batch = firstLine.match(/^config_edit applied \d+ of \d+ ops/);
  if (batch) {
    // Failed groups render as `- op[i(-j)] {op} [section]: {error}`;
    // applied ops stay committed. Sections named here failed, everything
    // else from the args staged.
    const failed = new Map<string, string>();
    const failedLines = /^- op\[\d+(?:-\d+)?\](?: [^[\n]*?)?\[([^\]]*)\]: (.*)$/gm;
    for (const m of output.matchAll(failedLines)) {
      failed.set(normalizeSection(m[1]), boundedDetail(m[2] ?? ''));
    }
    const sections = argSections.map((section) => (
      failed.has(section)
        ? { section, failed: true, detail: failed.get(section) }
        : { section, failed: false }
    ));
    // Defensive: a failed bracket label outside the arg sections still
    // happened — name it rather than lose the failure.
    for (const [section, detail] of failed) {
      if (!argSections.includes(section)) sections.push({ section, failed: true, detail });
    }
    return { file, sections, turnOrdinal };
  }
  return null; // unknown shape: no row
}

/** Send-time build context (PR #43 review F5/F6). */
export interface WorkLedgerBuildOptions {
  /** Current conversation epoch: only same-epoch decision events overlay
   *  (dead-lineage events claim nothing). Omit = no epoch filtering. */
  epoch?: number;
  /** F6 honest absence: decision events are memory-only, but the message
   *  trail is persisted — so after a reload of a thread that was NOT
   *  explicitly saved, staging older than this user-message count has NO
   *  reachable decision record, and 'pending' would claim 'awaiting
   *  review' for edits the human may have decided (or not) in a lost
   *  session. Rows that would be pending get verdict 'unknown'.
   *  Omit/undefined = everything trustable (fresh conversation, or a
   *  loaded save whose decision record came with it). */
  trustFrom?: number;
}

/**
 * C1: the ledger's turn count, exposed so a caller that wants the
 * request-level `workLedgerCurrentTurn` anchor can derive it under the
 * SAME law as turnOffset (total user messages in the sent trail
 * INCLUDING the message being sent). The renderer does not need it when
 * rows carry absolute turnOrdinal values — it is a coherence guard, not
 * a dependency.
 */
export function countUserTurns(messages: readonly Pick<ChatMessage, 'role'>[]): number {
  return messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0);
}

/**
 * Derive the ledger rows for one outgoing request.
 *
 * `messages` is the sent trail INCLUDING the current user message (same
 * array loadedSkillNames reads), so the previous turn's staging
 * carries turnOffset 1. Returns [] for nothing worth reporting; the
 * caller sends the field only when non-empty.
 */
export function buildWorkLedger(
  messages: ChatMessage[],
  decisions: readonly WorkLedgerDecision[],
  options?: WorkLedgerBuildOptions,
): WorkLedgerRow[] {
  // Latest write event per (file, section) wins: a retry that failed then
  // applied reads applied; an applied-then-failed correction reads failed.
  const events = new Map<string, StagedEvent['sections'][number] & { turnOrdinal: number }>();
  let usersSeen = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      usersSeen += 1;
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      if (WRITE_TOOLS.has(call.name)) {
        const event = parseWriteCall(call.name, call.arguments, call.output, usersSeen);
        if (!event) continue;
        for (const section of event.sections) {
          // 'w' namespace: write rows and touched rows coexist per file
          // (a created file is also a read file).
          events.set(`w\u0000${event.file}\u0000${section.section}`, {
            ...section,
            turnOrdinal: event.turnOrdinal,
          });
        }
      } else if (READ_TOOLS.has(call.name)) {
        for (const event of parseReadCall(call.arguments, call.output, usersSeen)) {
          for (const section of event.sections) {
            events.set(`t\u0000${event.file}\u0000${section.section}`, {
              ...section,
              turnOrdinal: event.turnOrdinal,
            });
          }
        }
      }
    }
  }
  const totalUsers = usersSeen;

  const rows: WorkLedgerRow[] = [];
  for (const [key, event] of events) {
    const [, file, section] = key.split('\u0000');
    const turnOffset = totalUsers - event.turnOrdinal;
    if (turnOffset < 1 || turnOffset > WORK_LEDGER_MAX_TURNS) continue;
    let verdict: WorkLedgerRow['verdict'] = event.touched
      ? 'touched'
      : event.failed ? 'failed' : 'pending';
    let detail = event.detail;
    if (!event.touched && !event.failed) {
      // Latest matching decision at-or-after the staging turn wins
      // (kept-then-undone reads undone). Section match: exact, or
      // file-level when either side has no section (created files).
      // F5 gates: same-epoch only (dead lineages claim nothing) and
      // never beyond the trail's end (a turnIndex above the total user
      // messages can only be a stale/fabricated tag — ignored).
      const epoch = options?.epoch;
      const totalBound = totalUsers;
      let latest: WorkLedgerDecision | null = null;
      for (const decision of decisions) {
        if (epoch !== undefined && decision.epoch !== epoch) continue;
        if (decision.turnIndex > totalBound) continue;
        if (decision.file !== file) continue;
        if (decision.section !== section && decision.section !== '' && section !== '') continue;
        if (decision.turnIndex < event.turnOrdinal) continue;
        if (!latest || decision.turnIndex >= latest.turnIndex) latest = decision;
      }
      if (latest) {
        verdict = latest.verdict;
      } else if (options?.trustFrom !== undefined
        && event.turnOrdinal < options.trustFrom) {
        // F6: staging predates this session's decision history — the
        // honest statement is 'unknown', never 'awaiting review'.
        verdict = 'unknown';
      }
    }
    rows.push(detail !== undefined && verdict === 'failed'
      ? { turnOffset, turnOrdinal: event.turnOrdinal, file, section, verdict, detail }
      : { turnOffset, turnOrdinal: event.turnOrdinal, file, section, verdict });
  }
  // Oldest first, newest last (the render law); stable within a turn by
  // file+section so output is deterministic.
  rows.sort((a, b) => b.turnOffset - a.turnOffset
    || a.file.localeCompare(b.file)
    || a.section.localeCompare(b.section));
  return rows;
}
