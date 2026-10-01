import type { ValidationError } from '../types/config';
import { scanSections } from './configOutline';
import { filterFindings, type SeverityVisibility } from './validationVisibility';

/**
 * The text view's single navigation tree: folder (only when the project has
 * one) → file → section → param.
 *
 * Replaces the separate files sidebar and sections sidebar. `configFiles` keys
 * are relative POSIX paths in native projects (`macros/start.cfg`) and plain
 * filenames for imports, so folders appear exactly when the project has them.
 *
 * Pure: the component renders the result and owns only the expand/collapse
 * state (see `defaultExpansion`).
 */

export type NodeSeverity = ValidationError['severity'];

export interface ConfigTreeNode {
  kind: 'folder' | 'file' | 'section' | 'param';
  /** Unique across the tree (folder path, file path, `${file}#${sectionId}`, …). */
  id: string;
  label: string;
  /** 1-based line for sections and params. */
  line?: number;
  /** Owning file for file/section/param nodes. */
  file?: string;
  /** Worst visible finding severity, or null when clean. */
  severity?: NodeSeverity | null;
  /** Commented-out section header. */
  isCommented?: boolean;
  children: ConfigTreeNode[];
}

export interface ConfigTreeInput {
  /** Every config file, in insertion order. */
  filenames: string[];
  /** Current text per file (active file = the textarea's text). */
  texts: Record<string, string>;
  activeFile: string;
  validation: Record<string, { errors: ValidationError[] } | undefined>;
  visibility: SeverityVisibility;
}

const SEVERITY_RANK: Record<NodeSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Dots in the tree are error/warning only. An `info` finding is legal,
 * order-dependent context (duplicate section, etc.) and is surfaced on the
 * line-number gutter alone — a grey dot beside a file or section reads as
 * "something is wrong here" when nothing is.
 */
function worstOf(findings: ValidationError[]): NodeSeverity | null {
  let worst: NodeSeverity | null = null;
  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    if (worst === null || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[worst]) {
      worst = finding.severity;
    }
  }
  return worst;
}

interface FolderDraft {
  name: string;
  path: string;
  folders: Map<string, FolderDraft>;
  files: ConfigTreeNode[];
}

function newFolder(name: string, path: string): FolderDraft {
  return { name, path, folders: new Map(), files: [] };
}

function folderToNodes(folder: FolderDraft): ConfigTreeNode[] {
  const children: ConfigTreeNode[] = [];
  for (const sub of Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    children.push({
      kind: 'folder',
      id: `folder:${sub.path}`,
      label: sub.name,
      children: folderToNodes(sub),
    });
  }
  // Files keep alphabetical order inside their folder (folders first) — the
  // same reading order the two sidebars had.
  children.push(
    ...folder.files.slice().sort((a, b) => a.label.localeCompare(b.label)),
  );
  return children;
}

export function buildConfigTree(input: ConfigTreeInput): ConfigTreeNode[] {
  const { filenames, texts, validation, visibility } = input;
  const root = newFolder('', '');

  for (const filename of filenames) {
    const segments = filename.split('/').filter(Boolean);
    const basename = segments.pop() ?? filename;
    let folder = root;
    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      if (!folder.folders.has(segment)) folder.folders.set(segment, newFolder(segment, path));
      folder = folder.folders.get(segment)!;
    }

    const findings = filterFindings(validation[filename]?.errors ?? [], visibility);
    const sections = scanSections(texts[filename] ?? '');

    folder.files.push({
      kind: 'file',
      id: `file:${filename}`,
      label: basename,
      file: filename,
      severity: worstOf(findings),
      children: sections.map((section) => ({
        kind: 'section' as const,
        id: `section:${filename}#${section.id}`,
        label: section.title,
        line: section.line,
        file: filename,
        isCommented: section.isCommented,
        severity: worstOf(findings.filter((finding) => finding.section === section.title)),
        children: section.params.map((param) => ({
          kind: 'param' as const,
          id: `param:${filename}#${section.id}#${param.key}:${param.line}`,
          label: param.key,
          line: param.line,
          file: filename,
          children: [],
        })),
      })),
    });
  }

  // Files stay in the caller's order inside a folder (import order), folders
  // first — the same reading order the two sidebars had.
  root.files.sort((a, b) => a.label.localeCompare(b.label));
  return folderToNodes(root);
}

/**
 * Every folder id on the path to a file, outermost first ([] for a top-level
 * file).
 */
export function ancestorIds(tree: readonly ConfigTreeNode[], file: string): string[] {
  const find = (nodes: readonly ConfigTreeNode[], trail: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.kind === 'file' && node.file === file) return trail;
      if (node.kind === 'folder') {
        const found = find(node.children, [...trail, node.id]);
        if (found) return found;
      }
    }
    return null;
  };
  return find(tree, []) ?? [];
}

/**
 * Which nodes start expanded: the active file (so its sections are visible) and
 * every folder on the way to it. Everything else starts folded.
 */
export function defaultExpansion(tree: readonly ConfigTreeNode[], activeFile: string): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  for (const id of ancestorIds(tree, activeFile)) expanded[id] = true;
  expanded[`file:${activeFile}`] = true;
  return expanded;
}
