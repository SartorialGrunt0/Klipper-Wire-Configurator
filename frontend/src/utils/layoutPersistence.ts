import type { AppEdge, AppNode } from '../types/graph';
import { sectionIdentity } from '../stores/graphStore';
import * as api from '../services/api';

/**
 * Layout persistence helpers shared by the startup restore paths (App.tsx)
 * and the in-session rebuild paths (Import/Revert/OpenFromPi/AI-accept/
 * TextEditor reference-add).
 *
 * WHY LOGICAL KEYS
 * Node ids come from a module-level counter (`node_${++n}`) that resets on
 * every page load. Two rebuilds only produce the SAME id sequence when the
 * config produced the exact same nodes in the exact same order — adding a
 * section to an earlier-sorted file, an MCU rename, a group-threshold flip
 * (3+ sections collapse into one group card) all shift the sequence.
 * Positions saved under the old ids then silently fall back to
 * auto-arranged. This module keys positions and edge routing by stable
 * content identity (file + section header, board identity) so a card
 * reclaims ITS OWN saved spot regardless of rebuild ordering. Exact-id
 * match is kept as a fast path for unchanged configs (and for legacy saves
 * that predate logical keys).
 *
 * SAVED SHAPES
 * All save paths now write the same payload (see buildLayoutPayload).
 * Older saves exist in the wild in two shapes — native mode used to store
 * FULL node objects, and browser mode stored edges WITHOUT source/target.
 * normalizeSavedLayout accepts both and upgrades them to the current shape
 * (computing logical keys from full node data where absent).
 */

export const LAYOUT_STORAGE_KEY = 'kwc.graphLayout';

/** Minimal saved node — identity fields plus position. `logicalKey` is
 *  optional: saves written before the key existed only match by id. */
export interface SavedLayoutNode {
  id: string;
  position: { x: number; y: number };
  logicalKey?: string;
}

/** Saved edge routing entry. `source`/`target` are node ids from the save
 *  moment — they may not exist in the rebuilt graph and must be remapped
 *  through logical keys before pair-matching (same counter-reset problem
 *  as node positions). */
export interface SavedLayoutEdge {
  id: string;
  source?: string;
  target?: string;
  data?: Record<string, unknown>;
  sourceHandle?: string;
  targetHandle?: string;
}

/** Full layout payload shared by the backend (layout.json) and the
 *  browser localStorage fallback. */
export interface SavedLayout {
  graphNodes: SavedLayoutNode[];
  graphEdges: SavedLayoutEdge[];
  macroDesigner?: unknown;
}

/**
 * Stable content identity for a graph node, independent of the ephemeral
 * `node_N` id:
 *  - hardware: board type + config file + MCU name (a multi-MCU file hosts
 *    several boards; the SBC is a singleton)
 *  - subComponent/feature: config file + section header (`sectionIdentity`,
 *    the same helper the rest of the app uses to mean "the same section" —
 *    header-based, so line-number drift inside the file doesn't break it)
 *  - group: config file + group name + feature flag + the SET of section
 *    headers the group collapses (sorted, order-insensitive — sibling
 *    re-ordering must not change the group's identity)
 *  - customGroup: user-drawn grouping container with no config backing —
 *    no stable identity; falls back to id matching.
 */
export function computeLogicalKey(node: { type: string; data: Record<string, unknown> }): string | null {
  const d = node.data;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  if (node.type === 'hardware') {
    const hwType = str(d.hardwareType);
    if (!hwType) return null;
    if (hwType === 'sbc') return 'sbc|singleton';
    const configFile = str(d.configFile) ?? '';
    const mcuName = str(d.mcuName) ?? '';
    return `hw|${hwType}|${configFile}|${mcuName}`;
  }

  if (node.type === 'subComponent' || node.type === 'feature') {
    const configFile = str(d.configFile) ?? '';
    const sectionHeader = str(d.sectionHeader);
    if (!sectionHeader) return null;
    const line = typeof d.sectionLineNumber === 'number' ? d.sectionLineNumber : undefined;
    return `sec|${configFile}|${sectionIdentity(sectionHeader, line)}`;
  }

  if (node.type === 'group') {
    const componentGroup = str(d.componentGroup);
    if (!componentGroup) return null;
    const children = Array.isArray(d.children)
      ? (d.children as Array<{ sectionHeader?: string; sectionLineNumber?: number }>)
      : [];
    const childIds = children
      .map((c) => sectionIdentity(c.sectionHeader ?? '', c.sectionLineNumber))
      .sort();
    const configFile = str(d.configFile) ?? '';
    return `grp|${configFile}|${componentGroup}|${d.isFeature ? 'f' : 'c'}|${childIds.join(',')}`;
  }

  return null;
}

