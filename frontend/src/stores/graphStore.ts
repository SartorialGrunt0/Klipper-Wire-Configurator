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
import type { AppNode, AppEdge } from '../types/graph';
import type { HardwareType, CommunicationType } from '../types/config';
import { useConfigStore } from './configStore';
import { updateSectionPins } from '../utils/pinUtils';

// Map section types to component groups for coloring
const COMPONENT_GROUP_MAP: Record<string, string> = {
  stepper_x: 'stepper', stepper_y: 'stepper', stepper_z: 'stepper',
  stepper_z1: 'stepper', stepper_z2: 'stepper', stepper_z3: 'stepper',
  stepper_a: 'stepper', stepper_b: 'stepper', stepper_c: 'stepper',
  manual_stepper: 'stepper', extruder_stepper: 'stepper', dual_carriage: 'stepper',
  tmc2209: 'stepper_driver', tmc2208: 'stepper_driver', tmc2130: 'stepper_driver',
  tmc2240: 'stepper_driver', tmc5160: 'stepper_driver', tmc2660: 'stepper_driver',
  extruder: 'extruder', extruder1: 'extruder', extruder2: 'extruder',
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

// Hardware type → color mapping (shared with edge coloring)
const HW_COLORS: Record<string, string> = {
  sbc: '#22c55e',
  mainboard: '#38bdf8',
  toolhead: '#f472b6',
  expander: '#a78bfa',
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

interface GraphState {
  nodes: AppNode[];
  edges: AppEdge[];
  selectedNodeId: string | null;

  /* React Flow callbacks */
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  /* Node operations */
  addNode: (node: AppNode) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  updateNodeData: (id: string, data: Partial<AppNode['data']>) => void;
  setSelectedNode: (id: string | null) => void;

  /* Edge operations */
  addEdge: (edge: AppEdge) => void;
  removeEdge: (id: string) => void;
  updateEdgeData: (id: string, data: Partial<AppEdge['data']>) => void;
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
  ) => string;

  addFeatureNode: (
    parentId: string,
    sectionType: string,
    label: string,
    sectionHeader: string,
    configFile?: string,
  ) => string;

  addGroupNode: (
    parentId: string,
    componentGroup: string,
    label: string,
    children: Array<{
      sectionType: string;
      label: string;
      sectionHeader: string;
      isFeature: boolean;
      params: Array<{ key: string; value: string }>;
      configFile?: string;
    }>,
    isFeature: boolean,
    configFile?: string,
  ) => string;

  addCommunicationEdge: (sourceId: string, targetId: string, commType: CommunicationType, sourceHandle?: string, targetHandle?: string, isNotIncluded?: boolean) => string;
  addConfigurationEdge: (sourceId: string, targetId: string, hwType: HardwareType, sourceHandle?: string, targetHandle?: string) => string;

  /* Bulk */
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: AppEdge[]) => void;
  clearGraph: () => void;

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

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  fitViewTrigger: 0,

  onNodesChange: (changes) =>
    set((s) => ({
      nodes: sortNodesParentsFirst(applyNodeChanges(changes, s.nodes) as AppNode[]),
    })),

  onEdgesChange: (changes) => {
    // Clean up includes for removed configuration edges between hardware nodes
    const removes = changes.filter((c) => c.type === 'remove');
    if (removes.length > 0) {
      const { nodes, edges } = get();
      removes.forEach((c) => {
        const edge = edges.find((e) => e.id === (c as { id: string }).id);
        if (!edge || (edge.data as Record<string, unknown>)?.edgeType !== 'configuration') return;
        const srcNode = nodes.find((n) => n.id === edge.source);
        const tgtNode = nodes.find((n) => n.id === edge.target);
        if (srcNode?.type !== 'hardware' || tgtNode?.type !== 'hardware') return;
        const srcFile = (srcNode.data as Record<string, unknown>).configFile as string;
        const tgtFile = (tgtNode.data as Record<string, unknown>).configFile as string;
        useConfigStore.getState().removeInclude(tgtFile, srcFile);
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
        const color = getHardwareColor(srcHwType);
        const newEdge: AppEdge = {
          id,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          data: { edgeType: 'configuration', sourceHardwareType: srcHwType as HardwareType, color },
          type: 'configuration',
        };
        set((s) => ({
          edges: [...s.edges.filter((e) => !existing.some((ex) => ex.id === e.id)), newEdge],
        }));
        // Remove old includes for these files (from old connection)
        existing.forEach((ex) => {
          const exSrc = nodes.find((n) => n.id === ex.source);
          const exTgt = nodes.find((n) => n.id === ex.target);
          if (exSrc && exTgt) {
            const exSrcFile = (exSrc.data as Record<string, unknown>).configFile as string;
            const exTgtFile = (exTgt.data as Record<string, unknown>).configFile as string;
            useConfigStore.getState().removeInclude(exTgtFile, exSrcFile);
            useConfigStore.getState().removeInclude(exSrcFile, exTgtFile);
          }
        });
        // Target includes source
        useConfigStore.getState().addInclude(tgtConfigFile, srcConfigFile);
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
    set((s) => {
      // Collect the node and all its children (parentId-based)
      const childIds = new Set(s.nodes.filter((n) => n.parentId === id).map((n) => n.id));
      const removedIds = new Set([id, ...childIds]);
      return {
        nodes: s.nodes.filter((n) => !removedIds.has(n.id)),
        edges: s.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target)),
      };
    });
  },

  duplicateNode: (id) => {
    get().pushHistory();
    const state = get();
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    const newId = nextNodeId();
    const clone: AppNode = {
      ...node,
      id: newId,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      data: { ...node.data },
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
    // Reflow the parent of the old selection
    if (prevId && prevId !== id) {
      const prevNode = get().nodes.find((n) => n.id === prevId);
      if (prevNode?.parentId) get().reflowParentChildren(prevNode.parentId);
    }
    // Reflow the parent of the new selection
    if (id) {
      const newNode = get().nodes.find((n) => n.id === id);
      if (newNode?.parentId) get().reflowParentChildren(newNode.parentId);
    }
  },

  addEdge: (edge) => set((s) => ({ edges: [...s.edges, edge] })),
  removeEdge: (id) => set((s) => ({ edges: s.edges.filter((e) => e.id !== id) })),
  setSelectedEdge: (id) => set({ selectedEdgeId: id }),

  updateEdgeData: (id, data) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, data: { ...e.data, ...data } } : e,
      ) as AppEdge[],
    })),

  addHardwareNode: (hwType, label, configFile, position, mcuName) => {
    const id = nextNodeId();
    const pos = position || { x: Math.random() * 600, y: Math.random() * 400 };
    const { width, height } = computeHardwareSize(0, 0);
    const node: Node = {
      id,
      type: 'hardware',
      position: pos,
      style: { width, height },
      data: {
        label,
        hardwareType: hwType,
        configFile,
        mcuName: mcuName ?? '',
        sections: [],
        hasErrors: false,
      },
    };
    set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
    return id;
  },

  addSubComponentNode: (parentId, sectionType, label, sectionHeader, configFile) => {
    const id = nextNodeId();

    // Resolve config file from parent hardware node if not provided
    const resolvedFile = configFile || (() => {
      const parent = get().nodes.find((n) => n.id === parentId);
      return (parent?.data as Record<string, unknown>)?.configFile as string || '';
    })();

    // Count current right-side children (sub-components + non-feature groups)
    const rightChildren = get().nodes.filter((n) => {
      if (n.parentId !== parentId) return false;
      const d = n.data as Record<string, unknown>;
      return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
    });
    const rightIdx = rightChildren.length;

    // Position is relative to the parent hardware node
    const pos = { x: CHILD_RIGHT_X, y: CONTAINER_HEADER_HEIGHT + rightIdx * CHILD_SLOT_HEIGHT };

    // Determine component group from section type
    const componentGroup = COMPONENT_GROUP_MAP[sectionType] || 'other';

    const node: Node = {
      id,
      type: 'subComponent',
      position: pos,
      parentId,
      data: {
        label,
        sectionType,
        sectionHeader,
        componentGroup,
        section: { section_type: sectionType, section_name: '', full_header: sectionHeader, line_number: 0, params: [], header_comments: [] },
        parentHardwareId: parentId,
        configFile: resolvedFile,
        hasErrors: false,
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

  addFeatureNode: (parentId, sectionType, label, sectionHeader, configFile) => {
    const id = nextNodeId();

    // Resolve config file from parent hardware node if not provided
    const resolvedFile = configFile || (() => {
      const parent = get().nodes.find((n) => n.id === parentId);
      return (parent?.data as Record<string, unknown>)?.configFile as string || '';
    })();

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
      data: {
        label,
        sectionType,
        sectionHeader,
        section: { section_type: sectionType, section_name: '', full_header: sectionHeader, line_number: 0, params: [], header_comments: [] },
        parentId,
        configFile: resolvedFile,
        hasErrors: false,
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
      data: {
        label,
        componentGroup,
        isFeature,
        children,
        parentHardwareId: parentId,
        configFile: resolvedFile,
        hasErrors: false,
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

    const oldParentNode = oldParentId ? currentState.nodes.find((n) => n.id === oldParentId) : null;
    const newParentNode = newParentId ? currentState.nodes.find((n) => n.id === newParentId) : null;

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

    // Resolve old config file: from old parent, or from node's own configFile (standalone case)
    const oldConfigFile = oldParentNode
      ? ((oldParentNode.data as Record<string, unknown>).configFile as string | undefined)
      : (nodeData.configFile as string | undefined);

    // Resolve new config file: from new parent, or generate standalone file from section header
    const newConfigFile = newParentNode
      ? ((newParentNode.data as Record<string, unknown>).configFile as string | undefined)
      : sectionHeader
      ? `${sectionHeader.replace(/\s+/g, '_')}.cfg`
      : undefined;

    // Determine MCU context change for pin prefix updates
    const oldMcuName = oldParentNode
      ? ((oldParentNode.data as Record<string, unknown>).mcuName as string || '')
      : '';
    const newMcuName = newParentNode
      ? ((newParentNode.data as Record<string, unknown>).mcuName as string || '')
      : '';

    // Collect all section headers to move (single node or group with children)
    const sectionHeaders: string[] = [];
    if (node.type === 'group' && Array.isArray(nodeData.children)) {
      for (const child of nodeData.children as Array<{ sectionHeader: string }>) {
        if (child.sectionHeader) sectionHeaders.push(child.sectionHeader);
      }
    } else if (sectionHeader) {
      sectionHeaders.push(sectionHeader);
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
          movedData.parentHardwareId = newParentId ?? '';
        }
        if (newNodes[movedIdx].type === 'feature') {
          movedData.parentId = newParentId ?? '';
        }
        // Update configFile on the node
        if (newConfigFile) {
          movedData.configFile = newConfigFile;
        }
        newNodes[movedIdx] = { ...newNodes[movedIdx], data: movedData } as AppNode;
      }

      return { nodes: sortNodesParentsFirst(newNodes) };
    });

    // Move sections between config files and update pin prefixes
    if (sectionHeaders.length > 0 && oldConfigFile && newConfigFile && oldConfigFile !== newConfigFile) {
      const configState = useConfigStore.getState();
      const schemas = configState.schemas;

      // Ensure target config file exists
      if (!configState.configFiles[newConfigFile]) {
        configState.setConfigFile(newConfigFile, {
          filename: newConfigFile,
          sections: [],
          includes: [],
          header_comments: [],
        });
      }

      // Move each section
      for (const header of sectionHeaders) {
        const section = configState.getSection(oldConfigFile, header);
        if (section) {
          // Update pin prefixes if MCU context changed
          let updatedSection = section;
          if (oldMcuName !== newMcuName) {
            updatedSection = updateSectionPins(section, oldMcuName, newMcuName, schemas);
          }
          configState.addSection(newConfigFile, updatedSection);
          configState.removeSection(oldConfigFile, header);
        }
      }

      // Clean up old config file if it's now empty and not a standard file
      const oldFile = configState.configFiles[oldConfigFile];
      if (oldFile && oldFile.sections.length === 0 && oldConfigFile !== 'printer.cfg') {
        // Check no hardware nodes still reference this file
        const stillReferenced = get().nodes.some(
          (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === oldConfigFile,
        );
        if (!stillReferenced) {
          configState.removeConfigFile(oldConfigFile);
        }
      }
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
  clearGraph: () => set({ nodes: [], edges: [], selectedNodeId: null }),

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
      const cx = radius + maxNodeDim;
      const cy = radius + maxNodeDim;
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
        const sx = cx + radius * Math.cos(angle) - nodeW(sat) / 2;
        const sy = cy + radius * Math.sin(angle) - nodeH(sat) / 2;

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
            srcHandle = 'right-out';
            tgtHandle = 'left-in';
          } else {
            srcHandle = 'left-out';
            tgtHandle = 'right-in';
          }
        } else {
          // Predominantly vertical
          if (dy > 0) {
            srcHandle = 'bottom-out';
            tgtHandle = 'top-in';
          } else {
            srcHandle = 'top-out';
            tgtHandle = 'bottom-in';
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
    undoStack.push({ nodes: [...nodes], edges: [...edges] });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    set({ canUndo: true, canRedo: false });
  },

  undo: () => {
    if (undoStack.length === 0) return;
    const { nodes, edges } = get();
    redoStack.push({ nodes: [...nodes], edges: [...edges] });
    const prev = undoStack.pop()!;
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      canUndo: undoStack.length > 0,
      canRedo: true,
    });
  },

  redo: () => {
    if (redoStack.length === 0) return;
    const { nodes, edges } = get();
    undoStack.push({ nodes: [...nodes], edges: [...edges] });
    const next = redoStack.pop()!;
    set({
      nodes: next.nodes,
      edges: next.edges,
      canUndo: true,
      canRedo: redoStack.length > 0,
    });
  },
}));
