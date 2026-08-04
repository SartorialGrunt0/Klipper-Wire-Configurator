/**
 * Chat Message List
 *
 * Renders the conversation history with markdown support, LM Studio
 * status badges, auto-loaded docs indicators, tool usage badges, and
 * "Apply and Review Changes" buttons for applicable assistant messages.
 */
import React, { useState, useRef, useEffect, type ComponentPropsWithoutRef } from 'react';
import { extractConfigCodeBlocks } from '../../utils/chatUtils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { ChatMessage } from '../../stores/aiStore';
import type { AiToolCallDetail } from '../../services/api';
import type { AssistantDraftChange } from '../../utils/assistantDraftMerge';
import { extractConfigCodeBlock } from '../../utils/chatUtils';
import { hasPrinterMemoryBlock } from '../../utils/printerMemory';
import { classifyMiniDiffLine, isMiniDiffBlock } from '../../utils/miniDiff';

// ── Markdown Code Block Component ───────────────────────────────────

type CodeProps = ComponentPropsWithoutRef<'code'> & {
  children?: React.ReactNode;
  className?: string;
  inline?: boolean;
  node?: unknown;
};

function MarkdownCode({ children, className, inline }: CodeProps) {
  const content = String(children ?? '').replace(/\n$/, '');
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? '';
  const isBlock = inline === false || Boolean(className) || content.includes('\n');
  const isMiniDiff = isBlock && isMiniDiffBlock(content);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  if (!isBlock) {
    return (
      <code className="rounded bg-[var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px]">
        {content}
      </code>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const buttonLabel = copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy code';

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-bg-tertiary)] px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={() => { void handleCopy(); }}
          className="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)]"
          aria-label={buttonLabel}
          title={buttonLabel}
        >
          {copyState === 'copied' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.5 10.5H3A1.5 1.5 0 011.5 9V3A1.5 1.5 0 013 1.5h6A1.5 1.5 0 0110.5 3v0.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
      <pre className={`overflow-x-auto ${isMiniDiff ? 'font-mono text-[11px] leading-5' : 'p-3'}`}>
        {isMiniDiff ? (
          content.split('\n').map((line, index) => {
            const kind = classifyMiniDiffLine(line);
            return (
              <div
                key={index}
                className={
                  kind === 'removal'
                    ? 'bg-red-500/15 px-3 text-red-400'
                    : kind === 'addition'
                      ? 'bg-green-500/15 px-3 text-green-400'
                      : 'px-3 text-[var(--color-text-primary)]'
                }
              >
                <span className="mr-2 select-none opacity-40">
                  {kind === 'removal' ? '-' : kind === 'addition' ? '+' : ' '}
                </span>
                {line || '\u00A0'}
              </div>
            );
          })
        ) : (
          <code className="font-mono text-[11px]">{content}</code>
        )}
      </pre>
    </div>
  );
}

// ── Props ───────────────────────────────────────────────────────────

