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

// ── Container layout constants ────────────────────────────────
/** Total width of a hardware container node */
const CONTAINER_WIDTH = 600;
/** Height reserved for the hardware node header/info area */
const CONTAINER_HEADER_HEIGHT = 130;
/** Vertical slot size per child node (collapsed) */
const CHILD_SLOT_HEIGHT = 130;
/** Padding below last child row */
const CONTAINER_PADDING_BOTTOM = 20;
/** X position (relative to parent) for left-column children (features) */
const CHILD_LEFT_X = 12;
/** X position (relative to parent) for right-column children (sub-components) */
const CHILD_RIGHT_X = 312;
/** Height of a hardware node when collapsed (just the header) */
const COLLAPSED_HEIGHT = 72;

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

  addSubComponentNode: (
    parentId: string,
    sectionType: string,
    label: string,
    sectionHeader: string,
  ) => string;

  addFeatureNode: (
    parentId: string,
    sectionType: string,
    label: string,
    sectionHeader: string,
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
    }>,
    isFeature: boolean,
  ) => string;

  addCommunicationEdge: (sourceId: string, targetId: string, commType: CommunicationType) => string;
  addConfigurationEdge: (sourceId: string, targetId: string, hwType: HardwareType) => string;

  /* Bulk */
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: AppEdge[]) => void;
  clearGraph: () => void;

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
        // Communication edge (USB/CAN/UART) between SBC and hardware
        const newEdge: AppEdge = {
          id,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          data: { edgeType: 'communication', commType: 'usb' as CommunicationType },
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

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  addEdge: (edge) => set((s) => ({ edges: [...s.edges, edge] })),
  removeEdge: (id) => set((s) => ({ edges: s.edges.filter((e) => e.id !== id) })),
  setSelectedEdge: (id) => set({ selectedEdgeId: id }),

  updateEdgeData: (id, data) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, data: { ...e.data, ...data } } : e,
      ) as AppEdge[],
    })),

  addHardwareNode: (hwType, label, configFile, position) => {
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
        sections: [],
        hasErrors: false,
      },
    };
    set((s) => ({ nodes: [...s.nodes, node as AppNode] }));
    return id;
  },

  addSubComponentNode: (parentId, sectionType, label, sectionHeader) => {
    const id = nextNodeId();

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

  addFeatureNode: (parentId, sectionType, label, sectionHeader) => {
    const id = nextNodeId();

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

  addGroupNode: (parentId, componentGroup, label, children, isFeature) => {
    const id = nextNodeId();

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
    set((s) => {
      const hwNode = s.nodes.find((n) => n.id === id);
      if (!hwNode) return s;
      const currentData = hwNode.data as Record<string, unknown>;
      const isCollapsed = !(currentData.collapsed as boolean);

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

      return {
        nodes: s.nodes.map((n) => {
          if (n.id === id) {
            return {
              ...n,
              data: { ...n.data, collapsed: isCollapsed },
              style: {
                ...n.style,
                width: expandedSize.width,
                height: isCollapsed ? COLLAPSED_HEIGHT : expandedSize.height,
              },
            };
          }
          if (n.parentId === id) {
            return { ...n, hidden: isCollapsed };
          }
          return n;
        }) as AppNode[],
      };
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
    const oldConfigFile = oldParentNode
      ? ((oldParentNode.data as Record<string, unknown>).configFile as string | undefined)
      : undefined;
    const newConfigFile = newParentNode
      ? ((newParentNode.data as Record<string, unknown>).configFile as string | undefined)
      : sectionHeader
      ? `${sectionHeader.split(' ')[0]}.cfg`
      : undefined;

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
          newNodes[pIdx] = { ...newNodes[pIdx], style: { ...newNodes[pIdx].style, ...sz, height: isCollapsed ? COLLAPSED_HEIGHT : sz.height } };
        }
      };

      if (oldParentId) repositionChildren(oldParentId);
      if (newParentId) repositionChildren(newParentId);

      // Update data to reflect new parent
      const movedIdx = newNodes.findIndex((n) => n.id === nodeId);
      if (movedIdx >= 0) {
        const movedData = { ...newNodes[movedIdx].data } as Record<string, unknown>;
        if ('parentHardwareId' in movedData) {
          movedData.parentHardwareId = newParentId ?? '';
        }
        if (newNodes[movedIdx].type === 'feature') {
          movedData.parentId = newParentId ?? '';
        }
        newNodes[movedIdx] = { ...newNodes[movedIdx], data: movedData } as AppNode;
      }

      return { nodes: sortNodesParentsFirst(newNodes) };
    });

    // Move section between config files
    if (sectionHeader && oldConfigFile && newConfigFile && oldConfigFile !== newConfigFile) {
      const configState = useConfigStore.getState();
      const section = configState.getSection(oldConfigFile, sectionHeader);
      if (section) {
        if (!configState.configFiles[newConfigFile]) {
          configState.setConfigFile(newConfigFile, {
            filename: newConfigFile,
            sections: [],
            includes: [],
            header_comments: [],
          });
        }
        configState.addSection(newConfigFile, section);
        configState.removeSection(oldConfigFile, sectionHeader);
      }
    }
  },

  addCommunicationEdge: (sourceId, targetId, commType) => {
    const id = nextEdgeId();
    const edge: Edge = {
      id,
      source: sourceId,
      target: targetId,
      type: 'communication',
      data: { commType, edgeType: 'communication' },
    };
    set((s) => ({ edges: [...s.edges, edge as AppEdge] }));
    return id;
  },

  addConfigurationEdge: (sourceId, targetId, hwType) => {
    const id = nextEdgeId();
    const edge: Edge = {
      id,
      source: sourceId,
      target: targetId,
      type: 'configuration',
      data: { edgeType: 'configuration', sourceHardwareType: hwType },
    };
    set((s) => ({ edges: [...s.edges, edge as AppEdge] }));
    return id;
  },

  setNodes: (nodes) => set({ nodes: sortNodesParentsFirst(nodes) }),
  setEdges: (edges) => set({ edges }),
  clearGraph: () => set({ nodes: [], edges: [], selectedNodeId: null }),

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
