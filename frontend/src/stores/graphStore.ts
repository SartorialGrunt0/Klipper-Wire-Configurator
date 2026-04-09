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
}

let nodeIdCounter = 0;
let edgeIdCounter = 0;

function nextNodeId(): string {
  return `node_${++nodeIdCounter}`;
}
function nextEdgeId(): string {
  return `edge_${++edgeIdCounter}`;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,

  onNodesChange: (changes) =>
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as AppNode[],
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
    const { nodes, edges } = get();
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const srcType = sourceNode.type;
    const tgtType = targetNode.type;
    const srcData = sourceNode.data as Record<string, unknown>;
    const tgtData = targetNode.data as Record<string, unknown>;

    // Sub-component/feature → hardware: only one parent edge allowed, replace existing
    if ((srcType === 'subComponent' || srcType === 'feature') && tgtType === 'hardware') {
      const existing = edges.filter(
        (e) => e.source === connection.source && nodes.find((n) => n.id === e.target)?.type === 'hardware'
      );
      const id = nextEdgeId();
      const hwColor = getHardwareColor((tgtData.hardwareType as string) || 'other');
      const newEdge: AppEdge = {
        id,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? undefined,
        targetHandle: connection.targetHandle ?? undefined,
        data: { edgeType: 'configuration', sourceHardwareType: (tgtData.hardwareType || 'other') as HardwareType, color: hwColor },
        type: 'configuration',
      };
      set((s) => ({
        edges: [...s.edges.filter((e) => !existing.some((ex) => ex.id === e.id)), newEdge],
      }));
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

  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),
  removeNode: (id) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
    })),

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
    const node: Node = {
      id,
      type: 'hardware',
      position: pos,
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
    const parentNode = get().nodes.find((n) => n.id === parentId);
    // Count all right-side children (subComponent + group non-feature)
    const rightChildren = get().nodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      if (d.parentHardwareId !== parentId) return false;
      return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
    });
    const childCount = rightChildren.length;
    const pos = parentNode
      ? { x: parentNode.position.x + 300, y: parentNode.position.y - 50 + childCount * 80 }
      : { x: 400, y: 200 };

    // Determine component group from section type
    const componentGroup = COMPONENT_GROUP_MAP[sectionType] || 'other';

    const node: Node = {
      id,
      type: 'subComponent',
      position: pos,
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

    // Auto-create edge to parent
    const edgeId = nextEdgeId();
    const parentHwType = (parentNode?.data as Record<string, unknown>)?.hardwareType as string || 'mainboard';
    const edge: Edge = {
      id: edgeId,
      source: id,
      target: parentId,
      type: 'configuration',
      data: { edgeType: 'configuration', sourceHardwareType: parentHwType as HardwareType, color: getHardwareColor(parentHwType) },
    };

    set((s) => ({
      nodes: [...s.nodes, node as AppNode],
      edges: [...s.edges, edge as AppEdge],
    }));
    return id;
  },

  addFeatureNode: (parentId, sectionType, label, sectionHeader) => {
    const id = nextNodeId();
    const parentNode = get().nodes.find((n) => n.id === parentId);
    // Count all left-side children (feature + group feature)
    const leftChildren = get().nodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      const pid = d.parentId || d.parentHardwareId;
      if (pid !== parentId) return false;
      return n.type === 'feature' || (n.type === 'group' && d.isFeature);
    });
    const childCount = leftChildren.length;
    const pos = parentNode
      ? { x: parentNode.position.x - 300, y: parentNode.position.y - 50 + childCount * 70 }
      : { x: 100, y: 200 };

    const node: Node = {
      id,
      type: 'feature',
      position: pos,
      data: {
        label,
        sectionType,
        sectionHeader,
        section: { section_type: sectionType, section_name: '', full_header: sectionHeader, line_number: 0, params: [], header_comments: [] },
        parentId,
        hasErrors: false,
      },
    };

    const edgeId = nextEdgeId();
    const parentHwType2 = (parentNode?.data as Record<string, unknown>)?.hardwareType as string || 'mainboard';
    const edge: Edge = {
      id: edgeId,
      source: id,
      target: parentId,
      type: 'configuration',
      data: { edgeType: 'configuration', sourceHardwareType: parentHwType2 as HardwareType, color: getHardwareColor(parentHwType2) },
    };

    set((s) => ({
      nodes: [...s.nodes, node as AppNode],
      edges: [...s.edges, edge as AppEdge],
    }));
    return id;
  },

  addGroupNode: (parentId, componentGroup, label, children, isFeature) => {
    const id = nextNodeId();
    const parentNode = get().nodes.find((n) => n.id === parentId);

    // Position: features go LEFT, sub-components go RIGHT
    const existingChildren = get().nodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      const isChild = d.parentHardwareId === parentId || d.parentId === parentId;
      return isChild;
    });
    const childCount = existingChildren.length;
    const xOffset = isFeature ? -300 : 300;
    const pos = parentNode
      ? { x: parentNode.position.x + xOffset, y: parentNode.position.y - 50 + childCount * 80 }
      : { x: isFeature ? 100 : 400, y: 200 };

    const node: Node = {
      id,
      type: 'group',
      position: pos,
      data: {
        label,
        componentGroup,
        isFeature,
        children,
        parentHardwareId: parentId,
        hasErrors: false,
      },
    };

    const edgeId = nextEdgeId();
    const parentHwType = (parentNode?.data as Record<string, unknown>)?.hardwareType as string || 'mainboard';
    const edge: Edge = {
      id: edgeId,
      source: id,
      target: parentId,
      type: 'configuration',
      data: { edgeType: 'configuration', sourceHardwareType: parentHwType as HardwareType, color: getHardwareColor(parentHwType) },
    };

    set((s) => ({
      nodes: [...s.nodes, node as AppNode],
      edges: [...s.edges, edge as AppEdge],
    }));
    return id;
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

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearGraph: () => set({ nodes: [], edges: [], selectedNodeId: null }),
}));
