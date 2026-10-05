import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ISSUE_MARKER } from '../utils/issueMarker';
import { buildConfigTree, defaultExpansion, type ConfigTreeNode } from '../utils/configTree';
import { nodeToReference, type ChatReference } from '../utils/chatReferences';
import type { SeverityVisibility } from '../utils/validationVisibility';
import type { ValidationResult } from '../types/config';

interface ConfigTreeProps {
  filenames: string[];
  /** Current text per file (the active file uses the textarea's live text). */
  texts: Record<string, string>;
  activeFile: string;
  validation: Record<string, ValidationResult>;
  visibility: SeverityVisibility;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectFile: (file: string) => void;
  onFileContextMenu: (event: React.MouseEvent, file: string) => void;
  onJumpToLine: (line: number) => void;
  onAddConfig: () => void;
  /**
   * Clicking a row jumps — and, because pointing at a section is also how a
   * user says "this is what I'm asking about", offers it to the dock's single
   * transient preview. Sections and params only: a file row has no line to
   * jump to and a whole-file preview would be noise.
   */
  onReferenceNode?: (reference: ChatReference) => void;
  /** Reference id currently held in the preview slot; that row highlights. */
  previewReferenceId?: string | null;
}

const INDENT_PX = 12;

/**
 * One navigation tree for the whole project: folder (only when the project has
 * one) → file → section → param.
 *
 * Replaces the separate files sidebar and sections sidebar. The active file and
 * the folders leading to it auto-expand; everything else starts folded, and the
 * expansion resets whenever the selected file changes.
 */
function ConfigTree({
  filenames,
  texts,
  activeFile,
  validation,
  visibility,
  collapsed,
  onToggleCollapsed,
  onSelectFile,
  onFileContextMenu,
  onJumpToLine,
  onAddConfig,
  onReferenceNode,
  previewReferenceId = null,
}: ConfigTreeProps) {
  const tree = useMemo(
    () => buildConfigTree({ filenames, texts, activeFile, validation, visibility }),
    [filenames, texts, activeFile, validation, visibility],
  );

  const [expansion, setExpansion] = useState<Record<string, boolean>>(() =>
    defaultExpansion(tree, activeFile),
  );

  // Auto-fold around the selected file. Deliberately depends on `activeFile`
  // only: `tree` is rebuilt whenever any file's text or findings change (every
  // keystroke lands here after the parse debounce), and resetting the fold state
  // on each of those made the tree snap shut while typing and flash through an
  // empty state while switching files. Merging the defaults in keeps whatever
  // the user folded themselves.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  useEffect(() => {
    setExpansion((current) => ({ ...current, ...defaultExpansion(treeRef.current, activeFile) }));
  }, [activeFile]);

  const toggle = useCallback((id: string) => {
    setExpansion((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  // Section count for the header. Deliberately ABOVE the collapsed early
  // return: a hook below a return statement is skipped on the collapsed
  // render, and React throws "Rendered fewer hooks than expected" — which
  // takes the whole app down with it (blank frontend, reported 2026-10-04).
  const sectionCount = useMemo(() => {
    let total = 0;
    const walk = (nodes: ConfigTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'section') total += 1;
        walk(node.children);
      }
    };
    walk(tree);
    return total;
  }, [tree]);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 items-start justify-center border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] pt-2">
        <button
          onClick={onToggleCollapsed}
          title="Show files and sections"
          className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {'>'}
        </button>
      </div>
    );
  }

  const renderNode = (node: ConfigTreeNode, depth: number, parentSection?: string): React.ReactNode => {
    const isExpanded = !!expansion[node.id];
    const hasChildren = node.children.length > 0;
    const severitySpec = node.severity ? ISSUE_MARKER[node.severity] : null;
    // The row's reference id, so a row can tell whether IT is the preview.
    const reference = node.kind === 'section' || node.kind === 'param'
      ? nodeToReference({ ...node, section: parentSection })
      : null;
    const isPreview = reference != null && reference.id === previewReferenceId;
    const rowPreviewClass = isPreview ? ' bg-[var(--color-bg-tertiary)] ring-1 ring-inset ring-[var(--color-accent)]' : '';

    if (node.kind === 'file') {
      const isActive = node.file === activeFile;
      return (
        <div key={node.id}>
          <div className="flex items-center">
            <button
              type="button"
              disabled={!hasChildren}
              onClick={() => toggle(node.id)}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              className={`flex h-5 w-4 shrink-0 items-center justify-center text-[10px] font-semibold text-[var(--color-text-secondary)] ${
                hasChildren ? 'hover:text-[var(--color-text-primary)]' : 'opacity-0'
              }`}
              style={{ marginLeft: depth * INDENT_PX }}
            >
              {isExpanded ? 'v' : '>'}
            </button>
            <button
              onClick={() => onSelectFile(node.file!)}
              onContextMenu={(event) => onFileContextMenu(event, node.file!)}
              title={node.file}
              className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left">{node.label}</span>
              {severitySpec && <span className={`${severitySpec.dotClass ?? ''} shrink-0`} title={severitySpec.title} />}
            </button>
          </div>
          {isExpanded && (
            <div className="kl-fold">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    if (node.kind === 'folder') {
      return (
        <div key={node.id}>
          <button
            onClick={() => toggle(node.id)}
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
            className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            style={{ paddingLeft: 8 + depth * INDENT_PX }}
          >
            <span className="text-[9px]">{isExpanded ? 'v' : '>'}</span>
            <span className="truncate">{node.label}</span>
          </button>
          {isExpanded && (
            <div className="kl-fold">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    if (node.kind === 'section') {
      return (
        <div key={node.id}>
          <button
            onClick={() => {
              onJumpToLine(node.line!);
              if (reference) onReferenceNode?.(reference);
            }}
            title={node.label}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]${
              node.isCommented ? ' text-[var(--color-text-secondary)]/70' : ' text-[var(--color-text-secondary)]'
            }${rowPreviewClass}`}
            style={{ paddingLeft: 8 + depth * INDENT_PX }}
          >
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-accent)]">{node.line}</span>
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {severitySpec && <span className={`${severitySpec.dotClass ?? ''} shrink-0`} title={severitySpec.title} />}
          </button>
          {hasChildren && isExpanded && (
            <div className="kl-fold">
              {node.children.map((child) => renderNode(child, depth + 1, node.label))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={node.id}
        onClick={() => {
          onJumpToLine(node.line!);
          if (reference) onReferenceNode?.(reference);
        }}
        title={`${node.label} (line ${node.line})`}
        className={`flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]${rowPreviewClass}`}
        style={{ paddingLeft: 8 + depth * INDENT_PX }}
      >
        <span className="shrink-0 font-mono text-[10px] text-[var(--color-accent)]">{node.line}</span>
        <span className="truncate">{node.label}</span>
      </button>
    );
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-bg-tertiary)] px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Files &amp; Sections
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[var(--color-text-secondary)]">
            {filenames.length}/{sectionCount}
          </span>
          <button
            onClick={onAddConfig}
            title="Add Configuration"
            className="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent)]"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={onToggleCollapsed}
            title="Collapse"
            className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {'<'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => renderNode(node, 0))}
        {tree.length === 0 && (
          <div className="px-3 py-3 text-xs text-[var(--color-text-secondary)]">No config files loaded.</div>
        )}
      </div>
    </div>
  );
}

export default ConfigTree;
