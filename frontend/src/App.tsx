import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  Panel,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from './stores/graphStore';
import { useConfigStore } from './stores/configStore';
import * as api from './services/api';
import HardwareNode from './components/nodes/HardwareNode';
import SubComponentNode from './components/nodes/SubComponentNode';
import FeatureNode from './components/nodes/FeatureNode';
import GroupNode from './components/nodes/GroupNode';
import CustomGroupNode from './components/nodes/CustomGroupNode';
import CommunicationEdge from './components/edges/CommunicationEdge';
import ConfigurationEdge from './components/edges/ConfigurationEdge';
import SettingsPanel from './components/SettingsPanel';
import TextEditor from './components/TextEditor';
import Toolbar from './components/Toolbar';
import AddMenu from './components/AddMenu';

import type { AppNode } from './types/graph';

const nodeTypes: NodeTypes = {
  hardware: HardwareNode,
  subComponent: SubComponentNode,
  feature: FeatureNode,
  group: GroupNode,
  customGroup: CustomGroupNode,
};

const edgeTypes: EdgeTypes = {
  communication: CommunicationEdge,
  configuration: ConfigurationEdge,
};

/** Sits inside <ReactFlow> and calls fitView whenever trigger increments. */
function AutoFitController({ trigger }: { trigger: number }) {
  const { fitView } = useReactFlow();
  const prevTrigger = useRef(trigger);
  useEffect(() => {
    if (trigger !== prevTrigger.current) {
      prevTrigger.current = trigger;
      // Small timeout to let ReactFlow finish positioning nodes before fitting
      const id = setTimeout(() => fitView({ padding: 0.12, duration: 400 }), 80);
      return () => clearTimeout(id);
    }
  }, [trigger, fitView]);
  return null;
}