/**
 * Map logical key → current node id (first node wins). Used to remap saved
 * edge endpoints (save-moment ids) onto rebuilt node ids.
 */
export function nodeKeyToId(nodes: readonly AppNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of nodes) {
    const key = computeLogicalKey(n);
    if (key && !map.has(key)) map.set(key, n.id);
  }
  return map;
}

/** Old (save-moment) node id → new (rebuilt) node id.
 *
 * Keyed saves (current format): remap through the saved node table's
 * logical keys — never assume an old id that happens to exist in the
 * rebuilt graph is the same node (ids are recycled: node_3 at save time
 * may be a different board after the rebuild).
 *
 * Legacy saves (no logicalKey anywhere): id identity is only safe when
 * the saved id set is a bijection of the current id set (no shift);
 * otherwise old ids can't be trusted and are left unmapped. */
export function buildIdRemap(
  savedNodes: readonly SavedLayoutNode[],
  currentNodes: readonly AppNode[],
): Map<string, string> {
  const remap = new Map<string, string>();
  const keyToNewId = nodeKeyToId(currentNodes);
  const currentIds = new Set(currentNodes.map((n) => n.id));
  const savedIds = new Set(savedNodes.map((s) => s.id));
  const legacyBijection = savedNodes.length === currentNodes.length
    && currentNodes.every((n) => savedIds.has(n.id));
  for (const s of savedNodes) {
    if (s.logicalKey) {
      const newId = keyToNewId.get(s.logicalKey);
      if (newId) remap.set(s.id, newId);
    } else if (legacyBijection && currentIds.has(s.id)) {
      remap.set(s.id, s.id);
    }
  }
  return remap;
}

/**
 * Coerce any shape of stored layout into the canonical SavedLayout:
 *  - graphNodes: compact entries ({id, position, logicalKey}) OR legacy
 *    full AppNode objects (keys computed from type+data)
 *  - graphEdges: entries with or without source/target (legacy browser
 *    saves omitted them — those degrade to id-matching only)
 * Malformed entries are dropped, never thrown.
 */
export function normalizeSavedLayout(raw: unknown): SavedLayout {
  const graphNodes: SavedLayoutNode[] = [];
  const graphEdges: SavedLayoutEdge[] = [];
  if (!raw || typeof raw !== 'object') return { graphNodes, graphEdges };
  const r = raw as Record<string, unknown>;

  if (Array.isArray(r.graphNodes)) {
    for (const entry of r.graphNodes) {
      if (!entry || typeof entry !== 'object') continue;
      const n = entry as Record<string, unknown>;
      if (typeof n.id !== 'string') continue;
      const p = n.position as { x?: unknown; y?: unknown } | undefined;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      let logicalKey = typeof n.logicalKey === 'string' && n.logicalKey ? n.logicalKey : undefined;
      if (!logicalKey && typeof n.type === 'string' && n.data && typeof n.data === 'object') {
        logicalKey = computeLogicalKey({ type: n.type, data: n.data as Record<string, unknown> }) ?? undefined;
      }
      graphNodes.push({ id: n.id, position: { x: p.x, y: p.y }, logicalKey });
    }
  }

  if (Array.isArray(r.graphEdges)) {
    for (const entry of r.graphEdges) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string') continue;
      graphEdges.push({
        id: e.id,
        source: typeof e.source === 'string' ? e.source : undefined,
        target: typeof e.target === 'string' ? e.target : undefined,
        data: e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : undefined,
        sourceHandle: typeof e.sourceHandle === 'string' ? e.sourceHandle : undefined,
        targetHandle: typeof e.targetHandle === 'string' ? e.targetHandle : undefined,
      });
    }
  }

  return { graphNodes, graphEdges, macroDesigner: r.macroDesigner ?? null };
}

