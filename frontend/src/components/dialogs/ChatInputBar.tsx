/**
 * Chat Input Bar
 *
 * Contains:
 * - The attached-context chip row (pinned / preview / editor selection)
 * - ContentEditable input for composing messages, with `@`-mention completion
 * - Send button
 *
 * There is no context-file picker: a request carries the editor's unsaved
 * drafts and nothing else, and the model finds what it needs with its own
 * tools (`list_user_configs` / `read_user_config`). Explicit direction is the
 * chip row's job (`@`-mention, or a reference attached from the text view).
 *
 * `compact` is the docked panel's density: the chip row wraps.
 */
import React, { useState, useEffect } from 'react';
import { extractMentionedConfigFilenames } from '../../utils/chatUtils';
import { mentionQuery, type ChatReferenceKind, type MentionSource } from '../../utils/chatReferences';

// ── Reference chips ────────────────────────────────────────────────

/** One chip in the composer's attached-context row. */
export interface ChatReferenceChip {
  id: string;
  label: string;
  kind: ChatReferenceKind;
  /** `preview` is the not-yet-attached slot: it renders a `+` and is not sent. */
  role: 'pinned' | 'preview' | 'selection';
  findingsCount: number;
  findingsSeverity: 'error' | 'warning' | 'info' | null;
}

/** Kind glyphs — neutral by design; severity is what carries colour. */
const KIND_GLYPH: Record<ChatReferenceKind, string> = {
  file: '▤',
  section: '§',
  param: '▪',
  lines: '≡',
  finding: '●',
};

const SEVERITY_DOT: Record<'error' | 'warning' | 'info', string> = {
  error: 'bg-[var(--color-error)]',
  warning: 'bg-[var(--color-warning)]',
  info: 'bg-[var(--color-text-secondary)]',
};

// ── Props ───────────────────────────────────────────────────────────

export interface ChatInputBarProps {
  input: string;
  loading: boolean;
  onInputChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  /**
   * Send the composed text into the IN-FLIGHT request as a steer (a real
   * user turn injected at the next tool-turn boundary). Only offered while
   * `loading` and the composer is non-empty — with nothing in flight the
   * same text is an ordinary message and goes through `onSend`.
   */
  onSteer?: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLDivElement | null>;
  /** Docked-panel density. */
  compact?: boolean;
  /** Attached-context chips, in pinned → preview → selection order. */
  references?: ChatReferenceChip[];
  onRemoveReference?: (id: string) => void;
  onPromoteReference?: () => void;
  onReferenceJump?: (id: string) => void;
  /** Resolve the `@`-mention popup's rows for the token being typed. */
  onMentionQuery?: (query: string) => MentionSource[];
  onMentionAccept?: (source: MentionSource) => void;
}

// ── Caret geometry ──────────────────────────────────────────────────

/**
 * The caret's offset in the composer's flat text.
 *
 * The composer is a contentEditable div, which can hold several text nodes
 * once the user pastes or presses Enter. Reading `anchorOffset` would then
 * count only within the caret's own node, so instead measure a Range that
 * spans the container start → caret and take its string length: that is
 * exactly "how many characters of `textContent` are before the caret",
 * which is the coordinate `mentionQuery` expects.
 */
function caretOffsetIn(root: HTMLElement): number {
  const fallback = root.textContent?.length ?? 0;
  if (typeof window === 'undefined') return fallback;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;
  const live = selection.getRangeAt(0);
  if (!root.contains(live.endContainer)) return fallback;
  const span = document.createRange();
  span.selectNodeContents(root);
  span.setEnd(live.endContainer, live.endOffset);
  return span.toString().length;
}

// ── Component ───────────────────────────────────────────────────────

