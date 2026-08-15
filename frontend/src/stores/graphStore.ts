import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Node,
  type Edge,
} from '@xyflow/react';
import type { AppNode, AppEdge, GroupNodeData } from '../types/graph';
import type { HardwareType, CommunicationType, ConfigFile, ConfigSection } from '../types/config';
import { useConfigStore } from './configStore';
import { updateSectionPins, updateAllSectionPins } from '../utils/pinUtils';
import { buildUniqueSectionDraft } from '../utils/sectionNaming';

const STEPPER_SECTION_RE = /^stepper_[a-z]+(\d+)?$/;
const EXTRUDER_SECTION_RE = /^extruder(\d+)?$/;

// Map section types to component groups for coloring
const COMPONENT_GROUP_MAP: Record<string, string> = {
  stepper_a: 'stepper', stepper_b: 'stepper', stepper_c: 'stepper',
  manual_stepper: 'stepper', extruder_stepper: 'stepper', dual_carriage: 'stepper',
  tmc2209: 'stepper_driver', tmc2208: 'stepper_driver', tmc2130: 'stepper_driver',
  tmc2240: 'stepper_driver', tmc5160: 'stepper_driver', tmc2660: 'stepper_driver',
  heater_bed: 'heater', heater_generic: 'heater',
  fan: 'fan', heater_fan: 'fan', controller_fan: 'fan', temperature_fan: 'fan', fan_generic: 'fan',
  temperature_sensor: 'temperature',
  probe: 'probe', bltouch: 'probe', smart_effector: 'probe', probe_eddy_current: 'probe',
  neopixel: 'led', dotstar: 'led', led: 'led', pca9533: 'led', pca9632: 'led',
  display: 'display', servo: 'servo',
  output_pin: 'pin', gcode_button: 'pin', pwm_tool: 'pin',
  filament_switch_sensor: 'filament_sensor', filament_motion_sensor: 'filament_sensor',
  adxl345: 'accelerometer', lis2dw: 'accelerometer', lis3dh: 'accelerometer',
  bmi160: 'accelerometer', mpu9250: 'accelerometer', icm20948: 'accelerometer',
  mcu: 'mcu', printer: 'printer',
};

function isDynamicSubComponentType(sectionType: string): boolean {
  return STEPPER_SECTION_RE.test(sectionType) || EXTRUDER_SECTION_RE.test(sectionType);
}

function getComponentGroup(sectionType: string, isFeature = false): string {
  if (STEPPER_SECTION_RE.test(sectionType)) return 'stepper';
  if (EXTRUDER_SECTION_RE.test(sectionType)) return 'extruder';
  return COMPONENT_GROUP_MAP[sectionType] || (isFeature ? sectionType : 'other');
}

// Hardware type → color mapping (shared with edge coloring)
const HW_COLORS: Record<string, string> = {
  sbc: '#22c55e',
  mainboard: '#38bdf8',
  toolhead: '#f472b6',
  expander: '#a78bfa',
  config_file: '#0f766e',
  probe: '#ec4899',
  accelerometer: '#84cc16',
  other: '#64748b',
};

function getHardwareColor(hwType: string): string {
  return HW_COLORS[hwType] || HW_COLORS.other;
}

/**
 * Detect the communication type for a hardware node by inspecting its MCU section
 * in the config store. Returns the comm type if determinable, or 'usb' as fallback.
 */
function detectNodeCommType(nodeData: Record<string, unknown>): CommunicationType {
  const configFile = nodeData.configFile as string;
  const mcuName = (nodeData.mcuName as string) ?? '';
  if (!configFile) return 'usb';
  const config = useConfigStore.getState().configFiles[configFile];
  if (!config) return 'usb';
  const mcuSection = config.sections.find(
    (s) => s.section_type === 'mcu' && s.section_name === mcuName,
  );
  if (!mcuSection) return 'usb';
  for (const param of mcuSection.params) {
    if (param.is_commented_out) continue;
    if (param.key === 'canbus_uuid' || param.key === 'canbus_interface') return 'canbus';
    if (param.key === 'serial') {
      const val = param.value;
      if (val.includes('/dev/serial/by-id/usb-')) return 'usb';
      if (/\/dev\/tty(S|AMA|ACM|USB)/.test(val)) return 'uart';
      if (val.includes('/tmp/klipper_host_mcu')) return 'usb';
    }
  }
  return 'usb';
}

// ── Container layout constants ────────────────────────────────
/** Total width of a hardware container node */
const CONTAINER_WIDTH = 400;
/** Height reserved for the hardware node header/info area */
const CONTAINER_HEADER_HEIGHT = 110;
/** Vertical slot size per child node (compact tiles) */
const CHILD_SLOT_HEIGHT = 40;
/** Padding below last child row */
const CONTAINER_PADDING_BOTTOM = 16;
/** X position (relative to parent) for left-column children (features) */
const CHILD_LEFT_X = 12;
/** X position (relative to parent) for right-column children (sub-components) */
const CHILD_RIGHT_X = 208;
/** Height of a hardware node when collapsed (just the header) */
const COLLAPSED_HEIGHT = 56;
/** Width of a hardware node when collapsed */
const COLLAPSED_WIDTH = 200;

/** Height of a compact tile's header row */
const TILE_HEADER_HEIGHT = 36;
/** Height per item row in an expanded GroupNode body */
const GROUP_ITEM_HEIGHT = 22;
/** Vertical padding inside the expanded GroupNode body (top + bottom) */
const GROUP_BODY_PADDING = 12;
/** Gap between tiles in a column */
const TILE_GAP = 4;
/** Base stacking for top-level hardware cards */
const HARDWARE_Z_INDEX = 0;
/** Elevated stacking for the selected parent hardware card */
const SELECTED_PARENT_Z_INDEX = 100;
/** Child cards should always render above major component cards */
const CHILD_NODE_Z_INDEX = 200;
/** Selected child cards stay above sibling cards and action overlays */
const ACTIVE_CHILD_Z_INDEX = 300;
/** Shared canvas snap size for manual placement and auto-arrange anchors */
const GRID_SIZE = 20;

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function normalizeAxisComponent(value: number): number {
  if (Math.abs(value) < 1e-9) return 0;
  if (Math.abs(value - 1) < 1e-9) return 1;
  if (Math.abs(value + 1) < 1e-9) return -1;
  return value;
}

function getNodeSlotHeight(node: AppNode, selectedId: string | null): number {
  if (node.type === 'group' && node.id === selectedId) {
    const ch = (node.data as Record<string, unknown>).children as unknown[];
    const cnt = Array.isArray(ch) ? ch.length : 0;
    const bodyH = cnt * GROUP_ITEM_HEIGHT + GROUP_BODY_PADDING;
    return TILE_HEADER_HEIGHT + bodyH + TILE_GAP;
  }
  return CHILD_SLOT_HEIGHT;
}

function computeHardwareSize(leftCount: number, rightCount: number) {
  const rows = Math.max(leftCount, rightCount, 0);
  const height = CONTAINER_HEADER_HEIGHT + rows * CHILD_SLOT_HEIGHT + CONTAINER_PADDING_BOTTOM;
  return { width: CONTAINER_WIDTH, height: Math.max(height, 160) };
}

type SectionRef = {
  sectionHeader: string;
  sectionLineNumber?: number;
};

function matchesSectionRef(section: { full_header: string; line_number: number }, ref: SectionRef): boolean {
  if (section.full_header !== ref.sectionHeader) return false;
  if (ref.sectionLineNumber == null || ref.sectionLineNumber === 0) return true;
  return section.line_number === ref.sectionLineNumber;
}

function sectionIdentity(sectionHeader: string, sectionLineNumber?: number): string {
  return `${sectionHeader}#${sectionLineNumber ?? 0}`;
}

function sectionIdentityForSection(section: { full_header: string; line_number: number }): string {
  return sectionIdentity(section.full_header, section.line_number);
}

function cloneSnapshot<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function revalidateConfigFiles(configFiles: Record<string, ConfigFile>): void {
  const configStore = useConfigStore.getState();
  for (const filename of Object.keys(configFiles)) {
    void configStore.revalidateFile(filename);
  }
}

function getSectionSnapshot(
  configFile: string,
  sectionHeader: string,
  sectionType: string,
  sectionLineNumber?: number,
): ConfigSection {
  const section = useConfigStore.getState().getSection(configFile, sectionHeader, sectionLineNumber);
  if (section) {
    return cloneSnapshot(section);
  }

  return {
    section_type: sectionType,
    section_name: '',
    full_header: sectionHeader,
    line_number: sectionLineNumber ?? 0,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
  };
}

function removeNodesFromGraph(nodes: AppNode[], edges: AppEdge[], id: string) {
  const removedIds = new Set<string>();
  const queue = [id];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (removedIds.has(currentId)) continue;
    removedIds.add(currentId);
    for (const node of nodes) {
      if (node.parentId === currentId && !removedIds.has(node.id)) {
        queue.push(node.id);
      }
    }
  }

  return {
    nodes: nodes.filter((node) => !removedIds.has(node.id)),
    edges: edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)),
  };
}

interface GraphState {
  nodes: AppNode[];
  edges: AppEdge[];
  selectedNodeId: string | null;
  dragHoverHardwareId: string | null;

  /* React Flow callbacks */
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  /* Node operations */
  addNode: (node: AppNode) => void;
  removeNode: (id: string) => void;
  removeNodeFromGraph: (id: string) => void;
  duplicateNode: (id: string) => void;
  updateNodeData: (id: string, data: Partial<AppNode['data']>) => void;
  setSelectedNode: (id: string | null) => void;
  setDragHoverHardwareId: (id: string | null) => void;

  /* Edge operations */
  addEdge: (edge: AppEdge) => void;
  removeEdge: (id: string) => void;
  updateEdgeData: (id: string, data: Partial<AppEdge['data']>) => void;
  repointConfigEdge: (id: string, newSourceId: string, newTargetId: string) => void;
  selectedEdgeId: string | null;
  setSelectedEdge: (id: string | null) => void;

  /* Hardware node helpers */
  addHardwareNode: (
    type: HardwareType,
    label: string,
    configFile: string,
    position?: { x: number; y: number },
    mcuName?: string,
  ) => string;

  toggleHardwareCollapse: (id: string) => void;

  addCustomGroupNode: (
    label: string,
    color: string,
    position?: { x: number; y: number },
    parentId?: string,
  ) => string;

  reparentNode: (
    nodeId: string,
    newParentId: string | null,
    absolutePos?: { x: number; y: number },
  ) => void;

  snapChildrenToColumns: (
    parentId: string,
    draggedNodeId: string,
    draggedY: number,
  ) => void;

  reflowParentChildren: (parentId: string) => void;

  addSubComponentNode: (
    parentId: string,
    sectionType: string,
    label: string,
    sectionHeader: string,
    configFile?: string,
    sectionLineNumber?: number,
  ) => string;

  addFeatureNode: (
    parentId: string,
    sectionType: string,
    label: string,
    sectionHeader: string,
    configFile?: string,
    sectionLineNumber?: number,
  ) => string;

  addGroupNode: (
    parentId: string,
    componentGroup: string,
    label: string,
    children: Array<{
      sectionType: string;
      label: string;
      sectionHeader: string;
      sectionLineNumber?: number;
      isFeature: boolean;
      params: Array<{ key: string; value: string }>;
      configFile?: string;
    }>,
    isFeature: boolean,
    configFile?: string,
  ) => string;