/**
 * Canonical payload for BOTH save modes (native layout.json and browser
 * localStorage). Nodes are stored compact (id + position + logical key —
 * positions are all restore needs); edges carry endpoints so routing can
 * be remapped across rebuilds even when the id sequence shifted.
 */
export function buildLayoutPayload(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  macroDesigner: unknown,
): SavedLayout {
  return {
    graphNodes: nodes.map((n) => ({
      id: n.id,
      position: n.position,
      logicalKey: computeLogicalKey(n) ?? undefined,
    })),
    graphEdges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as Record<string, unknown>,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
    })),
    macroDesigner,
  };
}

/**
 * Overlay saved node positions onto the current (rebuilt) graph nodes.
 *
 * Matching order per rebuilt node:
 *   1. saved entry carrying the node's logical key (content identity)
 *   2. saved entry with the same id (fast path / legacy saves)
 *
 * Logical key wins on conflict: ids are ephemeral, content is not.
 */
export function applySavedNodePositions(
  currentNodes: readonly AppNode[],
  savedNodes: readonly SavedLayoutNode[],
): AppNode[] {
  if (savedNodes.length === 0) return [...currentNodes];

  const byKey = new Map<string, SavedLayoutNode>();
  const byId = new Map<string, SavedLayoutNode>();
  for (const s of savedNodes) {
    if (s.logicalKey) {
      if (!byKey.has(s.logicalKey)) byKey.set(s.logicalKey, s);
    }
    if (!byId.has(s.id)) byId.set(s.id, s);
  }

  // Legacy saves (no logicalKey anywhere) carry no identity — id matching is
  // only trustworthy when the saved id set is exactly the current id set
  // (no shift). If the sets differ, a shifted legacy id could name a
  // DIFFERENT card than it did at save time, so legacy id matches for
  // key-able nodes are skipped (they keep auto-arranged positions) rather
  // than risk one card wearing another's saved spot.
  const savedIds = new Set(savedNodes.map((s) => s.id));
  const legacyBijection = savedNodes.length === currentNodes.length
    && currentNodes.every((n) => savedIds.has(n.id));

  return currentNodes.map((node) => {
    const key = computeLogicalKey(node);
    if (key) {
      const keyed = byKey.get(key);
      if (keyed) return { ...node, position: keyed.position } as AppNode;
      // Id fallback is only allowed when it cannot be STALE:
      //  - keyed saves: the entry must carry the SAME card identity
      //    (a shifted id naming a different card is exactly the bug this
      //    module prevents — fall through to auto-arranged instead)
      //  - legacy saves: only when ids are a bijection (no shift possible)
      const byIdMatch = byId.get(node.id);
      if (byIdMatch) {
        const safe = byIdMatch.logicalKey
          ? byIdMatch.logicalKey === key
          : legacyBijection;
        if (safe) return { ...node, position: byIdMatch.position } as AppNode;
      }
      return node;
    }
    // No content identity (customGroup / unknown node) → exact id only, and
    // only when the saved entry is keyless too (or the save is a verified
    // bijection) — a shifted id could otherwise hand a user-drawn group the
    // saved position of a card that no longer lives at that id.
    const byIdMatch = byId.get(node.id);
    if (byIdMatch) {
      const safe = !byIdMatch.logicalKey || legacyBijection;
      if (safe) return { ...node, position: byIdMatch.position } as AppNode;
    }
    return node;
  });
}

/**
 * Overlay saved edge routing (custom bend points + connection-side handles)
 * onto the rebuilt graph's edges.
 *
 * Saved endpoints are save-moment node ids — after a rebuild the same wire
 * may connect `node_2 → node_5` instead of the saved `node_1 → node_3`.
 * Endpoints are remapped through logical keys first; a saved edge whose
 * endpoints can't be resolved (its cards no longer exist) is skipped by
 * pair-matching but still eligible via exact id. Pair match is
 * (source, target, edgeType), direction-agnostic — comm edges always
 * rebuild SBC → hardware but the user may have drawn the opposite way.
 */