export default function App() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    selectedNodeId,
    setSelectedNode,
    selectedEdgeId,
    setSelectedEdge,
    updateEdgeData,
    reparentNode,
    autoArrange,
    undo,
    redo,
    canUndo,
    canRedo,
    fitViewTrigger,
  } = useGraphStore();

  const { selectedSection, setSelectedSection } = useConfigStore();
  const [showTextView, setShowTextView] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Load section schemas on mount
  useEffect(() => {
    api.getSchema().then((res) => {
      useConfigStore.getState().setSchemas(res.schemas);
    }).catch((err) => {
      console.error('Failed to load schemas:', err);
    });
  }, []);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: AppNode) => {
      setSelectedNode(node.id);
      setSelectedEdge(null);
      const data = node.data as Record<string, unknown>;
      if (data?.sectionHeader) {
        setSelectedSection(data.sectionHeader as string);
      } else {
        setSelectedSection(null);
      }
    },
    [setSelectedNode, setSelectedEdge, setSelectedSection],
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: { id: string }) => {
      setSelectedEdge(edge.id);
      setSelectedNode(null);
      setSelectedSection(null);
    },
    [setSelectedEdge, setSelectedNode, setSelectedSection],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setSelectedSection(null);
  }, [setSelectedNode, setSelectedEdge, setSelectedSection]);

  /**
   * Find the nearest non-overlapping position by nudging rightward, then
   * wrapping to the next row, until no peers are overlapped.
   */
  const resolveOverlap = (
    nodeId: string,
    pos: { x: number; y: number },
    nodeW: number,
    nodeH: number,
    peers: Node[],
    getSize: (n: Node) => { w: number; h: number },
  ): { x: number; y: number } => {
    const GAP = 20;
    const result = { ...pos };
    let iterations = 0;
    while (iterations++ < 50) {
      let collided = false;
      for (const peer of peers) {
        if (peer.id === nodeId) continue;
        const ps = getSize(peer);
        if (
          result.x < peer.position.x + ps.w &&
          result.x + nodeW > peer.position.x &&
          result.y < peer.position.y + ps.h &&
          result.y + nodeH > peer.position.y
        ) {
          // Nudge to the right of this peer
          result.x = peer.position.x + ps.w + GAP;
          collided = true;
          break;
        }
      }
      if (!collided) break;
    }
    return result;
  };

  /**
   * After any node drag-stop:
   * - Hardware nodes: prevent overlap with other top-level hardware.
   * - Child nodes: group same-componentGroup siblings on overlap;
   *   nudge apart for different types; reparent into containers.
   */
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      const currentNodes = useGraphStore.getState().nodes;
      const CHILD_TYPES = new Set(['subComponent', 'feature', 'group', 'customGroup']);

      /* ── Hardware node overlap prevention ───────────────── */
      if (draggedNode.type === 'hardware') {
        const otherHardware = currentNodes.filter(
          (n) => n.type === 'hardware' && n.id !== draggedNode.id && !n.parentId,
        );
        const dragW = (draggedNode.style?.width as number) || 600;
        const dragH = (draggedNode.style?.height as number) || 400;
        const newPos = resolveOverlap(
          draggedNode.id,
          draggedNode.position,
          dragW,
          dragH,
          otherHardware,
          (n) => ({
            w: (n.style?.width as number) || 600,
            h: (n.style?.height as number) || 400,
          }),
        );
        if (newPos.x !== draggedNode.position.x || newPos.y !== draggedNode.position.y) {
          useGraphStore.setState((s) => ({
            nodes: s.nodes.map((n) =>
              n.id === draggedNode.id ? { ...n, position: newPos } as AppNode : n,
            ),
          }));
        }
        return;
      }

      /* ── Child nodes ───────────────────────────────────── */
      if (!CHILD_TYPES.has(draggedNode.type || '')) return;

      const oldParentId = draggedNode.parentId ?? null;

      // Compute absolute position (position is relative to current parent)
      let absX = draggedNode.position.x;
      let absY = draggedNode.position.y;
      if (oldParentId) {
        const parentNode = currentNodes.find((n) => n.id === oldParentId);
        if (parentNode) {
          absX += parentNode.position.x;
          absY += parentNode.position.y;
        }
      }

      // Check for drop-on-sibling: group only if same componentGroup
      if (oldParentId) {
        const siblings = currentNodes.filter(
          (n) => n.parentId === oldParentId && n.id !== draggedNode.id && CHILD_TYPES.has(n.type || ''),
        );
        const dragCenterX = draggedNode.position.x + 134;
        const dragCenterY = draggedNode.position.y + 50;
        for (const sib of siblings) {
          const sibW = 268;
          const sibH = 100;
          if (
            dragCenterX >= sib.position.x &&
            dragCenterX <= sib.position.x + sibW &&
            dragCenterY >= sib.position.y &&
            dragCenterY <= sib.position.y + sibH
          ) {
            // Only group when both nodes share the same componentGroup
            const dragGroup = (draggedNode.data as Record<string, unknown>)?.componentGroup as string | undefined;
            const sibGroup = (sib.data as Record<string, unknown>)?.componentGroup as string | undefined;

            if (dragGroup && sibGroup && dragGroup === sibGroup) {
              // Collect section data from both nodes to create a proper GroupNode
              const dragData = draggedNode.data as Record<string, unknown>;
              const sibData = sib.data as Record<string, unknown>;
              const isFeature = draggedNode.type === 'feature' || sib.type === 'feature';

              // Build children array from both nodes' section data
              const children: Array<{
                sectionType: string;
                label: string;
                sectionHeader: string;
                isFeature: boolean;
                params: Array<{ key: string; value: string }>;
              }> = [];

              // Helper to extract child data from a node (handles group nodes with existing children)
              const extractChildren = (nd: Node) => {
                const d = nd.data as Record<string, unknown>;
                if (nd.type === 'group' && Array.isArray(d.children)) {
                  // Already a group — merge its children
                  for (const c of d.children as Array<{ sectionType: string; label: string; sectionHeader: string; isFeature: boolean; params: Array<{ key: string; value: string }> }>) {
                    children.push(c);
                  }
                } else {
                  // Single sub-component or feature node
                  const section = d.section as { params?: Array<{ key: string; value: string; is_commented_out?: boolean }> } | undefined;
                  children.push({
                    sectionType: (d.sectionType as string) || '',
                    label: (d.label as string) || '',
                    sectionHeader: (d.sectionHeader as string) || '',
                    isFeature: nd.type === 'feature',
                    params: section?.params?.filter((p) => !p.is_commented_out).map((p) => ({ key: p.key, value: p.value })) || [],
                  });
                }
              };

              extractChildren(draggedNode);
              extractChildren(sib);

              if (children.length > 0) {
                const { addGroupNode, removeNode } = useGraphStore.getState();
                const groupLabel = dragGroup.charAt(0).toUpperCase() + dragGroup.slice(1).replace(/_/g, ' ');
                addGroupNode(oldParentId, dragGroup, groupLabel + 's', children, isFeature);
                // Remove the two original nodes
                removeNode(draggedNode.id);
                removeNode(sib.id);
              }
              return;
            }

            // Different types overlapping → nudge the dragged node away
            const nudged = resolveOverlap(
              draggedNode.id,
              draggedNode.position,
              268,
              100,
              siblings,
              () => ({ w: 268, h: 100 }),
            );
            if (nudged.x !== draggedNode.position.x || nudged.y !== draggedNode.position.y) {
              useGraphStore.setState((s) => ({
                nodes: s.nodes.map((n) =>
                  n.id === draggedNode.id ? { ...n, position: nudged } as AppNode : n,
                ),
              }));
            }
            return;
          }
        }
      }

      // Find container nodes (hardware or customGroup) that contain the drop point
      const containerNodes = currentNodes.filter(
        (n) =>
          (n.type === 'hardware' || n.type === 'customGroup') &&
          n.id !== draggedNode.id,
      );

      let newParentId: string | null = null;
      const nodeCenterX = absX + 134;
      const nodeCenterY = absY + 50;

      for (const container of containerNodes) {
        const w = (container.style?.width as number) || 600;
        const h = (container.style?.height as number) || 400;

        if (
          nodeCenterX >= container.position.x &&
          nodeCenterX <= container.position.x + w &&
          nodeCenterY >= container.position.y &&
          nodeCenterY <= container.position.y + h
        ) {
          newParentId = container.id;
          break;
        }
      }

      // Reparent if the parent changed (reparent already snaps to grid)
      if (newParentId !== oldParentId) {
        reparentNode(draggedNode.id, newParentId, { x: absX, y: absY });
        return;
      }

      // Node stayed in same parent with no center-overlap grouping.
      // Still check for any AABB overlap with siblings and nudge if needed.
      if (oldParentId) {
        const siblings = currentNodes.filter(
          (n) => n.parentId === oldParentId && n.id !== draggedNode.id && CHILD_TYPES.has(n.type || ''),
        );
        const nudged = resolveOverlap(
          draggedNode.id,
          draggedNode.position,
          268,
          100,
          siblings,
          () => ({ w: 268, h: 100 }),
        );
        if (nudged.x !== draggedNode.position.x || nudged.y !== draggedNode.position.y) {
          useGraphStore.setState((s) => ({
            nodes: s.nodes.map((n) =>
              n.id === draggedNode.id ? { ...n, position: nudged } as AppNode : n,
            ),
          }));
        }
      }
    },
    [reparentNode],
  );

  return (
    <div className="flex flex-col h-screen w-screen">
      {/* Header */}
      <header className="flex items-center justify-between h-12 px-4 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shrink-0">
        <div className="flex items-center gap-3">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="4" fill="#1e293b" />
            <path d="M8 16h16M16 8v16" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
            <circle cx="8" cy="16" r="2.5" fill="#38bdf8" />
            <circle cx="24" cy="16" r="2.5" fill="#38bdf8" />
            <circle cx="16" cy="8" r="2.5" fill="#f472b6" />
            <circle cx="16" cy="24" r="2.5" fill="#f472b6" />
          </svg>
          <h1 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Klipper Wire Configurator
          </h1>
        </div>
        <Toolbar
          showTextView={showTextView}
          onToggleTextView={() => setShowTextView(!showTextView)}
        />
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph or Text view */}
        <div className="flex-1 relative">
          {showTextView ? (
            <TextEditor />
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onNodeDragStop={onNodeDragStop}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              snapToGrid
              snapGrid={[20, 20]}
              connectionRadius={30}
              connectionMode="loose"
              deleteKeyCode="Delete"
              className="bg-[var(--color-bg-primary)]"
              elevateNodesOnSelect={false}
            >
              <AutoFitController trigger={fitViewTrigger} />
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#334155" />
              <Controls />
              <MiniMap
                nodeStrokeWidth={3}
                pannable
                zoomable
              />
              <Panel position="top-left" className="flex gap-2">
                <button
                  onClick={() => setShowAddMenu(!showAddMenu)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg-primary)] font-medium text-sm hover:bg-[var(--color-accent-hover)] transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Add Component
                </button>
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  title="Undo (Ctrl+Z)"
                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M6 3L3 6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={redo}
                  disabled={!canRedo}
                  title="Redo (Ctrl+Y)"
                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M13 6H6a3 3 0 000 6h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={autoArrange}
                  title="Auto-arrange layout"
                  className="flex items-center gap-1.5 px-3 h-9 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors text-xs font-medium"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="1" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <rect x="10" y="1" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <rect x="5.5" y="11" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M3.5 5v3h5v-3M8 8v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                  Arrange
                </button>
              </Panel>
            </ReactFlow>
          )}

          {/* Add Menu Overlay */}
          {showAddMenu && (
            <AddMenu onClose={() => setShowAddMenu(false)} />
          )}
        </div>

        {/* Settings Panel (right sidebar) */}
        {(selectedNodeId || selectedEdgeId) && (
          <SettingsPanel />
        )}
      </div>
    </div>
  );
}
