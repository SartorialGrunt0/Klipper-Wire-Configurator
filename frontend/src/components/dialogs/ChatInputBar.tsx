/**
 * Chat Input Bar
 *
 * Contains:
 * - "Include Files" menu for selecting which loaded configs to send as context
 * - The attached-context chip row (pinned / preview / editor selection)
 * - Imported .cfg file attachments (with remove)
 * - ContentEditable input for composing messages, with `@`-mention completion
 * - Send button
 *
 * `compact` is the docked panel's density: at 360px the labelled "Include
 * Files" button becomes an icon plus a count badge (its menu already opens
 * upward, so nothing about the menu changes), and the chip row wraps.
 */
import React, { useState, useEffect, useRef } from 'react';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import { extractMentionedConfigFilenames } from '../../utils/chatUtils';
import { mentionQuery, type ChatReferenceKind, type MentionSource } from '../../utils/chatReferences';

// ── Attached Config File ───────────────────────────────────────────

export interface AttachedConfigFile {
  id: string;
  name: string;
  content: string;
}

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
  selectedConfigContextFiles: string[];
  loadedConfigFilenames: string[];
  activeFile: string | null;
  attachedConfigFiles: AttachedConfigFile[];
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
  onAttachFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachedFile: (id: string) => void;
  onSelectedContextFilesChange: (filenames: string[]) => void;
  inputRef: React.RefObject<HTMLDivElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
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
  selectedConfigContextFiles,
  loadedConfigFilenames,
  activeFile,
  attachedConfigFiles,
  onInputChange,
  onSend,
  onStop,
  onSteer,
  onKeyDown,
  onAttachFiles,
  onRemoveAttachedFile,
  onSelectedContextFilesChange,
  inputRef,
  fileInputRef,
  compact = false,
  references = [],
  onRemoveReference,
  onPromoteReference,
  onReferenceJump,
  onMentionQuery,
  onMentionAccept,
}) => {
  const [includeFilesMenuOpen, setIncludeFilesMenuOpen] = useState(false);
  const includeFilesMenuRef = useRef<HTMLDivElement>(null);

  // ── @-mention popup ─────────────────────────────────────────────
  // Anchored above the composer, so no caret geometry is needed to place
  // it — only to decide whether the caret sits inside a mention token.
  const [mention, setMention] = useState<{ query: string; items: MentionSource[]; index: number } | null>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!includeFilesMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (includeFilesMenuRef.current?.contains(event.target as Node)) return;
      setIncludeFilesMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [includeFilesMenuOpen]);

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
      {/* Include files bar */}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'px-3 pt-2 pb-1' : 'px-4 pt-3 pb-2'} text-[10px] text-[var(--color-text-secondary)]`}>
        <div className="relative" ref={includeFilesMenuRef}>
          <button
            type="button"
            onClick={() => setIncludeFilesMenuOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition-colors ${
              includeFilesMenuOpen
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
            }`}
            title="Choose which loaded config files to include in chat context"
          >
            {compact ? (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2.5h6l4 4v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M9 2.5v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                {selectedConfigContextFiles.length > 0 && (
                  <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-[9px] font-semibold text-[var(--color-text-primary)]">
                    {selectedConfigContextFiles.length}
                  </span>
                )}
              </>
            ) : (
              <>
                Include Files
                <KeyboardArrowDownRounded
                  sx={{ fontSize: 16 }}
                  className={`transition-transform ${includeFilesMenuOpen ? 'rotate-180' : ''}`}
                />
              </>
            )}
          </button>
          {includeFilesMenuOpen && (
            <div className={`absolute bottom-full left-0 z-20 mb-2 ${compact ? 'w-64' : 'w-72'} rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-2 shadow-2xl`}>
              <div className="mb-2 flex items-center justify-between gap-2 border-b border-[var(--color-bg-tertiary)] pb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                  Loaded .cfg files
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md border border-[var(--color-bg-tertiary)] p-1 text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  title="Import local .cfg files"
                >
                  <UploadFileRounded sx={{ fontSize: 16 }} />
                </button>
              </div>
              {loadedConfigFilenames.length > 0 ? (
                <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                  {loadedConfigFilenames.map((filename) => {
                    const checked = selectedConfigContextFiles.includes(filename);
                    const isActiveSelection = filename === activeFile;
                    return (
                      <label
                        key={filename}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-bg-primary)]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            onSelectedContextFilesChange(
                              e.target.checked
                                ? [...selectedConfigContextFiles, filename]
                                : selectedConfigContextFiles.filter((v) => v !== filename),
                            );
                          }}
                          className="rounded border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-primary)]">
                          {filename}
                        </span>
                        {isActiveSelection && (
                          <span className="rounded-full bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-text-secondary)]">
                            Active
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-3 text-[10px] text-[var(--color-text-secondary)]">
                  No loaded .cfg files. Use the import button to attach local files.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

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

      {/* Attached files */}
      {attachedConfigFiles.length > 0 && (
        <div className={`flex flex-wrap gap-2 ${compact ? 'px-3 pb-1' : 'px-4 pb-2'}`}>
          {attachedConfigFiles.map((file) => (
            <button
              key={file.id}
              onClick={() => onRemoveAttachedFile(file.id)}
              className="rounded-full border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-error)] hover:text-[var(--color-error)] transition-colors"
              title="Remove imported file from chat context"
            >
              {file.name} ×
            </button>
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
