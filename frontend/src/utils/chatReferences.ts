/**
 * Chat context references — the pure logic behind the docked chat panel's
 * "what is this message about?" slots.
 *
 * A reference is a *pointer into the project* the user attached explicitly:
 * a line range they highlighted, a section/param they clicked in the tree,
 * or a whole file. The panel owns three slots over this type (pinned /
 * preview / selection); this module owns everything about the references
 * themselves — identity, scoping, labelling, dedupe and the prompt block.
 *
 * Design rules worth keeping:
 *  - **Identity is content-derived, never a counter.** ids are stable across
 *    re-parses so a reference survives a keystroke; two references to the
 *    same range are the same reference.
 *  - **The prompt block is byte-stable** for a given reference list. It is
 *    appended as a trailing system message (never spliced into the fixed
 *    system prompt) so the local-model KV-cache prefix stays intact.
 *  - **Findings ride along, they are not a separate ask.** Whatever scope a
 *    reference covers, the findings inside it are attached automatically —
 *    and they are filtered through the same severity-visibility settings the
 *    rest of the UI uses, so a severity the user has hidden is never
 *    silently sent to the model.
 */
import type { ValidationError } from '../types/config';
import { severityVisible, type SeverityVisibility } from './validationVisibility';

// ── Types ───────────────────────────────────────────────────────────

export type ChatReferenceKind = 'lines' | 'section' | 'param' | 'file' | 'finding';

export interface ChatReference {
  /** Stable, content-derived identity (see module doc). */
  id: string;
  kind: ChatReferenceKind;
  file: string;
  /** 1-based inclusive range for a `lines` reference. */
  startLine?: number;
  endLine?: number;
  /** Section title as written in the config (`gcode_macro CLEAN_NOZZLE`). */
  section?: string;
  /** Param key for a `param` reference. */
  param?: string;
  /** 1-based anchor line for section/param/finding references. */
  line?: number;
  /** Severity, for a `finding` reference. */
  severity?: ValidationError['severity'];
  /** Excerpt sent to the model (trimmed, capped). `lines` references only. */
  text?: string;
  /** In-scope findings, attached by `buildReferenceContext`. */
  findings?: ValidationError[];
}

/** Minimal structural input for `nodeToReference` — `ConfigTreeNode`
 *  satisfies it, and so does a hand-built one in a test. */
export interface ReferenceNodeInput {
  kind: 'folder' | 'file' | 'section' | 'param';
  id: string;
  label: string;
  line?: number;
  file?: string;
  /** Owning section title — carried for `param` nodes. */
  section?: string;
  children?: unknown[];
}

/** One row of the composer's `@`-mention list. */
export interface MentionSource {
  kind: 'file' | 'section' | 'param';
  file: string;
  label: string;
  section?: string;
  line?: number;
}

// ── Limits ──────────────────────────────────────────────────────────

/** Never send more than this many findings for one reference. */
export const MAX_REFERENCE_FINDINGS = 20;

/** Excerpt budget for a `lines` reference. A 5000-line select-all must not
 *  be able to flood the request. */
export const MAX_REFERENCE_EXCERPT_CHARS = 8000;

/** Default number of `@`-mention rows offered. */
export const MAX_MENTION_MATCHES = 8;

const SEVERITY_RANK: Record<ValidationError['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const MENTION_QUERY_RE = /^[A-Za-z0-9_.\-[\]]*$/;

// ── Helpers ─────────────────────────────────────────────────────────

export function basename(file: string): string {
  return file.replace(/^.*[\\/]/, '');
}

/** Worst-first, then by line — the order the user reads findings in. */
export function worstFindings(findings: readonly ValidationError[]): ValidationError[] {
  return [...findings].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    return a.line_number - b.line_number;
  });
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ── Producers ───────────────────────────────────────────────────────

/**
 * Build a reference from the editor's current selection.
 *
 * Returns null when there is nothing worth attaching: an empty or
 * whitespace-only selection, or a range that starts past the end of the
 * text. A range that merely runs past the end is clamped — the tail line is
 * still a real line the user highlighted.
 */
export function selectionToReference(
  text: string,
  file: string,
  startLine: number,
  endLine: number,
): ChatReference | null {
  const lines = splitLines(text);
  const start = Math.max(1, Math.min(startLine, endLine));
  const end = Math.min(lines.length, Math.max(startLine, endLine));
  if (start > lines.length || end < start) return null;

  const excerpt = lines.slice(start - 1, end).join('\n').trim();
  if (!excerpt) return null;

  return {
    id: `lines:${file}:${start}-${end}`,
    kind: 'lines',
    file,
    startLine: start,
    endLine: end,
    text: excerpt.length > MAX_REFERENCE_EXCERPT_CHARS
      ? excerpt.slice(0, MAX_REFERENCE_EXCERPT_CHARS)
      : excerpt,
  };
}

/** Build a reference from a tree row. Folders have nothing to attach. */
export function nodeToReference(node: ReferenceNodeInput): ChatReference | null {
  if (!node.file) return null;

  if (node.kind === 'file') {
    return { id: `file:${node.file}`, kind: 'file', file: node.file };
  }
  if (node.kind === 'section') {
    return {
      id: `section:${node.file}:${node.label}`,
      kind: 'section',
      file: node.file,
      section: node.label,
      line: node.line,
    };
  }
  if (node.kind === 'param') {
    return {
      id: `param:${node.file}:${node.section ?? ''}:${node.label}:${node.line ?? ''}`,
      kind: 'param',
      file: node.file,
      section: node.section,
      param: node.label,
      line: node.line,
    };
  }
  return null;
}