  removeFromGroup: (groupNodeId: string, childIndex: number) => void;

  addCommunicationEdge: (sourceId: string, targetId: string, commType: CommunicationType, sourceHandle?: string, targetHandle?: string, isNotIncluded?: boolean) => string;
  addConfigurationEdge: (sourceId: string, targetId: string, hwType: HardwareType, sourceHandle?: string, targetHandle?: string) => string;

  /* Bulk */
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: AppEdge[]) => void;
  clearGraph: () => void;

  /* Sync graph with config store after text edits */
  syncGraphWithConfig: (filename: string) => void;

  /* Auto-arrange */
  autoArrange: () => void;
  fitViewTrigger: number;

  /* Undo / Redo */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  pushHistory: () => void;
}

let nodeIdCounter = 0;
let edgeIdCounter = 0;

function nextNodeId(): string {
  return `node_${++nodeIdCounter}`;
}
function nextEdgeId(): string {
  return `edge_${++edgeIdCounter}`;
}

// ── History for undo/redo ─────────────────────────────────────────
interface HistoryEntry {
  nodes: AppNode[];
  edges: AppEdge[];
  configFiles: Record<string, ConfigFile>;
  activeFile: string;
}
const MAX_HISTORY = 50;
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];

/**
 * Sort nodes so that parent nodes always appear before their children.
 * ReactFlow requires this ordering to avoid "Parent node not found" errors.
 */
function sortNodesParentsFirst(nodes: AppNode[]): AppNode[] {
  const parentless: AppNode[] = [];
  const childrenByParent = new Map<string, AppNode[]>();
  for (const n of nodes) {
    if (!n.parentId) {
      parentless.push(n);
    } else {
      const list = childrenByParent.get(n.parentId) || [];
      list.push(n);
      childrenByParent.set(n.parentId, list);
    }
  }
  const result: AppNode[] = [];
  for (const n of parentless) {
    result.push(n);
    const children = childrenByParent.get(n.id);
    if (children) result.push(...children);
  }
  // Include orphans (parent not in current array) at the end
  const inResult = new Set(result.map((n) => n.id));
  for (const n of nodes) {
    if (!inResult.has(n.id)) result.push(n);
  }
  return result;
}

/**
 * Remove the config-model sections (or config file for hardware) backing a
 * node. Shared by removeNode and onNodesChange so the Delete key and the ✕
 * button can't drift apart. Does NOT touch the graph store — callers decide
 * when to pushHistory and how to apply the node removal.
 *
 * For hardware nodes the config FILE is only deleted when no other hardware
 * node still references it — two boards can share one multi-MCU file, and
 * deleting one board must not delete the other's sections.
 */
function cleanupRemovedNodeConfig(
  node: AppNode,
  configStore: ReturnType<typeof useConfigStore.getState>,
  allNodes: AppNode[],
): void {
  const d = node.data as Record<string, unknown>;
  const configFile = d.configFile as string | undefined;
  if (!configFile) return;

  if (node.type === 'subComponent' || node.type === 'feature') {
    const sectionHeader = d.sectionHeader as string | undefined;
    if (sectionHeader) {
      configStore.removeSection(configFile, sectionHeader, d.sectionLineNumber as number | undefined);
    }
  } else if (node.type === 'group') {
    const children = d.children as Array<{ sectionHeader: string; sectionLineNumber?: number; configFile?: string }> | undefined;
    if (children) {
      for (const child of children) {
        const childFile = child.configFile || configFile;
        if (child.sectionHeader) {
          configStore.removeSection(childFile, child.sectionHeader, child.sectionLineNumber);
        }
      }
    }
  } else if (node.type === 'hardware') {
    // Only delete the config file if no OTHER hardware node references it
    const stillReferenced = allNodes.some(
      (n) => n.id !== node.id && n.type === 'hardware'
        && (n.data as Record<string, unknown>).configFile === configFile,
    );
    if (!stillReferenced) {
      configStore.removeConfigFile(configFile);
    }
  }
}

/** Module-level flag: deleteElements fires edge removes before node removes in
 *  the same batch. Set while that batch is in flight so onNodesChange skips its
 *  duplicate history push (the edge push already captured the full state). */
