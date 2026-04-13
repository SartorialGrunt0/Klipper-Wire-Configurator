import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useConfigStore } from '../stores/configStore';
import * as api from '../services/api';

interface SearchResult {
  file: string;
  line: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export default function TextEditor() {
  const { configFiles, activeFile, setActiveFile, setConfigFile, setValidation } = useConfigStore();

  const config = configFiles[activeFile];
  const filenames = Object.keys(configFiles);

  // Build text from config
  const text = useMemo(() => {
    if (!config) return '';
    return configToText(config);
  }, [config]);

  const [editText, setEditText] = useState(text);
  const [isDirty, setIsDirty] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // All files as text for search
  const allFilesText = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [fn, cf] of Object.entries(configFiles)) {
      result[fn] = configToText(cf);
    }
    return result;
  }, [configFiles]);

  // Search results across all files
  const searchResults = useMemo((): SearchResult[] => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const results: SearchResult[] = [];
    for (const [fn, fileText] of Object.entries(allFilesText)) {
      const lines = fileText.split('\n');
      lines.forEach((line, idx) => {
        const lowerLine = line.toLowerCase();
        const pos = lowerLine.indexOf(query);
        if (pos !== -1) {
          results.push({
            file: fn,
            line: idx + 1,
            lineText: line,
            matchStart: pos,
            matchEnd: pos + query.length,
          });
        }
      });
    }
    return results.slice(0, 200);
  }, [searchQuery, allFilesText]);

  // Focus search input when panel opens
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // Sync when switching files
  const handleFileSwitch = (filename: string) => {
    setActiveFile(filename);
    const cf = configFiles[filename];
    if (cf) {
      setEditText(configToText(cf));
      setIsDirty(false);
    }
  };

  const handleTextChange = (newText: string) => {
    setEditText(newText);
    setIsDirty(true);
  };

  const handleApply = useCallback(async () => {
    try {
      const result = await api.parseConfigText(editText, activeFile);
      setConfigFile(activeFile, result.config);
      setValidation(activeFile, result.validation);
      setIsDirty(false);
    } catch (err) {
      console.error('Parse error:', err);
    }
  }, [editText, activeFile, setConfigFile, setValidation]);

  const handleSearchResultClick = (file: string, line: number) => {
    const cf = configFiles[file];
    if (!cf) return;
    const fileText = configToText(cf);
    if (file !== activeFile) {
      setActiveFile(file);
      setEditText(fileText);
      setIsDirty(false);
    }
    // Select the matching line after state settles
    setTimeout(() => {
      if (!textareaRef.current) return;
      const lines = textareaRef.current.value.split('\n');
      let charPos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        charPos += lines[i].length + 1;
      }
      const lineLen = lines[line - 1]?.length ?? 0;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(charPos, charPos + lineLen);
      // Approximate scroll to bring line into view
      const approxLineHeight = 21;
      textareaRef.current.scrollTop = Math.max(0, (line - 5) * approxLineHeight);
    }, 0);
  };

  const toggleSearch = () => {
    setShowSearch((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  };

  return (
    <div className="flex h-full bg-[var(--color-bg-primary)]">
      {/* File list sidebar */}
      <div className="w-48 shrink-0 flex flex-col bg-[var(--color-bg-secondary)] border-r border-[var(--color-bg-tertiary)]">
        <div className="px-3 py-2 shrink-0 border-b border-[var(--color-bg-tertiary)]">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Files</span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filenames.map((fn) => (
            <button
              key={fn}
              onClick={() => handleFileSwitch(fn)}
              title={fn}
              className={`w-full text-left px-3 py-1.5 text-xs font-medium transition-colors truncate ${
                fn === activeFile
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {fn}
            </button>
          ))}
        </div>
      </div>

      {/* Editor area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Editor toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)] shrink-0">
          <span className="text-xs text-[var(--color-text-secondary)] truncate mr-2">
            {isDirty ? '● Unsaved changes' : 'Editing ' + activeFile}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={toggleSearch}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                showSearch
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Search
            </button>
            <button
              onClick={handleApply}
              disabled={!isDirty}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                isDirty
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] cursor-not-allowed'
              }`}
            >
              Apply Changes
            </button>
          </div>
        </div>

        {/* Search panel */}
        {showSearch && (
          <div className="shrink-0 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)]">
            <div className="flex items-center gap-2 px-3 py-2">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-secondary)]">
                <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search all files…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') toggleSearch(); }}
                className="flex-1 bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-xs font-mono px-2 py-1 rounded border border-[var(--color-bg-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              {searchQuery.trim() && (
                <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                  {searchResults.length}{searchResults.length === 200 ? '+' : ''} match{searchResults.length !== 1 ? 'es' : ''}
                </span>
              )}
            </div>
            {searchResults.length > 0 && (
              <div className="max-h-52 overflow-y-auto border-t border-[var(--color-bg-tertiary)]">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleSearchResultClick(r.file, r.line)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] flex items-baseline gap-2 transition-colors"
                  >
                    <span className="text-[var(--color-accent)] shrink-0 font-medium">{r.file}</span>
                    <span className="text-[var(--color-text-secondary)] shrink-0">:{r.line}</span>
                    <span className="font-mono text-[var(--color-text-primary)] truncate">
                      {r.lineText.slice(0, r.matchStart)}
                      <mark className="bg-[var(--color-accent)] text-[var(--color-bg-primary)] rounded-sm not-italic">
                        {r.lineText.slice(r.matchStart, r.matchEnd)}
                      </mark>
                      {r.lineText.slice(r.matchEnd)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchQuery.trim() && searchResults.length === 0 && (
              <p className="px-3 py-2 text-xs text-[var(--color-text-secondary)] border-t border-[var(--color-bg-tertiary)]">
                No matches found.
              </p>
            )}
          </div>
        )}

        {/* Text area */}
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => handleTextChange(e.target.value)}
          spellCheck={false}
          wrap="off"
          className="flex-1 w-full p-4 resize-none bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-mono text-sm leading-relaxed focus:outline-none overflow-auto"
          style={{ tabSize: 4 }}
        />
      </div>
    </div>
  );
}

function configToText(config: { header_comments: string[]; includes: string[]; sections: Array<{ section_type: string; full_header: string; params: Array<{ key: string; value: string; comment: string; is_commented_out: boolean }> }> }): string {
  let lines: string[] = [];

  for (const c of config.header_comments) {
    lines.push(c);
  }
  if (config.header_comments.length) lines.push('');

  for (const inc of config.includes) {
    lines.push(`[include ${inc}]`);
  }
  if (config.includes.length) lines.push('');

  for (const sec of config.sections) {
    if (sec.section_type === 'include') continue;
    lines.push(`[${sec.full_header}]`);
    for (const p of sec.params) {
      const prefix = p.is_commented_out ? '#' : '';
      const comment = p.comment ? `   # ${p.comment}` : '';
      if (p.value.includes('\n')) {
        const parts = p.value.split('\n');
        lines.push(`${prefix}${p.key}: ${parts[0]}`);
        for (const part of parts.slice(1)) {
          lines.push(`${prefix}    ${part}`);
        }
      } else {
        lines.push(`${prefix}${p.key}: ${p.value}${comment}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
