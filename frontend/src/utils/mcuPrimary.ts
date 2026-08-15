import type { ConfigFile, ConfigSection, SectionSchema } from '../types/config';
import { updateAllSectionPins } from './pinUtils';

/**
 * Pure helpers for the MCU rename / primary promotion flow.
 *
 * The SettingsPanel orchestrates these against the stores; the file/name/pin
 * math lives here so it's unit-testable and identical across every caller
 * (MCU rename dialog, primary toggle, demote-with-name flow).
 */

/** Demoted primary's config file name: "Main Board" → "main_board.cfg". */
export function demotedConfigFilename(mcuName: string): string {
  return `${mcuName.toLowerCase().replace(/\s+/g, '_')}.cfg`;
}

/** Section header for an MCU: "mcu" (primary/unnamed) or "mcu <name>". */
export function mcuHeaderFor(mcuName: string): string {
  return mcuName ? `mcu ${mcuName}` : 'mcu';
}

/**
 * Rename an MCU section ([mcu old] → [mcu new]) and rewrite pin prefixes on
 * every section in the list (updateAllSectionPins handles the stepper/extruder
 * etc. pin params). Returns a new sections array; inputs are untouched.
 */
export function renameMcuSections(
  sections: ConfigSection[],
  oldMcuName: string,
  newMcuName: string,
  schemas?: Record<string, SectionSchema>,
): ConfigSection[] {
  const oldHeader = mcuHeaderFor(oldMcuName);
  const newHeader = mcuHeaderFor(newMcuName);
  const renamed = sections.map((sec) => {
    if (sec.full_header === oldHeader) {
      return { ...sec, section_name: newMcuName, full_header: newHeader };
    }
    return sec;
  });
  return updateAllSectionPins(renamed, oldMcuName, newMcuName, schemas);
}

/**
 * Apply an MCU rename across a target file plus any child config files that
 * may reference the MCU's pins. Returns a NEW configFiles record (only the
 * affected files replaced); inputs are untouched.
 */
export function applyMcuRenameToFiles(
  configFiles: Record<string, ConfigFile>,
  targetFile: string,
  childFiles: string[],
  oldMcuName: string,
  newMcuName: string,
  schemas?: Record<string, SectionSchema>,
): Record<string, ConfigFile> {
  const filesToUpdate = new Set([targetFile, ...childFiles]);
  const next: Record<string, ConfigFile> = {};
  for (const filename of Object.keys(configFiles)) {
    next[filename] = configFiles[filename];
  }
  for (const filename of filesToUpdate) {
    const cf = configFiles[filename];
    if (!cf) continue;
    next[filename] = { ...cf, sections: renameMcuSections(cf.sections, oldMcuName, newMcuName, schemas) };
  }
  return next;
}

export interface FileRename {
  from: string;
  to: string;
}

export interface NodeFileUpdate {
  nodeId: string;
  configFile: string;
}

/** Repoint every child inside a group node whose configFile === from → to. */
export interface GroupChildRename {
  nodeId: string;
  from: string;
  to: string;
}

export interface PrimarySwapPlan {
  renames: FileRename[];
  nodeUpdates: NodeFileUpdate[];
  groupChildRenames: GroupChildRename[];
}

export interface PlanNode {
  id: string;
  parentId?: string | null;
  type?: string;
  data?: unknown;
}

/**
 * Compute the file renames + node configFile updates needed to make a new
 * primary MCU: the old primary's printer.cfg → {oldMcuName}.cfg, the new
 * primary's file → printer.cfg, and every affected node (hardware + its
 * children) repointed. Group nodes also carry a children array whose entries
 * each record their own configFile — those are repointed via
 * groupChildRenames so sidebar section resolution never hits a stale
 * filename. Pure — returns a plan for the caller to apply via store actions.
 */
export function planPrimarySwap(opts: {
  oldPrimaryId: string | null;
  oldMcuName: string;
  newPrimaryId: string;
  newConfigFile: string;
  nodes: PlanNode[];
}): PrimarySwapPlan {
  const renames: FileRename[] = [];

  const fileOf = (n: PlanNode): string | undefined =>
    (n.data as { configFile?: string } | undefined)?.configFile;

  // Old primary: printer.cfg → {oldMcuName}.cfg
  if (opts.oldPrimaryId && opts.oldMcuName) {
    renames.push({ from: 'printer.cfg', to: demotedConfigFilename(opts.oldMcuName) });
  }

  // New primary: {newConfigFile} → printer.cfg
  if (opts.newConfigFile && opts.newConfigFile !== 'printer.cfg') {
    renames.push({ from: opts.newConfigFile, to: 'printer.cfg' });
  }

  // Repoint every node whose configFile matches a renamed file (top-level
  // hardware + sub-component/feature/group nodes). Group nodes also carry a
  // children array whose entries each record their own configFile — those are
  // repointed via groupChildRenames so sidebar section resolution never hits
  // a stale filename.
  const nodeUpdates: NodeFileUpdate[] = [];
  const groupChildRenames: GroupChildRename[] = [];
  for (const r of renames) {
    for (const n of opts.nodes) {
      if (fileOf(n) === r.from) {
        nodeUpdates.push({ nodeId: n.id, configFile: r.to });
      }
      if (n.type === 'group') {
        const children = (n.data as { children?: Array<{ configFile?: string }> } | undefined)?.children;
        if (!Array.isArray(children)) continue;
        if (children.some((c) => c.configFile === r.from)) {
          groupChildRenames.push({ nodeId: n.id, from: r.from, to: r.to });
        }
      }
    }
  }

  return { renames, nodeUpdates, groupChildRenames };
}

/** Apply a plan's file renames via a renameConfigFile-style callback. */
export function applyRenames(
  plan: PrimarySwapPlan,
  renameConfigFile: (from: string, to: string) => void,
): void {
  for (const r of plan.renames) renameConfigFile(r.from, r.to);
}

/**
 * Apply a plan's node configFile updates via an updateNodeData-style
 * callback (top-level hardware + sub-component/feature/group nodes).
 */
export function applyNodeUpdates(
  plan: PrimarySwapPlan,
  updateNodeData: (nodeId: string, data: { configFile: string }) => void,
): void {
  for (const u of plan.nodeUpdates) updateNodeData(u.nodeId, { configFile: u.configFile });
}

/**
 * Apply a plan's group-child repoints: for each group node listed, rewrite
 * every child entry whose configFile matches the renamed source file.
 */
export function applyGroupChildRenames(
  plan: PrimarySwapPlan,
  nodes: PlanNode[],
  updateNodeData: (nodeId: string, data: { children: unknown }) => void,
): void {
  for (const g of plan.groupChildRenames) {
    const groupNode = nodes.find((n) => n.id === g.nodeId);
    if (!groupNode) continue;
    const children = (groupNode.data as { children?: Array<{ configFile?: string; [k: string]: unknown }> } | undefined)?.children;
    if (!Array.isArray(children)) continue;
    const updated = children.map((c) =>
      c.configFile === g.from ? { ...c, configFile: g.to } : c,
    );
    updateNodeData(g.nodeId, { children: updated });
  }
}