let edgeRemoveBatchPending = false;

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  dragHoverHardwareId: null,
  selectedEdgeId: null,
  fitViewTrigger: 0,

  onNodesChange: (changes) => {
    // ReactFlow dispatches Delete-key node removals through onNodesChange as
    // { type: 'remove' } changes. Route them through the same config cleanup
    // as removeNode so the section is deleted from the config model (not just
    // the graph) and the action is undoable — otherwise the section
    // resurrects on the next syncGraphWithConfig and Ctrl+Z does nothing.
    //
    // deleteElements fires edge removes BEFORE node removes (same batch), and
    // onEdgesChange already pushed a full history snapshot that includes the
    // edges. Pushing again here would snapshot the POST-edge-removal state,
    // so Ctrl+Z would restore the node but not its connection lines. Skip the
    // duplicate push when an edge-remove batch is pending; trash-can deletes
    // (removeNode) are unaffected (single push).
    const removes = changes.filter((c) => c.type === 'remove');
    if (removes.length > 0) {
      if (!edgeRemoveBatchPending) {
        get().pushHistory();
      }
      edgeRemoveBatchPending = false;
      const configStore = useConfigStore.getState();
      const nodesSnapshot = get().nodes;
      for (const change of removes) {
        const id = (change as { id: string }).id;
        const node = nodesSnapshot.find((n) => n.id === id);
        if (node) cleanupRemovedNodeConfig(node, configStore, nodesSnapshot);
      }
    }
    set((s) => ({
      nodes: sortNodesParentsFirst(applyNodeChanges(changes, s.nodes) as AppNode[]),
    }));
  },

  onEdgesChange: (changes) => {
    // Clean up includes for removed configuration edges between hardware nodes
    const removes = changes.filter((c) => c.type === 'remove');
    if (removes.length > 0) {
      // Mark this batch so onNodesChange (fired later by deleteElements) knows
      // the history push already captured the full pre-delete state. Cleared
      // on a microtask: deleteElements fires edge+node triggers synchronously,
      // so the flag is only visible to that same batch — a standalone edge
      // delete (no node changes follow) must not leak the flag forward.
      edgeRemoveBatchPending = true;
      queueMicrotask(() => { edgeRemoveBatchPending = false; });
      get().pushHistory();
      const { nodes, edges } = get();
      removes.forEach((c) => {
        const edge = edges.find((e) => e.id === (c as { id: string }).id);
        if (!edge || (edge.data as Record<string, unknown>)?.edgeType !== 'configuration') return;
        const srcNode = nodes.find((n) => n.id === edge.source);
        const tgtNode = nodes.find((n) => n.id === edge.target);
        if (srcNode?.type !== 'hardware' || tgtNode?.type !== 'hardware') return;
        const srcFile = (srcNode.data as Record<string, unknown>).configFile as string;
        const tgtFile = (tgtNode.data as Record<string, unknown>).configFile as string;
        // Mirror onConnect's include direction: the include always lives in the
        // primary (printer.cfg) file, NOT determined by edge drag direction.
        // A redrawn edge can flip source/target, so keying off direction here
        // would try to comment an include inside the wrong file and silently
        // leave [include toolhead_board.cfg] active.
        const srcIsPrimary = Boolean((srcNode.data as Record<string, unknown>).isPrimary) || srcFile === 'printer.cfg';
        const tgtIsPrimary = Boolean((tgtNode.data as Record<string, unknown>).isPrimary) || tgtFile === 'printer.cfg';
        if (srcIsPrimary && !tgtIsPrimary) {
          useConfigStore.getState().removeInclude(srcFile, tgtFile);
        } else {
          useConfigStore.getState().removeInclude(tgtFile, srcFile);
        }
      });
    }
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges) as AppEdge[],
    }));
  },

  onConnect: (connection) => {
    if (!connection.source || !connection.target) return;
    get().pushHistory();
    const { nodes, edges } = get();
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const srcType = sourceNode.type;
    const tgtType = targetNode.type;
    const srcData = sourceNode.data as Record<string, unknown>;
    const tgtData = targetNode.data as Record<string, unknown>;

    // Sub-component/feature → hardware: relationship is now established via parentId, ignore
    if ((srcType === 'subComponent' || srcType === 'feature') && tgtType === 'hardware') {
      return;
    }

    // Hardware ↔ hardware
    if (srcType === 'hardware' && tgtType === 'hardware') {
      const srcHwType = srcData.hardwareType as string;
      const tgtHwType = tgtData.hardwareType as string;
      const involvesSbc = srcHwType === 'sbc' || tgtHwType === 'sbc';

      // Remove any existing edge between this pair
      const existing = edges.filter(
        (e) =>
          (e.source === connection.source && e.target === connection.target) ||
          (e.source === connection.target && e.target === connection.source)
      );

      const id = nextEdgeId();

      if (involvesSbc) {
        // Communication edge (USB/CAN/UART) between SBC and hardware.
        // Default to the comm type already defined in the non-SBC node's MCU config.
        const hwNodeData = srcHwType === 'sbc' ? tgtData : srcData;
        const detectedCommType = detectNodeCommType(hwNodeData);
        const newEdge: AppEdge = {
          id,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          data: { edgeType: 'communication', commType: detectedCommType },
          type: 'communication',
        };
        set((s) => ({
          edges: [...s.edges.filter((e) => !existing.some((ex) => ex.id === e.id)), newEdge],
        }));
      } else {
        // Configuration edge (import relationship) between non-SBC hardware components
        // The source node's configFile gets included into the target's configFile.
        // Find which node is printer.cfg (primary/target) to add the include there.
        const srcConfigFile = srcData.configFile as string;
        const tgtConfigFile = tgtData.configFile as string;
        const srcIsPrimary = Boolean(srcData.isPrimary) || srcConfigFile === 'printer.cfg';
        const tgtIsPrimary = Boolean(tgtData.isPrimary) || tgtConfigFile === 'printer.cfg';
        const color = getHardwareColor(srcHwType);
        // Normalize direction: the edge always points FROM the included
        // (non-primary) node TO the including (primary) node, mirroring
        // graphBuilder's convention. Draw direction is arbitrary; showing it
        // verbatim would label the primary as "source" half the time.
        // When the primary was drawn as source, swap so the non-primary
        // (included) node becomes the source.
        const swapDirection = srcIsPrimary && !tgtIsPrimary;
        const normalizedSource = swapDirection ? connection.target : connection.source;
        const normalizedTarget = swapDirection ? connection.source : connection.target;
        const newEdge: AppEdge = {
          id,
          source: normalizedSource,
          target: normalizedTarget,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          data: { edgeType: 'configuration', sourceHardwareType: srcHwType as HardwareType, color },
          type: 'configuration',
        };
        set((s) => ({
          edges: [...s.edges.filter((e) => !existing.some((ex) => ex.id === e.id)), newEdge],
        }));
        // Only touch the include relationship when this pair wasn't already
        // connected. Redrawing an existing edge (e.g. toolhead↔mainboard)
        // would otherwise remove→re-add the identical include, marking the
        // config dirty with a blank diff. Direction never matters here: the
        // include target is decided by which node holds printer.cfg, so
        // redrawing the same pair in either direction changes nothing.
        if (existing.length === 0) {
          // Include handling:
          // - If one side is primary/printer.cfg, always include non-primary in printer.cfg.
          // - Otherwise preserve drag direction (target includes source).
          if (srcIsPrimary && !tgtIsPrimary) {
            useConfigStore.getState().addInclude(srcConfigFile, tgtConfigFile);
          } else {
            useConfigStore.getState().addInclude(tgtConfigFile, srcConfigFile);
          }
        }
      }
      return;
    }

    // Default: configuration edge
    const id = nextEdgeId();
    const color = getHardwareColor((tgtData?.hardwareType as string) || (srcData?.hardwareType as string) || 'other');
    const newEdge: AppEdge = {
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
      data: { edgeType: 'configuration', sourceHardwareType: 'other', color },
      type: 'configuration',
    };
    set((s) => ({ edges: [...s.edges, newEdge] }));
  },

  addNode: (node) => { get().pushHistory(); set((s) => ({ nodes: sortNodesParentsFirst([...s.nodes, node]) })); },
  removeNode: (id) => {
    get().pushHistory();
    const state = get();
    const node = state.nodes.find((n) => n.id === id);

    // Collect all nodes being removed (the target + its children)
    const childNodes = state.nodes.filter((n) => n.parentId === id);
    const removedNodes = node ? [node, ...childNodes] : childNodes;

    // Remove corresponding config sections for each removed node
    const configStore = useConfigStore.getState();
    const allNodes = state.nodes;
    for (const rn of removedNodes) {
      cleanupRemovedNodeConfig(rn, configStore, allNodes);
    }

    set((s) => {
      const removedIds = new Set(removedNodes.map((n) => n.id));
      return {
        nodes: s.nodes.filter((n) => !removedIds.has(n.id)),
        edges: s.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target)),
      };
    });
  },

  removeNodeFromGraph: (id) => {
    set((s) => removeNodesFromGraph(s.nodes, s.edges, id));
  },

  duplicateNode: (id) => {
    get().pushHistory();
    const state = get();
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    const newId = nextNodeId();

    // For sub-components, features, and groups: duplicate config sections too
    const configStore = useConfigStore.getState();
    const d = node.data as Record<string, unknown>;
    let cloneData = { ...node.data };

    // Helper: build set of all existing section headers across all config files
    const buildAllHeaders = () => {
      const allHeaders = new Set<string>();
      for (const cfx of Object.values(configStore.configFiles)) {
        for (const s of cfx.sections) allHeaders.add(s.full_header);
      }
      return allHeaders;
    };

    // Helper: generate a unique section name by incrementing a counter suffix
    const incrementSectionName = (originalSection: { section_type: string; section_name: string; full_header: string }, allHeaders: Set<string>) => {
      if (isDynamicSubComponentType(originalSection.section_type)) {
        const allSections = Object.values(configStore.configFiles).flatMap((configFile) => configFile.sections);
        const draft = buildUniqueSectionDraft(
          originalSection.section_type,
          originalSection.full_header,
          undefined,
          allSections,
        );
        allHeaders.add(draft.fullHeader);
        return {
          newSectionType: draft.sectionType,
          newName: draft.sectionName,
          newHeader: draft.fullHeader,
        };
      }

      const baseName = originalSection.section_name || originalSection.section_type;
      let counter = 2;
      let newName = `${baseName}_${counter}`;
      let newHeader = `${originalSection.section_type} ${newName}`;
      while (allHeaders.has(newHeader)) {
        counter++;
        newName = `${baseName}_${counter}`;
        newHeader = `${originalSection.section_type} ${newName}`;
      }
      // Add to set so subsequent calls within same batch don't collide
      allHeaders.add(newHeader);
      return { newSectionType: originalSection.section_type, newName, newHeader };
    };

    if (node.type === 'hardware') {
      // Duplicate hardware node: create a new config file, copy all sections with incremented names
      const srcConfigFile = d.configFile as string | undefined;
      const srcLabel = (d.label as string) || '';
      const srcMcuName = (d.mcuName as string) || '';
      const hwType = (d.hardwareType as string) || 'other';

      if (srcConfigFile) {
        // Generate a unique MCU name
        const allMcuNames = new Set<string>();
        for (const cfx of Object.values(configStore.configFiles)) {
          for (const s of cfx.sections) {
            if (s.section_type === 'mcu') allMcuNames.add(s.section_name);
          }
        }
        const baseMcuName = srcMcuName || srcLabel.toLowerCase().replace(/\s+/g, '_') || 'mcu';
        let mcuCounter = 2;
        let newMcuName = `${baseMcuName}_${mcuCounter}`;
        while (allMcuNames.has(newMcuName)) {
          mcuCounter++;
          newMcuName = `${baseMcuName}_${mcuCounter}`;
        }

        // Generate a unique config filename
        const existingFiles = new Set(Object.keys(configStore.configFiles));
        const baseFilename = newMcuName.toLowerCase().replace(/\s+/g, '_');
        let newConfigFile = `${baseFilename}.cfg`;
        let fileCounter = 2;
        while (existingFiles.has(newConfigFile)) {
          newConfigFile = `${baseFilename}_${fileCounter}.cfg`;
          fileCounter++;
        }

        // Copy sections from source config, renaming MCU section. Drop
        // [include] (a clone shouldn't re-include the source's children) and
        // [printer] (unique to the primary board — duplicating it into a
        // non-primary file is invalid).
        const srcCf = configStore.configFiles[srcConfigFile];
        if (srcCf) {
          const newSections = srcCf.sections
            .filter((s) => s.section_type !== 'include' && s.section_type !== 'printer')
            .map((s) => {
              if (s.section_type === 'mcu') {
                return {
                  ...s,
                  section_name: newMcuName,
                  full_header: `mcu ${newMcuName}`,
                  params: s.params.map((p) => ({ ...p })),
                };
              }
              return {
                ...s,
                params: s.params.map((p) => ({ ...p })),
              };
            });

          // Rewrite pin prefixes (step_pin: mainboard:PA0 → mainboard_2:PA0)
          // so the clone references the NEW mcu, not a stale pointer to the
          // source board. Mirrors reparentNode's MCU-context change.
          const finalSections = updateAllSectionPins(newSections, srcMcuName, newMcuName, configStore.schemas);

          // Create the new config file
          configStore.updateConfigFile(newConfigFile, {
            filename: newConfigFile,
            sections: finalSections,
            includes: [],
            header_comments: [...srcCf.header_comments],
          });

          // Update clone data
          (cloneData as Record<string, unknown>).configFile = newConfigFile;
          (cloneData as Record<string, unknown>).mcuName = newMcuName;
          (cloneData as Record<string, unknown>).label = newMcuName;
          (cloneData as Record<string, unknown>).isPrimary = false;

          // Clone the hardware node first
          const clone: AppNode = {
            ...node,
            id: newId,
            position: { x: node.position.x + 40, y: node.position.y + 40 },
            data: cloneData,
            selected: false,
          } as AppNode;
          set((s) => ({ nodes: sortNodesParentsFirst([...s.nodes, clone]) }));

          // Copy child nodes (sub-components, features, groups) from the original hardware node
          const childNodes = state.nodes.filter((n) => n.parentId === id);
          for (const child of childNodes) {
            const childId = nextNodeId();
            const childData = { ...child.data } as Record<string, unknown>;
            childData.configFile = newConfigFile;
            if (child.type === 'subComponent' || child.type === 'feature') {
              childData.parentHardwareId = newId;
            } else if (child.type === 'group') {
              childData.parentHardwareId = newId;
            }
            const childClone: AppNode = {
              ...child,
              id: childId,
              parentId: newId,
              position: { ...child.position },
              data: childData,
              selected: false,
            } as AppNode;
            set((s) => ({ nodes: sortNodesParentsFirst([...s.nodes, childClone]) }));
          }

          // Add communication edge from SBC if one exists for the original
          const sbcNode = state.nodes.find(
            (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).hardwareType === 'sbc',
          );
          if (sbcNode && hwType !== 'sbc') {
            const commType = detectNodeCommType(cloneData as Record<string, unknown>);
            get().addCommunicationEdge(sbcNode.id, newId, commType);
          }

          return;
        }
      }
    } else if (node.type === 'subComponent' || node.type === 'feature') {
      const configFile = d.configFile as string | undefined;
      const sectionHeader = d.sectionHeader as string | undefined;
      const sectionLineNumber = d.sectionLineNumber as number | undefined;
      if (configFile && sectionHeader) {
        const originalSection = configStore.getSection(configFile, sectionHeader, sectionLineNumber);
        if (originalSection) {
          const allHeaders = buildAllHeaders();
          const { newSectionType, newName, newHeader } = incrementSectionName(originalSection, allHeaders);
          // Add the duplicated section to the config store
          configStore.addSection(configFile, {
            ...originalSection,
            section_type: newSectionType,
            section_name: newName,
            full_header: newHeader,
            line_number: 0,
            params: originalSection.params.map((p) => ({ ...p })),
          });
          (cloneData as Record<string, unknown>).sectionType = newSectionType;
          (cloneData as Record<string, unknown>).sectionHeader = newHeader;
          (cloneData as Record<string, unknown>).sectionLineNumber = 0;
          (cloneData as Record<string, unknown>).label = newName ? `${d.label || originalSection.section_type}: ${newName}` : newHeader;
        }
      }
    } else if (node.type === 'group') {
      const children = d.children as Array<{ sectionType: string; label: string; sectionHeader: string; sectionLineNumber?: number; configFile?: string }> | undefined;
      if (children) {
        const allHeaders = buildAllHeaders();
        const newChildren = children.map((child) => {
          const childFile = child.configFile || (d.configFile as string);
          const originalSection = configStore.getSection(childFile, child.sectionHeader, child.sectionLineNumber);
          if (originalSection) {
            const { newSectionType, newName, newHeader } = incrementSectionName(originalSection, allHeaders);
            configStore.addSection(childFile, {
              ...originalSection,
              section_type: newSectionType,
              section_name: newName,
              full_header: newHeader,
              line_number: 0,
              params: originalSection.params.map((p) => ({ ...p })),
            });
            return {
              ...child,
              sectionType: newSectionType,
              sectionHeader: newHeader,
              sectionLineNumber: 0,
              label: newName ? `${child.sectionType}: ${newName}` : newHeader,
            };
          }
          return child;
        });
        (cloneData as Record<string, unknown>).children = newChildren;
      }
    }

    const clone: AppNode = {
      ...node,
      id: newId,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      data: cloneData,
      selected: false,
    } as AppNode;
    set((s) => ({ nodes: sortNodesParentsFirst([...s.nodes, clone]) }));
  },

  updateNodeData: (id, data) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
      ) as AppNode[],
    })),

  setSelectedNode: (id) => {
    const prevId = get().selectedNodeId;
    set({ selectedNodeId: id });

    const prevNode = get().nodes.find((n) => n.id === prevId);
    const newNode = id ? get().nodes.find((n) => n.id === id) : null;
    const prevParentId = prevNode?.parentId;
    const newParentId = newNode?.parentId;

    set((s) => ({
      nodes: s.nodes.map((n) => {
        const isChildNode = n.type === 'subComponent' || n.type === 'feature' || n.type === 'group' || n.type === 'customGroup';
        if (isChildNode && n.id === prevId && n.id !== id) return { ...n, zIndex: CHILD_NODE_Z_INDEX };
        if (isChildNode && n.id === id) return { ...n, zIndex: ACTIVE_CHILD_Z_INDEX };
        if (n.id === prevParentId && n.id !== newParentId) return { ...n, zIndex: HARDWARE_Z_INDEX };
        if (n.id === newParentId) return { ...n, zIndex: SELECTED_PARENT_Z_INDEX };
        return n;
      }) as AppNode[],
    }));

    // Reflow the parent of the old selection
    if (prevId && prevId !== id) {
      if (prevParentId) get().reflowParentChildren(prevParentId);
    }
    // Reflow the parent of the new selection
    if (id) {
      if (newParentId) get().reflowParentChildren(newParentId);
    }
  },

  setDragHoverHardwareId: (id) => set({ dragHoverHardwareId: id }),

  addEdge: (edge) => set((s) => ({ edges: [...s.edges, edge] })),
  removeEdge: (id) => {
    get().pushHistory();
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }));
  },
  setSelectedEdge: (id) => set({ selectedEdgeId: id }),

  updateEdgeData: (id, data) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, data: { ...e.data, ...data } } : e,
      ) as AppEdge[],
    })),

  repointConfigEdge: (id, newSourceId, newTargetId) => {
    const { edges, nodes } = get();
    const edge = edges.find((e) => e.id === id);
    if (!edge) return;
    const configStore = useConfigStore.getState();

    // Snapshot BEFORE any mutation so one undo restores edge + includes.
    get().pushHistory();

    // Resolve the file include that the OLD edge represents, then comment it out
    const oldSrc = nodes.find((n) => n.id === edge.source);
    const oldTgt = nodes.find((n) => n.id === edge.target);
    const oldSrcFile = (oldSrc?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
    const oldTgtFile = (oldTgt?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
    if (oldSrcFile && oldTgtFile && oldSrcFile !== oldTgtFile) {
      const oldSrcPrimary = Boolean((oldSrc?.data as Record<string, unknown> | undefined)?.isPrimary) || oldSrcFile === 'printer.cfg';
      if (oldSrcPrimary) {
        configStore.removeInclude(oldSrcFile, oldTgtFile);
      } else {
        configStore.removeInclude(oldTgtFile, oldSrcFile);
      }
    }

    // Update the edge to point at the new pair (normalized: included → primary)
    const newSrc = nodes.find((n) => n.id === newSourceId);
    const newTgt = nodes.find((n) => n.id === newTargetId);
    const newSrcFile = (newSrc?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
    const newTgtFile = (newTgt?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
    const newSrcPrimary = Boolean((newSrc?.data as Record<string, unknown> | undefined)?.isPrimary) || newSrcFile === 'printer.cfg';
    const newTgtPrimary = Boolean((newTgt?.data as Record<string, unknown> | undefined)?.isPrimary) || newTgtFile === 'printer.cfg';
    const normalizedSource = newTgtPrimary && !newSrcPrimary ? newTargetId : newSourceId;
    const normalizedTarget = newTgtPrimary && !newSrcPrimary ? newSourceId : newTargetId;

    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, source: normalizedSource, target: normalizedTarget } : e,
      ) as AppEdge[],
    }));

    // Add the include for the new pair (primary includes non-primary)
    if (newSrcFile && newTgtFile && newSrcFile !== newTgtFile) {
      if (newSrcPrimary && !newTgtPrimary) {
        configStore.addInclude(newSrcFile, newTgtFile);
      } else {
        configStore.addInclude(newTgtFile, newSrcFile);
      }
    }
  },

  addHardwareNode: (hwType, label, configFile, position, mcuName) => {
    const id = nextNodeId();
    const pos = position || { x: Math.random() * 600, y: Math.random() * 400 };
    const { width, height } = computeHardwareSize(0, 0);
    const node: Node = {
      id,
      type: 'hardware',
      position: pos,
      zIndex: HARDWARE_Z_INDEX,
      style: { width, height },
      data: {
        label,
        hardwareType: hwType,
        configFile,
        mcuName: mcuName ?? '',
        sections: [],
        hasErrors: false,
        validationStatus: 'valid',
      },
    };
    set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
    return id;
  },

  addSubComponentNode: (parentId, sectionType, label, sectionHeader, configFile, sectionLineNumber) => {
    const id = nextNodeId();

    // Resolve config file from parent hardware node if not provided
    const resolvedFile = configFile || (() => {
      if (!parentId) return '';
      const parent = get().nodes.find((n) => n.id === parentId);
      return (parent?.data as Record<string, unknown>)?.configFile as string || '';
    })();

    // Determine component group from section type
    const componentGroup = getComponentGroup(sectionType);
    const sectionSnapshot = getSectionSnapshot(resolvedFile, sectionHeader, sectionType, sectionLineNumber);

    // If no parent, place as standalone top-level node
    if (!parentId) {
      const node: Node = {
        id,
        type: 'subComponent',
        position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
        zIndex: CHILD_NODE_Z_INDEX,
        data: {
          label,
          sectionType,
          sectionHeader,
          sectionLineNumber,
          componentGroup,
          section: sectionSnapshot,
          parentHardwareId: null,
          configFile: resolvedFile,
          hasErrors: false,
          validationStatus: 'valid',
          isStandalone: true,
        },
      };
      set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
      return id;
    }

    // Count current right-side children (sub-components + non-feature groups)
    const rightChildren = get().nodes.filter((n) => {
      if (n.parentId !== parentId) return false;
      const d = n.data as Record<string, unknown>;
      return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
    });
    const rightIdx = rightChildren.length;

    // Position is relative to the parent hardware node
    const pos = { x: CHILD_RIGHT_X, y: CONTAINER_HEADER_HEIGHT + rightIdx * CHILD_SLOT_HEIGHT };

    const node: Node = {
      id,
      type: 'subComponent',
      position: pos,
      parentId,
      zIndex: CHILD_NODE_Z_INDEX,
      data: {
        label,
        sectionType,
        sectionHeader,
        sectionLineNumber,
        componentGroup,
        section: sectionSnapshot,
        parentHardwareId: parentId,
        configFile: resolvedFile,
        hasErrors: false,
          validationStatus: 'valid',
      },
    };

    set((s) => {
      // Recompute parent container size
      const leftCount = s.nodes.filter((n) => {
        if (n.parentId !== parentId) return false;
        const d = n.data as Record<string, unknown>;
        return n.type === 'feature' || (n.type === 'group' && d.isFeature);
      }).length;
      const newRightCount = rightIdx + 1;
      const { width, height } = computeHardwareSize(leftCount, newRightCount);

      return {
        nodes: sortNodesParentsFirst([
          ...s.nodes.map((n) =>
            n.id === parentId ? { ...n, style: { ...n.style, width, height } } : n,
          ),
          node as AppNode,
        ]),
        // No edge — parent relationship is established via parentId
      };
    });
    return id;
  },

  addFeatureNode: (parentId, sectionType, label, sectionHeader, configFile, sectionLineNumber) => {
    const id = nextNodeId();
    const componentGroup = getComponentGroup(sectionType, true);

    // Resolve config file from parent hardware node if not provided
    const resolvedFile = configFile || (() => {
      if (!parentId) return '';
      const parent = get().nodes.find((n) => n.id === parentId);
      return (parent?.data as Record<string, unknown>)?.configFile as string || '';
    })();
    const sectionSnapshot = getSectionSnapshot(resolvedFile, sectionHeader, sectionType, sectionLineNumber);

    // If no parent, place as standalone top-level node
    if (!parentId) {
      const node: Node = {
        id,
        type: 'feature',
        position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
        zIndex: CHILD_NODE_Z_INDEX,
        data: {
          label,
          sectionType,
          componentGroup,
          sectionHeader,
          sectionLineNumber,
          section: sectionSnapshot,
          parentId: null,
          configFile: resolvedFile,
          hasErrors: false,
          validationStatus: 'valid',
          isStandalone: true,
        },
      };
      set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
      return id;
    }

    // Count current left-side children (features + feature groups)
    const leftChildren = get().nodes.filter((n) => {
      if (n.parentId !== parentId) return false;
      const d = n.data as Record<string, unknown>;
      return n.type === 'feature' || (n.type === 'group' && d.isFeature);
    });
    const leftIdx = leftChildren.length;

    // Position is relative to the parent hardware node
    const pos = { x: CHILD_LEFT_X, y: CONTAINER_HEADER_HEIGHT + leftIdx * CHILD_SLOT_HEIGHT };

    const node: Node = {
      id,
      type: 'feature',
      position: pos,
      parentId,
      zIndex: CHILD_NODE_Z_INDEX,
      data: {
        label,
        sectionType,
        componentGroup,
        sectionHeader,
        sectionLineNumber,
        section: sectionSnapshot,
        parentId,
        configFile: resolvedFile,
        hasErrors: false,
          validationStatus: 'valid',
      },
    };

    set((s) => {
      // Recompute parent container size
      const rightCount = s.nodes.filter((n) => {
        if (n.parentId !== parentId) return false;
        const d = n.data as Record<string, unknown>;
        return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
      }).length;
      const newLeftCount = leftIdx + 1;
      const { width, height } = computeHardwareSize(newLeftCount, rightCount);

      return {
        nodes: sortNodesParentsFirst([
          ...s.nodes.map((n) =>
            n.id === parentId ? { ...n, style: { ...n.style, width, height } } : n,
          ),
          node as AppNode,
        ]),
      };
    });
    return id;
  },

  addGroupNode: (parentId, componentGroup, label, children, isFeature, configFile) => {
    const id = nextNodeId();

    // Resolve config file from parent hardware node if not provided
    const resolvedFile = configFile || (() => {
      const parent = get().nodes.find((n) => n.id === parentId);
      return (parent?.data as Record<string, unknown>)?.configFile as string || '';
    })();

    // Count siblings in the same column
    const sameColumnChildren = get().nodes.filter((n) => {
      if (n.parentId !== parentId) return false;
      const d = n.data as Record<string, unknown>;
      return isFeature
        ? n.type === 'feature' || (n.type === 'group' && d.isFeature)
        : n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
    });
    const colIdx = sameColumnChildren.length;

    // Position relative to parent hardware node
    const pos = {
      x: isFeature ? CHILD_LEFT_X : CHILD_RIGHT_X,
      y: CONTAINER_HEADER_HEIGHT + colIdx * CHILD_SLOT_HEIGHT,
    };

    const node: Node = {
      id,
      type: 'group',
      position: pos,
      parentId,
      zIndex: CHILD_NODE_Z_INDEX,
      data: {
        label,
        componentGroup,
        isFeature,
        children,
        parentHardwareId: parentId,
        configFile: resolvedFile,
        hasErrors: false,
        validationStatus: 'valid',
      },
    };

    set((s) => {
      // Recompute parent container size
      const leftCount = s.nodes.filter((n) => {
        if (n.parentId !== parentId) return false;
        const d = n.data as Record<string, unknown>;
        return n.type === 'feature' || (n.type === 'group' && d.isFeature);
      }).length;
      const rightCount = s.nodes.filter((n) => {
        if (n.parentId !== parentId) return false;
        const d = n.data as Record<string, unknown>;
        return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
      }).length;

      const newLeftCount = isFeature ? leftCount + 1 : leftCount;
      const newRightCount = isFeature ? rightCount : rightCount + 1;
      const { width, height } = computeHardwareSize(newLeftCount, newRightCount);

      return {
        nodes: sortNodesParentsFirst([
          ...s.nodes.map((n) =>
            n.id === parentId ? { ...n, style: { ...n.style, width, height } } : n,
          ),
          node as AppNode,
        ]),
      };
    });
    return id;
  },

  removeFromGroup: (groupNodeId, childIndex) => {
    get().pushHistory();
    const groupNode = get().nodes.find((n) => n.id === groupNodeId);
    if (!groupNode || groupNode.type !== 'group') return;
    const groupData = groupNode.data as GroupNodeData;
    const parentId = groupNode.parentId as string | undefined;
    const children = [...(groupData.children || [])];
    const [removedChild] = children.splice(childIndex, 1);
    if (!removedChild) return;

    if (children.length <= 1) {
      // Dissolve the group: remove it, add remaining + removed as standalone nodes
      set((s) => ({ nodes: s.nodes.filter((n) => n.id !== groupNodeId) as AppNode[] }));
      if (parentId) {
        if (children.length === 1) {
          const remaining = children[0];
          if (remaining.isFeature) {
            get().addFeatureNode(parentId, remaining.sectionType, remaining.label, remaining.sectionHeader, remaining.configFile, remaining.sectionLineNumber);
          } else {
            get().addSubComponentNode(parentId, remaining.sectionType, remaining.label, remaining.sectionHeader, remaining.configFile, remaining.sectionLineNumber);
          }
        }
        if (removedChild.isFeature) {
          get().addFeatureNode(parentId, removedChild.sectionType, removedChild.label, removedChild.sectionHeader, removedChild.configFile, removedChild.sectionLineNumber);
        } else {
          get().addSubComponentNode(parentId, removedChild.sectionType, removedChild.label, removedChild.sectionHeader, removedChild.configFile, removedChild.sectionLineNumber);
        }
        get().reflowParentChildren(parentId);
      }
    } else {
      // Remove child from group and add as standalone node
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === groupNodeId ? { ...n, data: { ...n.data, children } } : n
        ) as AppNode[],
      }));
      if (parentId) {
        if (removedChild.isFeature) {
          get().addFeatureNode(parentId, removedChild.sectionType, removedChild.label, removedChild.sectionHeader, removedChild.configFile, removedChild.sectionLineNumber);
        } else {
          get().addSubComponentNode(parentId, removedChild.sectionType, removedChild.label, removedChild.sectionHeader, removedChild.configFile, removedChild.sectionLineNumber);
        }
        get().reflowParentChildren(parentId);
      }
    }
  },

  toggleHardwareCollapse: (id) => {
    let isExpanding = false;
    set((s) => {
      const hwNode = s.nodes.find((n) => n.id === id);
      if (!hwNode) return s;
      const currentData = hwNode.data as Record<string, unknown>;
      const isCollapsed = !(currentData.collapsed as boolean);
      if (!isCollapsed) isExpanding = true; // isCollapsed=false means result is expanded

      // Compute expanded size based on current children
      const children = s.nodes.filter((n) => n.parentId === id);
      const leftCount = children.filter((n) => {
        const d = n.data as Record<string, unknown>;
        return n.type === 'feature' || (n.type === 'group' && d.isFeature);
      }).length;
      const rightCount = children.filter((n) => {
        const d = n.data as Record<string, unknown>;
        return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
      }).length;
      const expandedSize = computeHardwareSize(leftCount, rightCount);

      const newW = isCollapsed ? COLLAPSED_WIDTH : expandedSize.width;
      const newH = isCollapsed ? COLLAPSED_HEIGHT : expandedSize.height;

      // After changing this node's size, push other hardware nodes away to prevent overlap
      const GAP = 20;
      const otherHardware = s.nodes.filter(
        (n) => n.type === 'hardware' && n.id !== id && !n.parentId,
      );
      const newHwPos = { ...hwNode.position };

      // Build updated peer list with their current sizes so we can nudge them
      const peerPositions = new Map<string, { x: number; y: number }>();
      for (const peer of otherHardware) {
        const pw = (peer.style?.width as number) || COLLAPSED_WIDTH;
        const ph = (peer.style?.height as number) || COLLAPSED_HEIGHT;
        let px = peer.position.x;
        let py = peer.position.y;

        // Simple axis-aligned push: find if this peer overlaps the expanded node
        let iterations = 0;
        while (iterations++ < 50) {
          const overlapX =
            px < newHwPos.x + newW + GAP &&
            px + pw > newHwPos.x - GAP &&
            py < newHwPos.y + newH + GAP &&
            py + ph > newHwPos.y - GAP;

          if (!overlapX) break;
          // Push rightward (same strategy as drag-stop resolveOverlap)
          px = newHwPos.x + newW + GAP;
        }
        peerPositions.set(peer.id, { x: px, y: py });
      }

      return {
        nodes: s.nodes.map((n) => {
          if (n.id === id) {
            return {
              ...n,
              data: { ...n.data, collapsed: isCollapsed },
              style: {
                ...n.style,
                width: newW,
                height: newH,
              },
            };
          }
          if (n.parentId === id) {
            return { ...n, hidden: isCollapsed };
          }
          const newPos = peerPositions.get(n.id);
          if (newPos) {
            return { ...n, position: newPos };
          }
          return n;
        }) as AppNode[],
      };
    });
    // When expanding, reflow children back to their canonical column positions
    if (isExpanding) {
      get().reflowParentChildren(id);
    }
  },

  snapChildrenToColumns: (parentId, draggedNodeId, draggedY) => {
    set((s) => {
      const newNodes = [...s.nodes] as AppNode[];

      // Classify children into left (features) and right (components) columns
      const leftChildren: AppNode[] = [];
      const rightChildren: AppNode[] = [];
      for (const n of newNodes) {
        if (n.parentId !== parentId) continue;
        const d = n.data as Record<string, unknown>;
        const isFeatureCol = n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
        if (isFeatureCol) {
          leftChildren.push(n);
        } else if (n.type === 'subComponent' || (n.type === 'group' && !d.isFeature)) {
          rightChildren.push(n);
        }
      }

      // For the column containing the dragged node, sort by Y but use the
      // dragged node's new Y to determine its insertion position
      const sortColumn = (col: AppNode[]) => {
        col.sort((a, b) => {
          const ay = a.id === draggedNodeId ? draggedY : a.position.y;
          const by = b.id === draggedNodeId ? draggedY : b.position.y;
          return ay - by;
        });
        col.forEach((child, i) => {
          const idx = newNodes.findIndex((n) => n.id === child.id);
          if (idx >= 0) {
            const isLeft = leftChildren.includes(child);
            newNodes[idx] = {
              ...newNodes[idx],
              position: {
                x: isLeft ? CHILD_LEFT_X : CHILD_RIGHT_X,
                y: CONTAINER_HEADER_HEIGHT + i * CHILD_SLOT_HEIGHT,
              },
            };
          }
        });
      };

      sortColumn(leftChildren);
      sortColumn(rightChildren);

      // Resize parent
      const sz = computeHardwareSize(leftChildren.length, rightChildren.length);
      const pIdx = newNodes.findIndex((n) => n.id === parentId);
      if (pIdx >= 0) {
        const pData = newNodes[pIdx].data as Record<string, unknown>;
        const isCollapsed = !!pData.collapsed;
        if (!isCollapsed) {
          newNodes[pIdx] = {
            ...newNodes[pIdx],
            style: { ...newNodes[pIdx].style, width: sz.width, height: sz.height },
          };
        }
      }

      return { nodes: newNodes };
    });
  },

  reflowParentChildren: (parentId) => {
    set((s) => {
      const selectedId = s.selectedNodeId;
      const newNodes = [...s.nodes] as AppNode[];

      const children = newNodes.filter((n) => n.parentId === parentId);
      const leftChildren = children
        .filter((n) => {
          const d = n.data as Record<string, unknown>;
          return n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
        })
        .sort((a, b) => a.position.y - b.position.y);
      const rightChildren = children
        .filter((n) => {
          const d = n.data as Record<string, unknown>;
          return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
        })
        .sort((a, b) => a.position.y - b.position.y);

      const getSlotH = (node: AppNode) => getNodeSlotHeight(node, selectedId);

      // Reposition left column with variable heights
      let yOffset = CONTAINER_HEADER_HEIGHT;
      for (const child of leftChildren) {
        const idx = newNodes.findIndex((n) => n.id === child.id);
        if (idx >= 0) {
          newNodes[idx] = { ...newNodes[idx], position: { x: CHILD_LEFT_X, y: yOffset } };
          yOffset += getSlotH(newNodes[idx]);
        }
      }
      const leftTotal = yOffset - CONTAINER_HEADER_HEIGHT;

      // Reposition right column with variable heights
      yOffset = CONTAINER_HEADER_HEIGHT;
      for (const child of rightChildren) {
        const idx = newNodes.findIndex((n) => n.id === child.id);
        if (idx >= 0) {
          newNodes[idx] = { ...newNodes[idx], position: { x: CHILD_RIGHT_X, y: yOffset } };
          yOffset += getSlotH(newNodes[idx]);
        }
      }
      const rightTotal = yOffset - CONTAINER_HEADER_HEIGHT;

      // Resize parent to fit the taller column
      const pIdx = newNodes.findIndex((n) => n.id === parentId);
      if (pIdx >= 0) {
        const pData = newNodes[pIdx].data as Record<string, unknown>;
        if (!pData.collapsed) {
          const newHeight = CONTAINER_HEADER_HEIGHT + Math.max(leftTotal, rightTotal, 0) + CONTAINER_PADDING_BOTTOM;
          newNodes[pIdx] = {
            ...newNodes[pIdx],
            style: { ...newNodes[pIdx].style, height: Math.max(newHeight, 160) },
          };
        }
      }

      return { nodes: newNodes };
    });
  },

  addCustomGroupNode: (label, color, position, parentId) => {
    const id = nextNodeId();
    const pos = position || { x: Math.random() * 500 + 100, y: Math.random() * 300 + 100 };
    const { width, height } = computeHardwareSize(0, 0);
    const node: Node = {
      id,
      type: 'customGroup',
      position: pos,
      parentId: parentId ?? undefined,
      style: { width, height },
      data: {
        label,
        color,
        collapsed: false,
        hasErrors: false,
        validationStatus: 'valid',
      },
    };
    set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
    return id;
  },

  reparentNode: (nodeId, newParentId, absolutePos) => {
    get().pushHistory();
    const currentState = get();
    const node = currentState.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const oldParentId = node.parentId ?? null;
    if (oldParentId === newParentId) return;

    const oldParentNode = oldParentId ? currentState.nodes.find((n) => n.id === oldParentId) || null : null;
    const newParentNode = newParentId ? currentState.nodes.find((n) => n.id === newParentId) || null : null;

    // Compute new position
    let newX = absolutePos ? absolutePos.x : node.position.x;
    let newY = absolutePos ? absolutePos.y : node.position.y;

    if (newParentNode) {
      // Snap to grid: determine column and row based on node type
      const nodeData = node.data as Record<string, unknown>;
      const isFeatureColumn = node.type === 'feature' || (node.type === 'group' && !!nodeData.isFeature);
      const existingSiblings = currentState.nodes.filter((n) => {
        if (n.parentId !== newParentId || n.id === nodeId) return false;
        const d = n.data as Record<string, unknown>;
        if (isFeatureColumn) {
          return n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
        }
        return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
      });
      const slotIdx = existingSiblings.length;
      newX = isFeatureColumn ? CHILD_LEFT_X : CHILD_RIGHT_X;
      newY = CONTAINER_HEADER_HEIGHT + slotIdx * CHILD_SLOT_HEIGHT;
    } else if (absolutePos) {
      newX = absolutePos.x;
      newY = absolutePos.y;
    }

    // Gather config info before state update
    const nodeData = node.data as Record<string, unknown>;
    const sectionHeader = nodeData.sectionHeader as string | undefined;
    const sectionLineNumber = nodeData.sectionLineNumber as number | undefined;

    const resolveConfigFile = (parentNode: AppNode | null, fallbackConfigFile?: string) => (
      parentNode
        ? ((parentNode.data as Record<string, unknown>).configFile as string | undefined)
        : fallbackConfigFile
    );

    const resolveMcuName = (parentNode: AppNode | null, configFile?: string) => {
      if (parentNode) {
        return ((parentNode.data as Record<string, unknown>).mcuName as string) || '';
      }
      if (!configFile) return '';
      const ownerNode = currentState.nodes.find(
        (candidate) => candidate.type === 'hardware' && ((candidate.data as Record<string, unknown>).configFile as string | undefined) === configFile,
      );
      return ownerNode ? (((ownerNode.data as Record<string, unknown>).mcuName as string) || '') : '';
    };

    // Resolve old config file: from old parent, or from node's own configFile (standalone case)
    const oldConfigFile = resolveConfigFile(oldParentNode, nodeData.configFile as string | undefined);

    // Orphaned child nodes stay in their existing config file; only reparenting to
    // another major component should move sections between files.
    const newConfigFile = newParentNode
      ? resolveConfigFile(newParentNode)
      : oldConfigFile;

    // Determine MCU context change for pin prefix updates
    const oldMcuName = resolveMcuName(oldParentNode, oldConfigFile);
    const newMcuName = newParentNode
      ? resolveMcuName(newParentNode, newConfigFile)
      : oldMcuName;
    const movedAcrossFiles = !!oldConfigFile && !!newConfigFile && oldConfigFile !== newConfigFile;

    // Collect all section headers to move (single node or group with children)
    const sectionRefs: SectionRef[] = [];
    if (node.type === 'group' && Array.isArray(nodeData.children)) {
      for (const child of nodeData.children as Array<{ sectionHeader: string; sectionLineNumber?: number }>) {
        if (child.sectionHeader) sectionRefs.push({ sectionHeader: child.sectionHeader, sectionLineNumber: child.sectionLineNumber });
      }
    } else if (sectionHeader) {
      sectionRefs.push({ sectionHeader, sectionLineNumber });
    }

    set((s) => {
      const updatedNode: AppNode = {
        ...node,
        position: { x: newX, y: newY },
        parentId: newParentId ?? undefined,
      } as AppNode;

      const newNodes = s.nodes.map((n) => (n.id === nodeId ? updatedNode : n)) as AppNode[];

      // Helper to reposition children in their two-column grid
      const repositionChildren = (parentId: string) => {
        const children = newNodes.filter((n) => n.parentId === parentId);
        const leftChildren = children.filter((n) => {
          const d = n.data as Record<string, unknown>;
          return n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
        });
        const rightChildren = children.filter((n) => {
          const d = n.data as Record<string, unknown>;
          return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
        });
        leftChildren.forEach((child, i) => {
          const idx = newNodes.findIndex((n) => n.id === child.id);
          if (idx >= 0) newNodes[idx] = { ...newNodes[idx], position: { x: CHILD_LEFT_X, y: CONTAINER_HEADER_HEIGHT + i * CHILD_SLOT_HEIGHT } };
        });
        rightChildren.forEach((child, i) => {
          const idx = newNodes.findIndex((n) => n.id === child.id);
          if (idx >= 0) newNodes[idx] = { ...newNodes[idx], position: { x: CHILD_RIGHT_X, y: CONTAINER_HEADER_HEIGHT + i * CHILD_SLOT_HEIGHT } };
        });
        // Resize parent
        const sz = computeHardwareSize(leftChildren.length, rightChildren.length);
        const pIdx = newNodes.findIndex((n) => n.id === parentId);
        if (pIdx >= 0) {
          const pData = newNodes[pIdx].data as Record<string, unknown>;
          const isCollapsed = !!pData.collapsed;
          newNodes[pIdx] = { ...newNodes[pIdx], style: { ...newNodes[pIdx].style, width: isCollapsed ? COLLAPSED_WIDTH : sz.width, height: isCollapsed ? COLLAPSED_HEIGHT : sz.height } };
        }
      };

      if (oldParentId) repositionChildren(oldParentId);
      if (newParentId) repositionChildren(newParentId);

      // Update data to reflect new parent + configFile
      const movedIdx = newNodes.findIndex((n) => n.id === nodeId);
      if (movedIdx >= 0) {
        const movedData = { ...newNodes[movedIdx].data } as Record<string, unknown>;
        if ('parentHardwareId' in movedData) {
          movedData.parentHardwareId = newParentId;
        }
        if (newNodes[movedIdx].type === 'feature') {
          movedData.parentId = newParentId;
        }
        // Update configFile on the node
        if (newConfigFile) {
          movedData.configFile = newConfigFile;
        }
        if (movedAcrossFiles && 'sectionLineNumber' in movedData) {
          movedData.sectionLineNumber = 0;
        }
        if (Array.isArray(movedData.children)) {
          movedData.children = movedData.children.map((child) => ({
            ...child,
            ...(newConfigFile ? { configFile: newConfigFile } : {}),
            ...(movedAcrossFiles ? { sectionLineNumber: 0 } : {}),
          }));
        }
        newNodes[movedIdx] = { ...newNodes[movedIdx], data: movedData } as AppNode;
      }

      return { nodes: sortNodesParentsFirst(newNodes) };
    });

    // Move sections between config files and update pin prefixes
    if (sectionRefs.length > 0 && oldConfigFile && newConfigFile && oldConfigFile !== newConfigFile) {
      const configState = useConfigStore.getState();
      const schemas = configState.schemas;

      // Ensure target config file exists
      if (!configState.configFiles[newConfigFile]) {
        configState.updateConfigFile(newConfigFile, {
          filename: newConfigFile,
          sections: [],
          includes: [],
          header_comments: [],
        });
      }

      // Move each section
      for (const ref of sectionRefs) {
        const section = configState.getSection(oldConfigFile, ref.sectionHeader, ref.sectionLineNumber);
        if (section) {
          // Update pin prefixes if MCU context changed
          let updatedSection = section;
          if (oldMcuName !== newMcuName) {
            updatedSection = updateSectionPins(section, oldMcuName, newMcuName, schemas);
          }
          const movedSection = cloneSnapshot(updatedSection);
          movedSection.line_number = 0;
          configState.addSection(newConfigFile, movedSection);
          configState.removeSection(oldConfigFile, ref.sectionHeader, ref.sectionLineNumber);
        }
      }

      // Clean up old config file if it's now empty and not a standard file
      const oldFile = useConfigStore.getState().configFiles[oldConfigFile];
      if (oldFile && oldFile.sections.length === 0 && oldConfigFile !== 'printer.cfg') {
        // Check no hardware nodes still reference this file
        const stillReferenced = get().nodes.some(
          (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === oldConfigFile,
        );
        if (!stillReferenced) {
          configState.removeConfigFile(oldConfigFile);
        }
      }
    } else if (sectionRefs.length > 0 && oldConfigFile && oldMcuName !== newMcuName) {
      // Same config file but MCU context changed — update pin prefixes in place
      const configState = useConfigStore.getState();
      const schemas = configState.schemas;
      for (const ref of sectionRefs) {
        const section = configState.getSection(oldConfigFile, ref.sectionHeader, ref.sectionLineNumber);
        if (section) {
          const updatedSection = updateSectionPins(section, oldMcuName, newMcuName, schemas);
          const cf = configState.configFiles[oldConfigFile];
          if (cf) {
            configState.updateConfigFile(oldConfigFile, {
              ...cf,
              sections: cf.sections.map((s) => matchesSectionRef(s, ref) ? updatedSection : s),
            });
          }
        }
      }
    }

    // Sync group children's params with updated config store data
    if (node.type === 'group' && Array.isArray(nodeData.children) && (oldMcuName !== newMcuName || movedAcrossFiles)) {
      const freshConfigs = useConfigStore.getState().configFiles;
      const targetFile = newConfigFile || oldConfigFile || '';
      const updatedChildren = (nodeData.children as Array<{ sectionHeader: string; sectionLineNumber?: number; configFile?: string; [key: string]: unknown }>).map((child) => {
        const childFile = targetFile || (child.configFile as string) || '';
        const cfData = freshConfigs[childFile];
        const childRef = {
          sectionHeader: child.sectionHeader,
          sectionLineNumber: movedAcrossFiles ? 0 : child.sectionLineNumber,
        };
        const matchedSection = cfData?.sections.find((s: { full_header: string; line_number: number }) => matchesSectionRef(s, childRef));
        return {
          ...child,
          configFile: newConfigFile || child.configFile,
          sectionLineNumber: movedAcrossFiles ? 0 : child.sectionLineNumber,
          params: matchedSection
            ? matchedSection.params.filter((p: { is_commented_out?: boolean }) => !p.is_commented_out)
            : child.params,
        };
      });
      get().updateNodeData(nodeId, { children: updatedChildren });
    }
  },

  addCommunicationEdge: (sourceId, targetId, commType, sourceHandle?, targetHandle?, isNotIncluded?) => {
    const id = nextEdgeId();
    const edge: Edge = {
      id,
      source: sourceId,
      target: targetId,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      type: 'communication',
      data: { commType, edgeType: 'communication', isNotIncluded: !!isNotIncluded },
    };
    set((s) => ({ edges: [...s.edges, edge as AppEdge] }));
    return id;
  },

  addConfigurationEdge: (sourceId, targetId, hwType, sourceHandle?, targetHandle?) => {
    const id = nextEdgeId();
    const color = getHardwareColor(hwType);
    const edge: Edge = {
      id,
      source: sourceId,
      target: targetId,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      type: 'configuration',
      data: { edgeType: 'configuration', sourceHardwareType: hwType, color },
    };
    set((s) => ({ edges: [...s.edges, edge as AppEdge] }));
    return id;
  },

  setNodes: (nodes) => set({ nodes: sortNodesParentsFirst(nodes) }),
  setEdges: (edges) => set({ edges }),
  clearGraph: () => set({ nodes: [], edges: [], selectedNodeId: null, dragHoverHardwareId: null }),

  syncGraphWithConfig: (filename) => {
    const configStore = useConfigStore.getState();
    const cf = configStore.configFiles[filename];
    if (!cf) return;

    const state = get();
    let updatedNodes = [...state.nodes] as AppNode[];
    let changed = false;

    // Build a set of all section headers in this config file
    const configSectionHeaders = new Set(cf.sections.map((s) => sectionIdentityForSection(s)));

    // Find all nodes that belong to this config file
    const fileNodes = updatedNodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      return d.configFile === filename && (n.type === 'subComponent' || n.type === 'feature');
    });
    const fileGroups = updatedNodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      return d.configFile === filename && n.type === 'group';
    });

    // Track which section headers have graph nodes
    const graphSectionHeaders = new Set<string>();
    for (const n of fileNodes) {
      const d = n.data as Record<string, unknown>;
      graphSectionHeaders.add(sectionIdentity(d.sectionHeader as string, d.sectionLineNumber as number | undefined));
    }
    for (const n of fileGroups) {
      const d = n.data as Record<string, unknown>;
      const children = d.children as Array<{ sectionHeader: string; sectionLineNumber?: number }> | undefined;
      if (children) {
        for (const c of children) {
          graphSectionHeaders.add(sectionIdentity(c.sectionHeader, c.sectionLineNumber));
        }
      }
    }

    // 1. Remove nodes for sections that no longer exist in config
    const removedIds = new Set<string>();
    for (const n of fileNodes) {
      const d = n.data as Record<string, unknown>;
      const sectionHeader = d.sectionHeader as string;
      const sectionLineNumber = d.sectionLineNumber as number | undefined;
      if (!configSectionHeaders.has(sectionIdentity(sectionHeader, sectionLineNumber))) {
        removedIds.add(n.id);
        changed = true;
      }
    }
    // Update groups: remove children whose sections no longer exist
    for (const n of fileGroups) {
      const d = n.data as Record<string, unknown>;
      const children = d.children as Array<{ sectionHeader: string; sectionLineNumber?: number; configFile?: string }> | undefined;
      if (children) {
        const filtered = children.filter((c) => {
          const childFile = c.configFile || filename;
          if (childFile !== filename) return true;
          return configSectionHeaders.has(sectionIdentity(c.sectionHeader, c.sectionLineNumber));
        });
        if (filtered.length !== children.length) {
          changed = true;
          if (filtered.length === 0) {
            removedIds.add(n.id);
          } else {
            updatedNodes = updatedNodes.map((un) =>
              un.id === n.id ? { ...un, data: { ...un.data, children: filtered } } as AppNode : un,
            );
          }
        }
      }
    }

    if (removedIds.size > 0) {
      updatedNodes = updatedNodes.filter((n) => !removedIds.has(n.id));
    }

    // 2. Update suppressed state: check if all non-comment params are commented out
    for (let i = 0; i < updatedNodes.length; i++) {
      const n = updatedNodes[i];
      const d = n.data as Record<string, unknown>;
      if (d.configFile !== filename) continue;

      if (n.type === 'subComponent' || n.type === 'feature') {
        const sectionHeader = d.sectionHeader as string;
        const section = cf.sections.find((s) => matchesSectionRef(s, { sectionHeader, sectionLineNumber: d.sectionLineNumber as number | undefined }));
        if (section) {
          const realParams = section.params.filter((p) => p.key !== '_comment_');
          const allCommented = realParams.length > 0 && realParams.every((p) => p.is_commented_out);
          const wasSuppressed = !!d.isSuppressed;
          if (allCommented !== wasSuppressed) {
            updatedNodes[i] = { ...n, data: { ...n.data, isSuppressed: allCommented } } as AppNode;
            changed = true;
          }
        }
      } else if (n.type === 'group') {
        const children = d.children as Array<{ sectionHeader: string; sectionLineNumber?: number; configFile?: string; isSuppressed?: boolean }> | undefined;
        if (children) {
          const updatedChildren = children.map((c) => {
            const childFile = c.configFile || filename;
            if (childFile !== filename) return c;
            const section = cf.sections.find((s) => matchesSectionRef(s, c));
            if (section) {
              const realParams = section.params.filter((p) => p.key !== '_comment_');
              const allCommented = realParams.length > 0 && realParams.every((p) => p.is_commented_out);
              if (allCommented !== !!c.isSuppressed) {
                changed = true;
                return { ...c, isSuppressed: allCommented };
              }
            }
            return c;
          });
          if (changed) {
            updatedNodes[i] = { ...n, data: { ...n.data, children: updatedChildren } } as AppNode;
          }
        }
      }
    }

    // 3. Add nodes for new sections that don't have graph nodes
    // Find the parent hardware node for this file
    let parentNode = updatedNodes.find(
      (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === filename,
    );
    // Fallback: match by basename in case the path format differs
    if (!parentNode) {
      const bn = filename.replace(/^.*[\\/]/, '');
      parentNode = updatedNodes.find(
        (n) => n.type === 'hardware' && ((n.data as Record<string, unknown>).configFile as string || '').replace(/^.*[\\/]/, '') === bn,
      );
    }
    const parentId = parentNode?.id;

    if (parentId) {
      // Rebuild set of current graph headers after removals
      const currentGraphHeaders = new Set<string>();
      for (const n of updatedNodes) {
        const nd = n.data as Record<string, unknown>;
        if (n.type === 'subComponent' || n.type === 'feature') {
          currentGraphHeaders.add(sectionIdentity(nd.sectionHeader as string, nd.sectionLineNumber as number | undefined));
        } else if (n.type === 'group') {
          const ch = nd.children as Array<{ sectionHeader: string; sectionLineNumber?: number }> | undefined;
          if (ch) for (const c of ch) currentGraphHeaders.add(sectionIdentity(c.sectionHeader, c.sectionLineNumber));
        }
      }

      const SUB_TYPES = new Set([
        'stepper_a', 'stepper_b', 'stepper_c', 'manual_stepper', 'extruder_stepper',
        'dual_carriage',
        'tmc2209', 'tmc2208', 'tmc2130', 'tmc2240', 'tmc5160', 'tmc2660',
        'heater_bed', 'heater_generic',
        'fan', 'heater_fan', 'controller_fan', 'temperature_fan', 'fan_generic',
        'temperature_sensor',
        'probe', 'bltouch', 'smart_effector', 'probe_eddy_current',
        'neopixel', 'dotstar', 'led', 'pca9533', 'pca9632',
        'display', 'servo', 'output_pin', 'gcode_button', 'pwm_tool',
        'filament_switch_sensor', 'filament_motion_sensor',
        'adxl345', 'lis2dw', 'lis3dh', 'bmi160', 'mpu9250', 'icm20948',
        'printer', 'mcu',
      ]);
      const FEAT_TYPES = new Set([
        'bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust',
        'bed_screws', 'bed_tilt', 'skew_correction', 'axis_twist_compensation',
        'safe_z_home', 'homing_override', 'endstop_phase',
        'input_shaper', 'resonance_tester',
        'virtual_sdcard', 'pause_resume', 'firmware_retraction', 'force_move',
        'idle_timeout', 'gcode_macro', 'delayed_gcode', 'gcode_arcs',
        'respond', 'exclude_object', 'save_variables', 'display_status',
      ]);

      for (const sec of cf.sections) {
        if (sec.section_type === 'include') continue;
        if (currentGraphHeaders.has(sectionIdentityForSection(sec))) continue;

        const isFeature = FEAT_TYPES.has(sec.section_type);
        const isSub = SUB_TYPES.has(sec.section_type) || isDynamicSubComponentType(sec.section_type);
        if (!isFeature && !isSub) continue;

        const label = sec.section_name
          ? `${sec.section_type}: ${sec.section_name}`
          : sec.section_type;

        const componentGroup = getComponentGroup(sec.section_type, isFeature);

        const suppressed = sec.params.filter((p) => p.key !== '_comment_').every((p) => p.is_commented_out) &&
          sec.params.filter((p) => p.key !== '_comment_').length > 0;

        const newNode: AppNode = {
          id: nextNodeId(),
          type: isFeature ? 'feature' : 'subComponent',
          position: { x: isFeature ? 12 : 208, y: 0 },
          parentId,
          zIndex: CHILD_NODE_Z_INDEX,
          data: {
            sectionType: sec.section_type,
            sectionHeader: sec.full_header,
            sectionLineNumber: sec.line_number,
            label,
            componentGroup,
            section: sec,
            configFile: filename,
            hasErrors: false,
            isSuppressed: suppressed,
            ...(isFeature
              ? { parentId }
              : { parentHardwareId: parentId }),
          },
        } as unknown as AppNode;

        updatedNodes.push(newNode);
        changed = true;
      }
    }

    if (changed) {
      set({ nodes: sortNodesParentsFirst(updatedNodes) });
      // Reflow parent's children to fix positions
      if (parentId) {
        // Expand the parent hardware node if it's collapsed so new children are visible
        const parentNow = get().nodes.find((n) => n.id === parentId);
        if (parentNow && (parentNow.data as Record<string, unknown>).collapsed) {
          get().toggleHardwareCollapse(parentId);
        }
        get().reflowParentChildren(parentId);
      }
    }

    // 4. Sync include directives → configuration edges
    // Find the hardware node for this config file. printer.cfg can host BOTH the
    // primary mainboard [mcu] and the SBC host_mcu — when multiple hardware
    // nodes share the file, the include edge must attach to the PRIMARY node
    // (isPrimary), not whichever node happens to appear first (graphBuilder
    // inserts the SBC first, which caused phantom edges to the SBC).
    const matchingHwNodes = get().nodes.filter((n) => {
      if (n.type !== 'hardware') return false;
      const nodeFile = (n.data as Record<string, unknown>).configFile as string || '';
      const nodeBasename = nodeFile.replace(/^.*[\\/]/, '');
      const filenameBasename = filename.replace(/^.*[\\/]/, '');
      return nodeFile === filename || nodeBasename === filenameBasename;
    });
    const thisHwNode = matchingHwNodes.find(
      (n) => Boolean((n.data as Record<string, unknown>).isPrimary),
    ) ?? matchingHwNodes[0];

    if (thisHwNode) {
      const includes = cf.includes || [];

      // Helper: is this edge a config edge connecting the same two hardware nodes
      // (either direction)? Mirrors onConnect's pair normalization — direction
      // never matters, the include always lives in the primary file.
      const isPairEdge = (e: AppEdge, aId: string, bId: string) =>
        (e.data as Record<string, unknown>)?.edgeType === 'configuration' &&
        ((e.source === aId && e.target === bId) || (e.source === bId && e.target === aId));

      // Remove configuration edges no longer backed by an include directive
      const existingIncomingEdges = get().edges.filter(
        (e) =>
          (e.data as Record<string, unknown>)?.edgeType === 'configuration' &&
          e.target === thisHwNode.id,
      );
      for (const edge of existingIncomingEdges) {
        const srcNode = get().nodes.find((n) => n.id === edge.source);
        if (!srcNode) continue;
        const srcFile = (srcNode.data as Record<string, unknown>).configFile as string || '';
        const srcBasename = srcFile.replace(/^.*[\\/]/, '');
        const stillIncluded = includes.some((inc) => {
          const incBasename = inc.replace(/^.*[\\/]/, '');
          return incBasename === srcBasename || inc === srcFile;
        });
        if (!stillIncluded) {
          set((s) => ({ edges: s.edges.filter((e2) => e2.id !== edge.id) }));
        }
      }

      // Add configuration edges for newly-added include directives.
      // The include belongs to THIS hardware node's file, but the edge that
      // represents it must connect the two hardware nodes of the involved
      // files — resolved by filename, never by assuming thisHwNode is the
      // primary. When the include lives in printer.cfg (owned by the SBC
      // node), the edge must still land on the PRIMARY node so a redraw
      // doesn't spawn a duplicate phantom edge to the SBC.
      for (const inc of includes) {
        const incBasename = inc.replace(/^.*[\\/]/, '');
        const includedHwNode = get().nodes.find((n) => {
          if (n.type !== 'hardware') return false;
          const nodeFile = (n.data as Record<string, unknown>).configFile as string || '';
          const nodeBasename = nodeFile.replace(/^.*[\\/]/, '');
          return nodeBasename === incBasename || nodeFile === inc;
        });
        if (!includedHwNode || includedHwNode.id === thisHwNode.id) continue;
        // Resolve the include target: the primary (printer.cfg) node if one of
        // the pair is primary, otherwise thisHwNode (the file declaring it).
        const includedData = includedHwNode.data as Record<string, unknown>;
        const thisData = thisHwNode.data as Record<string, unknown>;
        const includedFile = includedData.configFile as string || '';
        const thisFile = thisData.configFile as string || '';
        const includedIsPrimary = Boolean(includedData.isPrimary) || includedFile === 'printer.cfg';
        const thisIsPrimary = Boolean(thisData.isPrimary) || thisFile === 'printer.cfg';
        const edgeSource = thisIsPrimary && !includedIsPrimary ? includedHwNode.id : thisHwNode.id;
        const edgeTarget = thisIsPrimary && !includedIsPrimary ? thisHwNode.id : includedHwNode.id;
        const edgeExists = get().edges.some((e) => isPairEdge(e, edgeSource, edgeTarget));
        if (!edgeExists) {
          const hwType = (includedHwNode.data as Record<string, unknown>).hardwareType as HardwareType;
          get().addConfigurationEdge(edgeSource, edgeTarget, hwType);
        }
      }

      // 5. Update isNotIncluded on all communication edges based on current graph state
      const sbcNode = get().nodes.find(
        (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).hardwareType === 'sbc',
      );
      const printerHwNode = get().nodes.find(
        (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === 'printer.cfg',
      );
      if (sbcNode) {
        const allCommEdges = get().edges.filter(
          (e) => (e.data as Record<string, unknown>)?.edgeType === 'communication',
        );
        for (const commEdge of allCommEdges) {
          const nonSbcId = commEdge.source === sbcNode.id ? commEdge.target : commEdge.source;
          const hwNode = get().nodes.find((n) => n.id === nonSbcId);
          if (!hwNode) continue;
          const hwConfigFile = (hwNode.data as Record<string, unknown>).configFile as string || '';
          let isNotIncluded = true;
          if (hwConfigFile === 'printer.cfg' || hwNode.id === sbcNode.id) {
            isNotIncluded = false;
          } else if (printerHwNode) {
            isNotIncluded = !get().edges.some(
              (e) =>
                (e.data as Record<string, unknown>)?.edgeType === 'configuration' &&
                e.source === hwNode.id &&
                e.target === printerHwNode.id,
            );
          }
          const prevData = commEdge.data as Record<string, unknown>;
          if (!!prevData.isNotIncluded !== isNotIncluded) {
            get().updateEdgeData(commEdge.id, { isNotIncluded });
          }
        }

        // Update commType for this file's communication edge if MCU params changed
        if ((thisHwNode.data as Record<string, unknown>).hardwareType !== 'sbc') {
          const commEdge = get().edges.find(
            (e) =>
              (e.data as Record<string, unknown>)?.edgeType === 'communication' &&
              ((e.source === sbcNode.id && e.target === thisHwNode.id) ||
                (e.source === thisHwNode.id && e.target === sbcNode.id)),
          );
          if (commEdge) {
            const newCommType = detectNodeCommType(thisHwNode.data as Record<string, unknown>);
            const prevCommType = (commEdge.data as Record<string, unknown>).commType as string;
            if (prevCommType !== newCommType) {
              get().updateEdgeData(commEdge.id, { commType: newCommType });
            }
          }
        }
      }
    }
  },

  autoArrange: () => {
    get().pushHistory();
    set((s) => {
      const newNodes = [...s.nodes] as AppNode[];
      const newEdges = [...s.edges];

      // Find all top-level hardware nodes
      const hwNodes = newNodes.filter((n) => n.type === 'hardware' && !n.parentId);
      if (hwNodes.length === 0) return { nodes: newNodes, edges: newEdges };

      // Identify the central node: SBC if present, otherwise primary MCU
      const sbcNodes = hwNodes.filter((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc');
      const nonSbcNodes = hwNodes.filter((n) => (n.data as Record<string, unknown>).hardwareType !== 'sbc');
      const primaryNode = hwNodes.find((n) => (n.data as Record<string, unknown>).isPrimary);

      // Central node is SBC, or primary MCU, or first node
      const centerNode = sbcNodes[0] || primaryNode || hwNodes[0];
      const satellites = hwNodes.filter((n) => n.id !== centerNode.id);

      // Get node dimensions helper
      const nodeW = (n: AppNode) => (n.style?.width as number) || COLLAPSED_WIDTH;
      const nodeH = (n: AppNode) => (n.style?.height as number) || COLLAPSED_HEIGHT;

      if (satellites.length === 0) {
        // Single node — just center it
        const idx = newNodes.findIndex((n) => n.id === centerNode.id);
        if (idx >= 0) {
          newNodes[idx] = { ...newNodes[idx], position: { x: 200, y: 200 } };
        }
        return { nodes: sortNodesParentsFirst(newNodes), edges: newEdges };
      }

      // Calculate radius based on the number and size of satellites
      const maxNodeDim = Math.max(...satellites.map((n) => Math.max(nodeW(n), nodeH(n))));
      const minRadius = maxNodeDim * 1.2 + Math.max(nodeW(centerNode), nodeH(centerNode)) / 2;
      // Ensure enough space between satellites along the arc
      const circumNeeded = satellites.length * (maxNodeDim + 60);
      const radiusFromCircum = circumNeeded / (2 * Math.PI);
      const radius = Math.max(minRadius, radiusFromCircum, 300);

      // Place center node
      const cx = snapToGrid(radius + maxNodeDim);
      const cy = snapToGrid(radius + maxNodeDim);
      const centerIdx = newNodes.findIndex((n) => n.id === centerNode.id);
      if (centerIdx >= 0) {
        newNodes[centerIdx] = {
          ...newNodes[centerIdx],
          position: { x: cx - nodeW(centerNode) / 2, y: cy - nodeH(centerNode) / 2 },
        };
      }

      // Distribute satellites radially — start from top (-π/2) going clockwise
      const startAngle = -Math.PI / 2;
      const angleStep = (2 * Math.PI) / satellites.length;

      for (let i = 0; i < satellites.length; i++) {
        const sat = satellites[i];
        const angle = startAngle + i * angleStep;
        const cos = normalizeAxisComponent(Math.cos(angle));
        const sin = normalizeAxisComponent(Math.sin(angle));
        const sx = cx + radius * cos - nodeW(sat) / 2;
        const sy = cy + radius * sin - nodeH(sat) / 2;

        const idx = newNodes.findIndex((n) => n.id === sat.id);
        if (idx >= 0) {
          newNodes[idx] = { ...newNodes[idx], position: { x: sx, y: sy } };
        }
      }

      // Assign handles on edges based on relative positions of connected nodes
      const nodeById = new Map(newNodes.map((n) => [n.id, n]));

      const pickHandles = (srcNode: AppNode, tgtNode: AppNode) => {
        const srcCx = srcNode.position.x + nodeW(srcNode) / 2;
        const srcCy = srcNode.position.y + nodeH(srcNode) / 2;
        const tgtCx = tgtNode.position.x + nodeW(tgtNode) / 2;
        const tgtCy = tgtNode.position.y + nodeH(tgtNode) / 2;
        const dx = tgtCx - srcCx;
        const dy = tgtCy - srcCy;

        let srcHandle: string;
        let tgtHandle: string;

        if (Math.abs(dx) > Math.abs(dy)) {
          // Predominantly horizontal
          if (dx > 0) {
            srcHandle = 'right';
            tgtHandle = 'left';
          } else {
            srcHandle = 'left';
            tgtHandle = 'right';
          }
        } else {
          // Predominantly vertical
          if (dy > 0) {
            srcHandle = 'bottom';
            tgtHandle = 'top';
          } else {
            srcHandle = 'top';
            tgtHandle = 'bottom';
          }
        }
        return { srcHandle, tgtHandle };
      };

      for (let i = 0; i < newEdges.length; i++) {
        const edge = newEdges[i];
        const srcNode = nodeById.get(edge.source);
        const tgtNode = nodeById.get(edge.target);
        if (!srcNode || !tgtNode) continue;
        // Only update handles for hardware-to-hardware edges
        if (srcNode.type !== 'hardware' || tgtNode.type !== 'hardware') continue;

        const { srcHandle, tgtHandle } = pickHandles(srcNode, tgtNode);
        newEdges[i] = { ...edge, sourceHandle: srcHandle, targetHandle: tgtHandle };
      }

      return { nodes: sortNodesParentsFirst(newNodes), edges: newEdges };
    });
    // Increment to signal that a fitView should be triggered
    set((s) => ({ fitViewTrigger: s.fitViewTrigger + 1 }));
  },

  canUndo: false,
  canRedo: false,

  pushHistory: () => {
    const { nodes, edges } = get();
    const { configFiles, activeFile } = useConfigStore.getState();
    undoStack.push({
      nodes: cloneSnapshot(nodes),
      edges: cloneSnapshot(edges),
      configFiles: cloneSnapshot(configFiles),
      activeFile,
    });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    set({ canUndo: true, canRedo: false });
  },

  undo: () => {
    if (undoStack.length === 0) return;
    const { nodes, edges } = get();
    const configState = useConfigStore.getState();
    redoStack.push({
      nodes: cloneSnapshot(nodes),
      edges: cloneSnapshot(edges),
      configFiles: cloneSnapshot(configState.configFiles),
      activeFile: configState.activeFile,
    });
    const prev = undoStack.pop()!;
    useConfigStore.setState((state) => ({
      ...state,
      configFiles: cloneSnapshot(prev.configFiles),
      activeFile: prev.activeFile,
      validation: {},
      isDirty: true,
    }));
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      dragHoverHardwareId: null,
      canUndo: undoStack.length > 0,
      canRedo: true,
    });
    revalidateConfigFiles(prev.configFiles);
  },

  redo: () => {
    if (redoStack.length === 0) return;
    const { nodes, edges } = get();
    const configState = useConfigStore.getState();
    undoStack.push({
      nodes: cloneSnapshot(nodes),
      edges: cloneSnapshot(edges),
      configFiles: cloneSnapshot(configState.configFiles),
      activeFile: configState.activeFile,
    });
    const next = redoStack.pop()!;
    useConfigStore.setState((state) => ({
      ...state,
      configFiles: cloneSnapshot(next.configFiles),
      activeFile: next.activeFile,
      validation: {},
      isDirty: true,
    }));
    set({
      nodes: next.nodes,
      edges: next.edges,
      dragHoverHardwareId: null,
      canUndo: true,
      canRedo: redoStack.length > 0,
    });
    revalidateConfigFiles(next.configFiles);
  },
}));