export interface ChatMessageListProps {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  /** Re-submits the last failed user message with full context. */
  onRetry?: () => void;
  activeFile: string | null;
  assistantDraftApplicableMessages: Record<number, boolean>;
  assistantDraftPreviewLoading: string | null;
  onApplyEdit: (content: string, messageIndex?: number) => void;
  onReviewPrinterMemory: (content: string) => void;
  /** Replace the user message at `index` with `newText` and regenerate. */
  onEditMessage?: (index: number, newText: string) => void;
  /** Export a single message's raw markdown as a file. */
  onExportMessage?: (content: string, index: number) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// ── Types for markdown component props ──────────────────────────────

type ParagraphProps = ComponentPropsWithoutRef<'p'>;
type ListProps = ComponentPropsWithoutRef<'ul'>;
type OrderedListProps = ComponentPropsWithoutRef<'ol'>;
type ListItemProps = ComponentPropsWithoutRef<'li'>;
type AnchorProps = ComponentPropsWithoutRef<'a'>;
type BlockquoteProps = ComponentPropsWithoutRef<'blockquote'>;
type TableProps = ComponentPropsWithoutRef<'table'>;
type TableCellProps = ComponentPropsWithoutRef<'th'>;
type TableDataCellProps = ComponentPropsWithoutRef<'td'>;

// ── Tool Call Details Popup ─────────────────────────────────────────

const ToolCallDetailsPopup: React.FC<{ calls: AiToolCallDetail[]; onClose: () => void }> = ({ calls, onClose }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const handleCopyAll = async () => {
    try {
      const text = calls
        .map((call) => `## ${call.name}\n\nArguments:\n${call.arguments}\n\nOutput:\n${call.output}`)
        .join('\n\n---\n\n');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // Clipboard unavailable — ignore.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Tool call details"
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-bg-tertiary)] px-4 py-3">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Tool Calls ({calls.length})
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void handleCopyAll(); }}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
              title="Copy all tool call details"
            >
              {copyState === 'copied' ? 'Copied' : 'Copy all'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
            >
              Close
            </button>
          </div>
        </div>
        <div className="max-h-[calc(80vh-60px)] overflow-y-auto p-4">
          {calls.map((call, index) => (
            <div
              key={`${call.name}-${index}`}
              className="mb-3 overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--color-bg-tertiary)] px-3 py-1.5">
                <span className="text-[11px] font-semibold text-emerald-300">{call.name}</span>
                {call.outputTruncated && (
                  <span className="text-[9px] uppercase tracking-wide text-[var(--color-text-secondary)]">output truncated</span>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="mb-1 text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">Arguments</p>
                <pre className="mb-2 overflow-x-auto rounded bg-[var(--color-bg-primary)] p-2 font-mono text-[10px] leading-5 text-[var(--color-text-primary)]">
                  {call.arguments}
                </pre>
                <p className="mb-1 text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">Output</p>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-bg-primary)] p-2 font-mono text-[10px] leading-5 text-[var(--color-text-primary)]">
                  {call.output || '(no output)'}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Component ───────────────────────────────────────────────────────

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  loading,
  error,
  onRetry,
  activeFile,
  assistantDraftApplicableMessages,
  assistantDraftPreviewLoading,
  onApplyEdit,
  onReviewPrinterMemory,
  onEditMessage,
  onExportMessage,
  messagesEndRef,
}) => {
  const [toolDetailsMessageIndex, setToolDetailsMessageIndex] = useState<number | null>(null);
  const [editMessageIndex, setEditMessageIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copyState, setCopyState] = useState<Record<number, 'idle' | 'copied' | 'error'>>({});
  const activeToolDetails = toolDetailsMessageIndex !== null
    ? (messages[toolDetailsMessageIndex]?.toolCalls ?? null)
    : null;
  if (messages.length === 0 && !loading && !error) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        <div className="text-center">
          <p className="text-xs">Ask a question about your Klipper configuration!</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {messages.map((msg, i) => {
        if (msg.role === 'user' && msg.hiddenFromUser) return null;

        const assistantConfigBlock = msg.role === 'assistant' ? extractConfigCodeBlock(msg.content) : null;
        const hasApplicableAssistantDraft = assistantDraftApplicableMessages[i] === true;
        const hasPrinterMemBlock = msg.role === 'assistant' && hasPrinterMemoryBlock(msg.content);


        // Log eligibility for the button on each render
        if (msg.role === 'assistant') {
          const blockCount = extractConfigCodeBlocks(msg.content).length;
          const isApplicable = assistantDraftApplicableMessages[i] === true;
          console.debug('[AIDraft] Message', i, '| blocks:', blockCount, '| applicable:', isApplicable, '| activeFile:', activeFile);
        }

        return (
          <div key={i} className={`mb-2 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
            <div
              className={`inline-block max-w-[80%] px-3 py-2 rounded-lg text-xs leading-6 ${
                msg.role === 'user'
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border border-[var(--color-bg-tertiary)]'
              }`}
              style={{ wordBreak: 'break-word' }}
            >
              {editMessageIndex === i ? (
                <div>
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={4}
                    className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                    autoFocus
                    aria-label="Edit message"
                  />
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setEditMessageIndex(null); setEditDraft(''); }}
                      className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const nextText = editDraft.trim();
                        if (nextText && onEditMessage) {
                          onEditMessage(i, nextText);
                        }
                        setEditMessageIndex(null);
                        setEditDraft('');
                      }}
                      className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-medium text-white transition-opacity hover:opacity-90"
                    >
                      Save and Regenerate
                    </button>
                  </div>
                </div>
              ) : msg.role === 'assistant' ? (
                <ReactMarkdown
                  remarkPlugins={[remarkMath, remarkGfm]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    p: ({ children }: ParagraphProps) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }: ListProps) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
                    ol: ({ children }: OrderedListProps) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
                    li: ({ children }: ListItemProps) => <li className="mb-1 last:mb-0">{children}</li>,
                    a: ({ children, href }: AnchorProps) => (
                      <a className="text-[var(--color-accent)] underline" href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                    blockquote: ({ children }: BlockquoteProps) => (
                      <blockquote className="my-2 border-l-2 border-[var(--color-bg-tertiary)] pl-3 text-[var(--color-text-secondary)]">
                        {children}
                      </blockquote>
                    ),
                    table: ({ children }: TableProps) => (
                      <div className="my-2 overflow-x-auto">
                        <table className="min-w-full border-collapse text-left text-[11px]">{children}</table>
                      </div>
                    ),
                    th: ({ children }: TableCellProps) => (
                      <th className="border border-[var(--color-bg-tertiary)] px-2 py-1 font-semibold">{children}</th>
                    ),
                    td: ({ children }: TableDataCellProps) => (
                      <td className="border border-[var(--color-bg-tertiary)] px-2 py-1 align-top">{children}</td>
                    ),
                    code: MarkdownCode,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
              )}



              {/* MCP tool names badge */}
              {editMessageIndex !== i && msg.role === 'assistant' && Array.isArray(msg.mcpToolNames) && msg.mcpToolNames.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
                        setToolDetailsMessageIndex(i);
                      }
                    }}
                    disabled={!Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0}
                    className={`inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300 ${
                      Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
                        ? 'cursor-pointer transition-colors hover:bg-emerald-500/20'
                        : 'cursor-default'
                    }`}
                    title={
                      Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
                        ? `Show details for ${msg.toolCalls.length} tool call(s)`
                        : `The assistant used MCP tools from the application to answer this: ${msg.mcpToolNames.join(', ')}`
                    }
                  >
                    Tools: {msg.mcpToolNames.join(', ')}
                    {Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (
                      <span className="opacity-70" aria-hidden="true">›</span>
                    )}
                  </button>
                </div>
              )}

              {/* Auto-repair / retry / re-prompt footer */}
              {editMessageIndex !== i && (() => {
                const repairCount = msg.repairCount ?? 0;
                const retryCount = msg.retryCount ?? 0;
                const repromptCount = msg.repromptCount ?? 0;
                if (msg.role !== 'assistant' || repairCount + retryCount + repromptCount === 0) return null;
                const parts: string[] = [];
                if (repairCount > 0) parts.push(`Auto-repaired ${repairCount} section${repairCount === 1 ? '' : 's'}`);
                if (retryCount > 0) parts.push(`Retried ${retryCount}×`);
                if (repromptCount > 0) parts.push(`Re-prompted ${repromptCount}×`);
                return (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span
                      className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-300"
                      title="The app auto-repaired the draft and/or the model needed retries before this reply was accepted"
                    >
                      {parts.join(' · ')}
                    </span>
                  </div>
                );
              })()}

              {/* Action buttons row */}
              {editMessageIndex !== i && (
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {/* Edit message (user messages only) */}
                  {msg.role === 'user' && !loading && onEditMessage && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditMessageIndex(i);
                        setEditDraft(msg.content);
                      }}
                      className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      title="Edit the message and regenerate the reply"
                    >
                      Edit
                    </button>
                  )}

                  {/* Copy raw markdown */}
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          await navigator.clipboard.writeText(msg.content);
                          setCopyState((prev) => ({ ...prev, [i]: 'copied' }));
                          setTimeout(() => {
                            setCopyState((prev) => ({ ...prev, [i]: 'idle' }));
                          }, 2000);
                        } catch {
                          setCopyState((prev) => ({ ...prev, [i]: 'error' }));
                        }
                      })();
                    }}
                    className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    title="Copy the raw markdown content"
                  >
                    {copyState[i] === 'copied' ? 'Copied' : copyState[i] === 'error' ? 'Copy failed' : 'Copy'}
                  </button>

                  {/* Export raw markdown */}
                  {onExportMessage && (
                    <button
                      type="button"
                      onClick={() => onExportMessage(msg.content, i)}
                      className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      title="Export this message as a Markdown file"
                    >
                      Export
                    </button>
                  )}

                  {/* Apply and Review Changes button */}
                  {msg.role === 'assistant' && assistantConfigBlock && activeFile && hasApplicableAssistantDraft && (
                    <button
                      onClick={() => onApplyEdit(msg.content, i)}
                      disabled={assistantDraftPreviewLoading === msg.content}
                      className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                      title="Preview how the assistant sections would merge into the matching config file"
                    >
                      {assistantDraftPreviewLoading === msg.content ? 'Preparing Review...' : 'Apply and Review Changes'}
                    </button>
                  )}

                  {/* Review Printer Memory button */}
                  {msg.role === 'assistant' && hasPrinterMemBlock && (
                    <button
                      onClick={() => onReviewPrinterMemory(msg.content)}
                      className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-blue-500 hover:text-blue-400"
                      title="Review proposed printer memory changes"
                    >
                      Review Printer Memory
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Loading indicator */}
      {loading && (
        <div className="text-left mb-2">
          <div className="inline-block px-3 py-2 rounded-lg text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <span className="inline-flex gap-0.5">
              <span className="animate-bounce">●</span>
              <span className="animate-bounce" style={{ animationDelay: '0.15s' }}>●</span>
              <span className="animate-bounce" style={{ animationDelay: '0.3s' }}>●</span>
            </span>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 mb-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="mt-0.5 shrink-0 text-[var(--color-error)]" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 4.5v4M8 11v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-[var(--color-error)]">Request failed</p>
            <p className="mt-0.5 text-[10px] text-[var(--color-text-secondary)] leading-relaxed">{error}</p>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 px-2.5 py-1 rounded text-[10px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              title="Resend the last question with the full conversation and config context"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div ref={messagesEndRef} />

      {activeToolDetails && (
        <ToolCallDetailsPopup
          calls={activeToolDetails}
          onClose={() => setToolDetailsMessageIndex(null)}
        />
      )}
    </>
  );
};

export default ChatMessageList;