// ── Scoping ─────────────────────────────────────────────────────────

/**
 * The findings a reference covers, filtered to what the user can see and
 * capped. `line`/`section`/`param` bounds are inclusive.
 */
export function findingsForScope(
  reference: ChatReference,
  validation: Record<string, { errors: ValidationError[] } | undefined>,
  visibility: SeverityVisibility,
  max: number = MAX_REFERENCE_FINDINGS,
): ValidationError[] {
  const all = validation[reference.file]?.errors ?? [];
  const visible = all.filter((finding) => severityVisible(finding.severity, visibility));

  const scoped = visible.filter((finding) => {
    switch (reference.kind) {
      case 'lines':
        return (
          reference.startLine != null
          && reference.endLine != null
          && finding.line_number >= reference.startLine
          && finding.line_number <= reference.endLine
        );
      case 'section':
        return finding.section === reference.section;
      case 'param':
        if (reference.param && finding.param && finding.param !== reference.param) return false;
        return finding.section === reference.section;
      case 'finding':
        return reference.line == null || finding.line_number === reference.line;
      case 'file':
      default:
        return true;
    }
  });

  return worstFindings(scoped).slice(0, Math.max(0, max));
}

/** Resolve a reference list against the current validation map, attaching
 *  each reference's in-scope findings (undefined when it has none). */
export function buildReferenceContext(
  references: readonly ChatReference[],
  validation: Record<string, { errors: ValidationError[] } | undefined>,
  visibility: SeverityVisibility,
  max: number = MAX_REFERENCE_FINDINGS,
): ChatReference[] {
  return references.map((reference) => {
    const findings = findingsForScope(reference, validation, visibility, max);
    return findings.length > 0 ? { ...reference, findings } : { ...reference };
  });
}

// ── List operations ─────────────────────────────────────────────────

/** Append a reference unless an identical one is already attached. */
export function addReference(
  references: readonly ChatReference[],
  next: ChatReference,
): ChatReference[] {
  if (references.some((reference) => reference.id === next.id)) return [...references];
  return [...references, next];
}

/**
 * Drop references that a `lines` reference already covers, so attaching a
 * highlighted range doesn't leave the section/param row it came from
 * riding along as a redundant second chip.
 *
 * A section/param reference with no known line is treated as covered — it
 * is strictly less specific than a range in the same file and the model
 * can't locate it either.
 */
export function dedupeReferences(references: readonly ChatReference[]): ChatReference[] {
  const seen = new Set<string>();
  const out: ChatReference[] = [];
  for (const reference of references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    if (reference.kind === 'section' || reference.kind === 'param') {
      const covered = references.some(
        (other) =>
          other.kind === 'lines'
          && other.file === reference.file
          && other.startLine != null
          && other.endLine != null
          && (reference.line == null
            || (reference.line >= other.startLine && reference.line <= other.endLine)),
      );
      if (covered) continue;
    }
    out.push(reference);
  }
  return out;
}

// ── Labelling ───────────────────────────────────────────────────────

/** The chip label / prompt-block heading for a reference. */
export function referenceLabel(reference: ChatReference): string {
  const name = basename(reference.file);
  switch (reference.kind) {
    case 'lines':
      return reference.startLine === reference.endLine
        ? `${name}:${reference.startLine}`
        : `${name}:${reference.startLine}-${reference.endLine}`;
    case 'section':
      return `${name}:[${reference.section ?? ''}]`;
    case 'param':
      return `${name}:[${reference.section ?? ''}] ${reference.param ?? ''}`.trimEnd();
    case 'finding':
      return `${reference.severity ?? 'info'} · line ${reference.line ?? '?'}`;
    case 'file':
    default:
      return name;
  }
}

// ── Prompt block ────────────────────────────────────────────────────
//
// The reference → prompt text renderer deliberately lives on the BACKEND
// (`render_context_references` in `backend/api/ai_routes.py`), not here.
// The block is prompt content appended as a trailing system message, and
// every other element of this app's prompt is built server-side; keeping a
// second formatter in TypeScript would be two sources of truth for one
// format, drifting the moment either side is reworded. This module's job
// ends at producing *structured* references plus their in-scope findings —
// already filtered through the user's severity-visibility settings, which
// is frontend state the backend cannot see.

// ── @-mention ───────────────────────────────────────────────────────

/**
 * The `@`-token being typed at `caret`, or null when the caret isn't inside
 * one. An empty string means the user has typed `@` and nothing yet.
 *
 * Only a *word-start* `@` opens the list — `bob@example.com` is text, not a
 * mention. The token ends at the first character that can't appear in a
 * file/section/param name, which is what closes the popup once the user
 * types a space.
 */
export function mentionQuery(text: string, caret: number): string | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  const before = at > 0 ? upto[at - 1] : '';
  if (before && /[A-Za-z0-9_]/.test(before)) return null;

  const token = upto.slice(at + 1);
  if (!MENTION_QUERY_RE.test(token)) return null;
  return token;
}

/**
 * Filter the mention sources for the popup: a case-insensitive substring
 * match on the label, or on the file it lives in. An empty query (bare `@`)
 * offers everything, capped.
 */
export function mentionMatches(
  query: string,
  sources: readonly MentionSource[],
  limit: number = MAX_MENTION_MATCHES,
): MentionSource[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? sources.filter(
      (source) =>
        source.label.toLowerCase().includes(needle)
        || source.file.toLowerCase().includes(needle),
    )
    : [...sources];
  return matched.slice(0, Math.max(0, limit));
}