const ChatInputBar: React.FC<ChatInputBarProps> = ({
  input,
  loading,
  onInputChange,
  onSend,
  onStop,
  onSteer,
  onKeyDown,
  inputRef,
  compact = false,
  references = [],
  onRemoveReference,
  onPromoteReference,
  onReferenceJump,
  onMentionQuery,
  onMentionAccept,
}) => {
  // ── @-mention popup ─────────────────────────────────────────────
  // Anchored above the composer, so no caret geometry is needed to place
  // it — only to decide whether the caret sits inside a mention token.
  const [mention, setMention] = useState<{ query: string; items: MentionSource[]; index: number } | null>(null);

  const refreshMention = (text: string, root: HTMLElement) => {
    if (!onMentionQuery) {
      setMention(null);
      return;
    }
    const query = mentionQuery(text, caretOffsetIn(root));
    if (query == null) {
      setMention(null);
      return;
    }
    const items = onMentionQuery(query);
    setMention(items.length > 0 ? { query, items, index: 0 } : null);
  };

  const acceptMention = (source: MentionSource) => {
    onMentionAccept?.(source);
    setMention(null);
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent) => {
    if (mention) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention((prev) => prev && { ...prev, index: (prev.index + 1) % prev.items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((prev) => prev && {
          ...prev,
          index: (prev.index - 1 + prev.items.length) % prev.items.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptMention(mention.items[mention.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    onKeyDown(e);
  };

  return (
    <div className="border-t border-[var(--color-bg-tertiary)]">
      {/* Attached context references */}
      {references.length > 0 && (
        <div className={`flex flex-wrap gap-1 ${compact ? 'px-3 pb-1' : 'px-4 pb-2'}`}>
          {references.map((chip) => (
            <span
              key={chip.id}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                chip.role === 'preview'
                  ? 'border-dashed border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
              }`}
              title={
                chip.role === 'preview'
                  ? 'Suggested context — press + to attach it'
                  : chip.role === 'selection'
                    ? 'Your current editor selection is attached'
                    : 'Attached context'
              }
            >
              {chip.role === 'preview' && (
                <button
                  type="button"
                  onClick={() => onPromoteReference?.()}
                  className="shrink-0 font-semibold hover:text-[var(--color-text-primary)]"
                  title="Attach this context to the message"
                >
                  +
                </button>
              )}
              <span className="shrink-0 opacity-60">{KIND_GLYPH[chip.kind]}</span>
              <button
                type="button"
                onClick={() => onReferenceJump?.(chip.id)}
                className="min-w-0 truncate hover:text-[var(--color-text-primary)]"
                title="Jump to this part of the config"
              >
                {chip.label}
              </button>
              {chip.findingsSeverity && chip.findingsCount > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1" title={`${chip.findingsCount} finding(s) in this scope`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[chip.findingsSeverity]}`} />
                  {chip.findingsCount}
                </span>
              )}
              {chip.role !== 'preview' && (
                <button
                  type="button"
                  onClick={() => onRemoveReference?.(chip.id)}
                  className="shrink-0 hover:text-[var(--color-error)]"
                  title={chip.role === 'selection' ? 'Detach this selection' : 'Remove this context'}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className={`flex items-center gap-2 ${compact ? 'px-3 py-2' : 'p-4 pt-2'}`}>
        <div className="relative flex-1 min-w-0">
          {mention && (
            <div className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] py-1 shadow-2xl">
              {mention.items.map((source, index) => (
                <button
                  key={`${source.kind}:${source.file}:${source.label}`}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); acceptMention(source); }}
                  onMouseEnter={() => setMention((prev) => prev && { ...prev, index })}
                  className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-[10px] transition-colors ${
                    index === mention.index
                      ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)]'
                  }`}
                >
                  <span className="shrink-0 font-mono uppercase opacity-60">{source.kind}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{source.label}</span>
                  <span className="shrink-0 truncate opacity-50">{source.file}</span>
                </button>
              ))}
            </div>
          )}
          <div
            ref={inputRef}
            className={`px-3 py-2 rounded-lg text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none transition-colors resize-none ${
              loading
                ? 'border-[var(--color-bg-tertiary)] opacity-50 cursor-not-allowed'
                : 'border-[var(--color-bg-tertiary)] focus:border-[var(--color-accent)]'
            }`}
            contentEditable
            suppressContentEditableWarning
            onKeyDown={handleComposerKeyDown}
            onBlur={() => setMention(null)}
            onInput={(e) => {
              const target = e.target as HTMLDivElement;
              const text = target.textContent || '';
              onInputChange(text);
              refreshMention(text, target);
            }}
            data-placeholder="Type your message... (@ to reference a file, section or param)"
            style={{ minHeight: 36, maxHeight: 120, overflow: 'auto' }}
          />
        </div>
        {loading && input.trim() && onSteer ? (
          // Two actions are genuinely different while a request runs: steer
          // it, or stop it. One button that flips meaning depending on
          // whether the composer happens to be non-empty is a coin flip.
          <>
            <button
              onClick={onSteer}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              title="Send this into the running request — the model sees it as your next message"
            >
              Steer
            </button>
            <button
              onClick={onStop}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
              title="Stop the AI from processing"
            >
              Stop
            </button>
          </>
        ) : (
          <button
            onClick={loading ? onStop : onSend}
            disabled={!loading && !input.trim()}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            title={loading ? 'Stop the AI from processing' : 'Send message'}
          >
            {loading ? 'Stop' : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
};

export default ChatInputBar;
