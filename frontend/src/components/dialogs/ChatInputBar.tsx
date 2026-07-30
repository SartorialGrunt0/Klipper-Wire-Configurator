/**
 * Chat Input Bar
 *
 * Contains:
 * - "Include Files" menu for selecting which loaded configs to send as context
 * - Imported .cfg file attachments (with remove)
 * - ContentEditable input for composing messages
 * - Send button
 */
import React, { useState, useEffect, useRef } from 'react';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import { extractMentionedConfigFilenames } from '../../utils/chatUtils';

// ── Attached Config File ───────────────────────────────────────────

export interface AttachedConfigFile {
  id: string;
  name: string;
  content: string;
}

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
  onKeyDown: (e: React.KeyboardEvent) => void;
  onAttachFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachedFile: (id: string) => void;
  onSelectedContextFilesChange: (filenames: string[]) => void;
  inputRef: React.RefObject<HTMLDivElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
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
  onKeyDown,
  onAttachFiles,
  onRemoveAttachedFile,
  onSelectedContextFilesChange,
  inputRef,
  fileInputRef,
}) => {
  const [includeFilesMenuOpen, setIncludeFilesMenuOpen] = useState(false);
  const includeFilesMenuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="border-t border-[var(--color-bg-tertiary)]">
      {/* Include files bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 text-[10px] text-[var(--color-text-secondary)]">
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
            Include Files
            <KeyboardArrowDownRounded
              sx={{ fontSize: 16 }}
              className={`transition-transform ${includeFilesMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {includeFilesMenuOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-2 shadow-2xl">
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

      {/* Attached files */}
      {attachedConfigFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
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
      <div className="flex items-center gap-2 p-4 pt-2">
        <div
          ref={inputRef}
          className={`flex-1 px-3 py-2 rounded-lg text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none transition-colors resize-none ${
            loading
              ? 'border-[var(--color-bg-tertiary)] opacity-50 cursor-not-allowed'
              : 'border-[var(--color-bg-tertiary)] focus:border-[var(--color-accent)]'
          }`}
          contentEditable
          suppressContentEditableWarning
          onKeyDown={onKeyDown}
          onInput={(e) => {
            const target = e.target as HTMLDivElement;
            onInputChange(target.textContent || '');
          }}
          data-placeholder="Type your message..."
          style={{ minHeight: 36, maxHeight: 120, overflow: 'auto' }}
        />
        <button
          onClick={onSend}
          disabled={loading || !input.trim()}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
};

export default ChatInputBar;
