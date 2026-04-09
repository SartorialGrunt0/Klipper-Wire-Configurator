import { useState, useCallback, useMemo } from 'react';
import { useConfigStore } from '../stores/configStore';
import * as api from '../services/api';

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

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-primary)]">
      {/* File tabs */}
      <div className="flex items-center gap-1 px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)] overflow-x-auto shrink-0">
        {filenames.map((fn) => (
          <button
            key={fn}
            onClick={() => handleFileSwitch(fn)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              fn === activeFile
                ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
          >
            {fn}
          </button>
        ))}
      </div>

      {/* Editor toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)] shrink-0">
        <span className="text-xs text-[var(--color-text-secondary)]">
          {isDirty ? '● Unsaved changes' : 'Editing ' + activeFile}
        </span>
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

      {/* Text area */}
      <textarea
        value={editText}
        onChange={(e) => handleTextChange(e.target.value)}
        spellCheck={false}
        className="flex-1 w-full p-4 resize-none bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-mono text-sm leading-relaxed focus:outline-none"
        style={{ tabSize: 4 }}
      />
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