export function applySavedEdgeLayout(
  currentEdges: readonly AppEdge[],
  savedEdges: readonly SavedLayoutEdge[],
  currentNodes: readonly AppNode[],
  savedNodes: readonly SavedLayoutNode[],
): AppEdge[] {
  if (savedEdges.length === 0) return [...currentEdges];

  const idRemap = buildIdRemap(savedNodes, currentNodes);
  // Old endpoint → rebuilt node id. No "id still exists → same node"
  // shortcut: ids are recycled across rebuilds, so only the remap (keyed
  // by content identity, or bijection-verified legacy ids) is trusted.
  const resolve = (id: string | undefined): string | undefined =>
    id ? idRemap.get(id) : undefined;

  const edgeTypeOf = (e: { data?: Record<string, unknown> }): string | undefined =>
    (e.data as Record<string, unknown> | undefined)?.edgeType as string | undefined;
  const pairKey = (sourceId: string | undefined, targetId: string | undefined, edgeType: string | undefined): string | null => {
    if (!sourceId || !targetId) return null;
    const [a, b] = [sourceId, targetId].sort();
    return [a, b, edgeType ?? ''].join('|');
  };

  const savedByPair = new Map<string, SavedLayoutEdge>();
  const savedById = new Map<string, SavedLayoutEdge>();
  for (const s of savedEdges) {
    const k = pairKey(resolve(s.source), resolve(s.target), edgeTypeOf(s));
    if (k && !savedByPair.has(k)) savedByPair.set(k, s);
    if (!savedById.has(s.id)) savedById.set(s.id, s);
  }

  return currentEdges.map((edge) => {
    const found =
      savedByPair.get(pairKey(edge.source, edge.target, edgeTypeOf(edge)) ?? '')
      ?? savedById.get(edge.id);
    if (!found) return edge;
    const next: Record<string, unknown> = { ...edge };
    if (found.data) {
      next.data = {
        ...edge.data,
        ...found.data,
        customMiddlePoints: (found.data as Record<string, unknown>).customMiddlePoints,
      } as unknown as AppEdge['data'];
    }
    if (found.sourceHandle) next.sourceHandle = found.sourceHandle;
    if (found.targetHandle) next.targetHandle = found.targetHandle;
    return next as AppEdge;
  });
}

/** Read the saved layout from wherever this mode persists it: backend
 *  layout.json (native) or localStorage (browser). Returns null when absent
 *  or unreadable — callers keep auto-arranged positions. */
export async function loadSavedLayout(isNative: boolean | null): Promise<SavedLayout | null> {
  if (isNative === null) return null; // status check still in flight
  if (isNative) {
    try {
      const res = await api.loadNativeLayout();
      return normalizeSavedLayout(res.layout);
    } catch {
      return null;
    }
  }
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSavedLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Re-apply the saved layout after an in-session full rebuild
 * (Import / Revert / Open-from-Pi / AI draft accept / TextEditor
 * reference-add). Without this, every rebuild auto-arranges and the 3s
 * autosave timer then persists that auto-arrangement OVER the user's saved
 * layout.
 *
 * Content-key matching means this is a no-op (except for genuinely new
 * cards, which keep their auto-arranged slot) when the config is
 * unchanged, and restores the user's arrangement when the rebuild shifted
 * node ids.
 */
export async function restoreLayoutAfterRebuild(
  graphStore: {
    nodes: AppNode[];
    edges: AppEdge[];
    setNodes: (n: AppNode[]) => void;
    setEdges: (e: AppEdge[]) => void;
  },
  isNative: boolean | null,
): Promise<void> {
  const saved = await loadSavedLayout(isNative);
  if (!saved) return;
  const fresh = graphStore;
  fresh.setNodes(applySavedNodePositions(fresh.nodes, saved.graphNodes));
  fresh.setEdges(applySavedEdgeLayout(fresh.edges, saved.graphEdges, fresh.nodes, saved.graphNodes));
}
