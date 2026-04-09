import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from './stores/graphStore';
import { useConfigStore } from './stores/configStore';
import * as api from './services/api';
import HardwareNode from './components/nodes/HardwareNode';
import SubComponentNode from './components/nodes/SubComponentNode';
import FeatureNode from './components/nodes/FeatureNode';
import GroupNode from './components/nodes/GroupNode';
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
};

const edgeTypes: EdgeTypes = {
  communication: CommunicationEdge,
  configuration: ConfigurationEdge,
};

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
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              snapToGrid
              snapGrid={[20, 20]}
              deleteKeyCode="Delete"
              className="bg-[var(--color-bg-primary)]"
            >
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
