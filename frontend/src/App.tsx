import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  Panel,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from './stores/graphStore';
import { useConfigStore } from './stores/configStore';
import { useNativeStore } from './stores/nativeStore';
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
import MacroDesignerDialog from './components/dialogs/MacroDesignerDialog';

import type { AppEdge, AppNode, ValidationStatus } from './types/graph';
import type { MacroDesignerPersistedState } from './types/macroDesigner';
import { combineValidationStatuses } from './utils/validationStatus';
import { isBackupConfigFilename } from './utils/backupFiles';
import { useMacroDesignerStore } from './stores/macroDesignerStore';

function getSectionValidationKey(configFile: string | undefined, sectionHeader: string): string {
  return `${configFile || ''}::${sectionHeader}`;
}

function getSectionStatus(
  sectionStatuses: Map<string, ValidationStatus>,
  configFile: string | undefined,
  sectionHeader: string,
): ValidationStatus {
  return sectionStatuses.get(getSectionValidationKey(configFile, sectionHeader)) || 'valid';
}

function getDirectNodeStatus(
  node: AppNode,
  sectionStatuses: Map<string, ValidationStatus>,
): ValidationStatus {
  const nodeData = node.data as Record<string, unknown>;

  if (node.type === 'subComponent' || node.type === 'feature') {
    const sectionHeader = nodeData.sectionHeader;
    const configFile = typeof nodeData.configFile === 'string' ? nodeData.configFile : undefined;
    return typeof sectionHeader === 'string'
      ? getSectionStatus(sectionStatuses, configFile, sectionHeader)
      : 'valid';
  }

  if (node.type === 'group') {
    const children = Array.isArray(nodeData.children)
      ? nodeData.children as Array<{ sectionHeader?: string; configFile?: string }>
      : [];
    const fallbackConfigFile = typeof nodeData.configFile === 'string' ? nodeData.configFile : undefined;
    return combineValidationStatuses(children.map((child) => (
      typeof child.sectionHeader === 'string'
        ? getSectionStatus(sectionStatuses, child.configFile || fallbackConfigFile, child.sectionHeader)
        : 'valid'
    )));
  }

  return 'valid';
}

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

const HARDWARE_DRAG_PREVIEW_WIDTH = 400;
const HARDWARE_DRAG_PREVIEW_HEADER_HEIGHT = 110;
const HARDWARE_DRAG_PREVIEW_SLOT_HEIGHT = 40;
const HARDWARE_DRAG_PREVIEW_PADDING_BOTTOM = 16;
const HARDWARE_DRAG_PREVIEW_COLLAPSED_HEIGHT = 56;
const HARDWARE_DRAG_PREVIEW_COLLAPSED_WIDTH = 200;

function computeHardwareDragPreviewSize(nodes: Node[], hardwareId: string) {
  const children = nodes.filter((node) => node.parentId === hardwareId);
  const featureCount = children.filter((node) => {
    const nodeData = node.data as Record<string, unknown>;
    return node.type === 'feature' || (node.type === 'group' && !!nodeData.isFeature);
  }).length;
  const componentCount = children.filter((node) => {
    const nodeData = node.data as Record<string, unknown>;
    return node.type === 'subComponent' || (node.type === 'group' && !nodeData.isFeature);
  }).length;
  const rowCount = Math.max(featureCount, componentCount, 0);
  return {
    width: HARDWARE_DRAG_PREVIEW_WIDTH,
    height: Math.max(
      HARDWARE_DRAG_PREVIEW_HEADER_HEIGHT + rowCount * HARDWARE_DRAG_PREVIEW_SLOT_HEIGHT + HARDWARE_DRAG_PREVIEW_PADDING_BOTTOM,
      160,
    ),
  };
}

/** Saved edge layout entry (id may differ from rebuilt edges — pair-match). */
interface SavedEdgeLayout {
  id: string;
  source?: string;
  target?: string;
  data?: Record<string, unknown>;
  sourceHandle?: string;
  targetHandle?: string;
}

/**
 * Overlay saved edge routing (custom bend points + connection sides) onto the
 * freshly rebuilt graph. Matches by PAIR (source+target+edgeType), falling back
 * to id: edge ids come from a module-level counter, so a line drawn at runtime
 * (edge_7) gets a different id after the config rebuild than the one the save
 * captured. The source/target/type triple is stable across rebuilds, and comm
 * edges are matched direction-agnostically (the rebuild always emits SBC →
 * hardware but the user may have drawn the opposite way).
 */
function applySavedEdgeLayout(saved: SavedEdgeLayout[] | undefined, graphStore: ReturnType<typeof useGraphStore.getState>) {
  if (!saved || saved.length === 0) return;
  const pairKey = (e: { source?: string; target?: string; data?: Record<string, unknown> }) => {
    const t = (e.data as Record<string, unknown> | undefined)?.edgeType as string | undefined;
    const [a, b] = [e.source ?? '', e.target ?? ''].sort();
    return [a, b, t ?? ''].join('|');
  };
  const savedByPair = new Map(saved.map((e) => [pairKey(e), e]));
  const savedById = new Map(saved.map((e) => [e.id, e]));
  const currentEdges = useGraphStore.getState().edges;
  const updatedEdges = currentEdges.map((edge) => {
    const found = savedByPair.get(pairKey(edge)) ?? savedById.get(edge.id);
    if (!found) return edge;
    const next: Record<string, unknown> = { ...edge };
    if (found.data) {
      next.data = {
        ...edge.data,
        ...found.data,
        customMiddlePoints: (found.data as Record<string, unknown>).customMiddlePoints,
      } as unknown as import('./types/graph').AppEdge['data'];
    }
    if (found.sourceHandle) next.sourceHandle = found.sourceHandle;
    if (found.targetHandle) next.targetHandle = found.targetHandle;
    return next as import('./types/graph').AppEdge;
  });
  graphStore.setEdges(updatedEdges);
}

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
    setNodes,
    setDragHoverHardwareId,
  } = useGraphStore();

  const { selectedSection, setSelectedSection, validation } = useConfigStore();
  const macroDesignerDrafts = useMacroDesignerStore((state) => state.drafts);
  const macroDesignerNoGoZones = useMacroDesignerStore((state) => state.noGoZones);
  const macroDesignerDockPosition = useMacroDesignerStore((state) => state.dockPosition);
  const macroDesignerRotation = useMacroDesignerStore((state) => state.rotation);
  const [showTextView, setShowTextView] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showMacroDesigner, setShowMacroDesigner] = useState(false);
  const dragHoverHardwareIdRef = useRef<string | null>(null);

  // Load section schemas on mount
  useEffect(() => {
    api.getSchema().then((res) => {
      useConfigStore.getState().setSchemas(res.schemas);
    }).catch((err) => {
      console.error('Failed to load schemas:', err);
    });
  }, []);

  // Check native mode on mount
  useEffect(() => {
    useNativeStore.getState().checkNativeStatus();
  }, []);

  // Auto-read config from Pi on startup (native mode only).
  // On every page refresh, re-read from disk so unapplied changes are cleared.
  // Then restore graph positions from saved layout.
  const layoutRestored = useRef(false);
  useEffect(() => {
    if (layoutRestored.current) return;
    const unsub = useNativeStore.subscribe((state) => {
      if (state.isNative && !layoutRestored.current) {
        layoutRestored.current = true;
        (async () => {
          try {
            // List config files from the default path
            const listing = await api.listNativeConfigFiles(state.configPath);
            const cfgFiles = listing.files;
            if (cfgFiles.length === 0) {
              // No files found at default path. Skip auto-open behavior for now.
              unsub();
              return;
            }

            // Auto-select .cfg files, skip non-klipper and backup files
            const filenames = cfgFiles
              .filter((f) => {
                if (isBackupConfigFilename(f.name)) return false;
                const name = f.name.toLowerCase();
                return !(
                  name === 'moonraker.conf' || name === 'crowsnest.conf' ||
                  name === 'klipperscreen.conf' || name === 'sonar.conf' ||
                  name.endsWith('.bak') || name.endsWith('.old')
                );
              })
              .map((f) => f.name);

            if (filenames.length === 0) {
              // No usable Klipper config files found. Skip auto-open behavior for now.
              unsub();
              return;
            }

            // Ensure schemas are loaded
            let schemas = useConfigStore.getState().schemas;
            if (Object.keys(schemas).length === 0) {
              try {
                const schemaResult = await api.getSchema();
                useConfigStore.getState().setSchemas(schemaResult.schemas);
                schemas = schemaResult.schemas;
              } catch { /* proceed without */ }
            }

            // Read config files from Pi
            const result = await api.readNativeConfigFiles(filenames, state.configPath);

            const allConfigs: Record<string, import('./types/config').ConfigFile> = {};
            const allValidations: Record<string, import('./types/config').ValidationResult> = {};
            const configStore = useConfigStore.getState();

            for (const [filename, fileResult] of Object.entries(result.files)) {
              configStore.setConfigFile(filename, fileResult.config);
              configStore.setValidation(filename, fileResult.validation);
              allConfigs[filename] = fileResult.config;
              allValidations[filename] = fileResult.validation;

              if (fileResult.raw_text) {
                configStore.setOriginalText(filename, fileResult.raw_text);
              }
            }

            // Build graph from config
            const graphStore = useGraphStore.getState();
            const { buildProjectGraph } = await import('./utils/graphBuilder');
            buildProjectGraph(allConfigs, graphStore, schemas, allValidations);

            // Now try to restore graph positions from saved layout
            try {
              const layoutResult = await api.loadNativeLayout();
              if (layoutResult.layout) {
                const layout = layoutResult.layout as {
                  graphNodes?: Array<{ id: string; position: { x: number; y: number } }>;
                  graphEdges?: SavedEdgeLayout[];
                  macroDesigner?: MacroDesignerPersistedState;
                };
                if (layout.macroDesigner) {
                  useMacroDesignerStore.getState().hydratePersistedState(layout.macroDesigner);
                }
                // Overlay saved positions onto the newly built graph nodes
                if (layout.graphNodes) {
                  const positionMap = new Map(
                    layout.graphNodes.map((n) => [n.id, n.position]),
                  );
                  const currentNodes = useGraphStore.getState().nodes;
                  const updatedNodes = currentNodes.map((node) => {
                    const savedPos = positionMap.get(node.id);
                    if (savedPos) {
                      return { ...node, position: savedPos } as import('./types/graph').AppNode;
                    }
                    return node;
                  });
                  graphStore.setNodes(updatedNodes);
                }
                // Restore edge routing the same way as the browser-mode path
                // (pair-matched, direction-agnostic — see applySavedEdgeLayout).
                applySavedEdgeLayout(layout.graphEdges as SavedEdgeLayout[] | undefined, graphStore);
              }
            } catch { /* no saved layout — use auto-arranged positions */ }

            configStore.markClean();
          } catch {
            // Auto-read failed. Skip auto-open behavior for now.
          }
        })();
        unsub();
      } else if (state.isNative === false) {
        unsub();
      }
    });
    return unsub;
  }, []);

  // Restore saved configs from disk on startup (non-native fallback).
  // If native mode already loaded configs, this does nothing.
  const savedConfigRestored = useRef(false);
  useEffect(() => {
    if (savedConfigRestored.current) return;

    savedConfigRestored.current = true;  // Mark immediately to prevent double-load

    const configStore = useConfigStore.getState();
    const existingFiles = Object.keys(configStore.configFiles);
    if (existingFiles.length > 0) {
      // Native mode already loaded configs — skip restore
      return;
    }

    (async () => {
      try {
        const result = await api.loadSavedConfigs();
        if (!result.files || Object.keys(result.files).length === 0) return;

        let schemas = configStore.schemas;
        if (Object.keys(schemas).length === 0) {
          try {
            const schemaResult = await api.getSchema();
            configStore.setSchemas(schemaResult.schemas);
            schemas = schemaResult.schemas;
          } catch { /* proceed without */ }
        }

        // Use loadConfigs to replace all configs at once (avoids duplicates)
        const allConfigs: Record<string, import('./types/config').ConfigFile> = {};
        const allValidations: Record<string, import('./types/config').ValidationResult> = {};

        for (const [filename, fileResult] of Object.entries(result.files)) {
          allConfigs[filename] = fileResult.config;
          allValidations[filename] = fileResult.validation;
        }

        configStore.loadConfigs(allConfigs);

        for (const [filename, validation] of Object.entries(allValidations)) {
          configStore.setValidation(filename, validation);
        }

        for (const [filename, config] of Object.entries(allConfigs)) {
          if (config.raw_text) {
            configStore.setOriginalText(filename, config.raw_text);
          }
        }

        // Clear graph first, then rebuild to avoid duplicate nodes
        const graphStore = useGraphStore.getState();
        graphStore.clearGraph();
        const { buildProjectGraph } = await import('./utils/graphBuilder');
        buildProjectGraph(allConfigs, graphStore, schemas, allValidations);

        // Browser mode: restore saved layout from localStorage (if any)
        try {
          const saved = localStorage.getItem('kwc.graphLayout');
          if (saved) {
            const layout = JSON.parse(saved) as {
              graphNodes?: Array<{ id: string; position: { x: number; y: number } }>;
              graphEdges?: Array<{
                id: string;
                data?: Record<string, unknown>;
                sourceHandle?: string;
                targetHandle?: string;
              }>;
              macroDesigner?: MacroDesignerPersistedState;
            };
            if (layout.macroDesigner) {
              useMacroDesignerStore.getState().hydratePersistedState(layout.macroDesigner);
            }
            if (layout.graphNodes) {
              const positionMap = new Map(
                layout.graphNodes.map((n) => [n.id, n.position]),
              );
              const currentNodes = useGraphStore.getState().nodes;
              const updatedNodes = currentNodes.map((node) => {
                const savedPos = positionMap.get(node.id);
                if (savedPos) {
                  return { ...node, position: savedPos } as import('./types/graph').AppNode;
                }
                return node;
              });
              graphStore.setNodes(updatedNodes);
            }
            // Restore edge routing: custom bend points + which side of each
            // node the line connects to. Without this, a refresh resets every
            // trace to default top/bottom routing even though card positions
            // survived.
            applySavedEdgeLayout(layout.graphEdges, graphStore);
          }
        } catch { /* malformed/absent layout — keep auto-arranged positions */ }

        configStore.markClean();
      } catch {
        // No saved configs — that's fine, start empty
      }
    })();
  }, []);

  // Auto-save layout (debounced). Native mode persists via the backend;
  // browser mode falls back to localStorage so arrangements survive refresh.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isNative = useNativeStore.getState().isNative;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (nodes.length === 0) return;
      const macroDesigner = useMacroDesignerStore.getState().exportPersistedState();
      if (isNative) {
        api.saveNativeLayout({
          graphNodes: nodes,
          graphEdges: edges,
          macroDesigner,
        }).catch(() => { /* ignore save errors */ });
      } else {
        try {
          localStorage.setItem('kwc.graphLayout', JSON.stringify({
            graphNodes: nodes.map((n) => ({ id: n.id, position: n.position })),
            graphEdges: edges.map((e) => ({
              id: e.id,
              data: e.data,
              sourceHandle: e.sourceHandle ?? undefined,
              targetHandle: e.targetHandle ?? undefined,
            })),
            macroDesigner,
          }));
        } catch { /* ignore quota / privacy-mode errors */ }
      }
    }, 3000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    nodes,
    edges,
    macroDesignerDrafts,
    macroDesignerNoGoZones,
    macroDesignerDockPosition,
    macroDesignerRotation,
  ]);

  useEffect(() => {
    const sectionStatuses = new Map<string, ValidationStatus>();
    for (const [filename, result] of Object.entries(validation)) {
      for (const issue of result.errors) {
        if (!issue.section) continue;
        const sectionKey = getSectionValidationKey(filename, issue.section);
        const currentStatus = sectionStatuses.get(sectionKey) || 'valid';
        if (issue.severity === 'error') {
          sectionStatuses.set(sectionKey, 'error');
        } else if (issue.severity === 'warning' && currentStatus !== 'error') {
          sectionStatuses.set(sectionKey, 'warning');
        }
      }
    }

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const childrenByParent = new Map<string, AppNode[]>();

    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = childrenByParent.get(node.parentId) || [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    }

    const statusByNodeId = new Map<string, ValidationStatus>();
    const stack = new Set<string>();

    const computeNodeStatus = (nodeId: string): ValidationStatus => {
      const cached = statusByNodeId.get(nodeId);
      if (cached !== undefined) return cached;
      if (stack.has(nodeId)) return 'valid';

      stack.add(nodeId);
      const node = nodesById.get(nodeId);
      if (!node) {
        stack.delete(nodeId);
        return 'valid';
      }

      const directStatus = getDirectNodeStatus(node, sectionStatuses);
      const childNodes = childrenByParent.get(nodeId) || [];
      const childStatuses = childNodes.map((child) => computeNodeStatus(child.id));
      const nextStatus = combineValidationStatuses([directStatus, ...childStatuses]);

      stack.delete(nodeId);
      statusByNodeId.set(nodeId, nextStatus);
      return nextStatus;
    };

    let changed = false;
    const nextNodes = nodes.map((node) => {
      const nextStatus = computeNodeStatus(node.id);
      const currentData = node.data as Record<string, unknown>;
      const currentHasErrors = !!currentData.hasErrors;
      const currentStatus = (currentData.validationStatus as ValidationStatus | undefined) || 'valid';
      let nextChildren = currentData.children;

      if (node.type === 'group' && Array.isArray(currentData.children)) {
        const currentChildren = currentData.children as Array<Record<string, unknown>>;
        const fallbackConfigFile = typeof currentData.configFile === 'string' ? currentData.configFile : undefined;
        const updatedChildren = currentChildren.map((child) => {
          const sectionHeader = child.sectionHeader;
          const configFile = typeof child.configFile === 'string' ? child.configFile : fallbackConfigFile;
          const childStatus = typeof sectionHeader === 'string'
            ? getSectionStatus(sectionStatuses, configFile, sectionHeader)
            : 'valid';
          const childHasErrors = childStatus === 'error';
          if (child.validationStatus === childStatus && !!child.hasErrors === childHasErrors) {
            return child;
          }
          return {
            ...child,
            validationStatus: childStatus,
            hasErrors: childHasErrors,
          };
        });
        if (updatedChildren.some((child, index) => child !== currentChildren[index])) {
          nextChildren = updatedChildren;
        }
      }

      if (
        currentHasErrors === (nextStatus === 'error')
        && currentStatus === nextStatus
        && nextChildren === currentData.children
      ) {
        return node;
      }
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          hasErrors: nextStatus === 'error',
          validationStatus: nextStatus,
          ...(nextChildren !== currentData.children ? { children: nextChildren } : {}),
        },
      } as AppNode;
    });

    if (changed) {
      setNodes(nextNodes);
    }
  }, [nodes, setNodes, validation]);

  // Keyboard shortcuts for undo/redo (graph only — let textarea handle its own undo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTextInput = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      );

      // When the text view is active or a text input has focus, let the browser handle undo/redo natively.
      if (showTextView || isTextInput) return;
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
  }, [undo, redo, showTextView]);

  const { toggleHardwareCollapse } = useGraphStore();
  const CHILD_TYPES = new Set(['subComponent', 'feature', 'group', 'customGroup']);
  const DRAGGED_CHILD_Z_INDEX = 1000;

  const clearDragHoverPreview = useCallback(() => {
    if (dragHoverHardwareIdRef.current === null) return;
    dragHoverHardwareIdRef.current = null;
    setDragHoverHardwareId(null);
  }, [setDragHoverHardwareId]);

  const getAbsoluteNodePosition = useCallback((draggedNode: Node, currentNodes: Node[]) => {
    let absX = draggedNode.position.x;
    let absY = draggedNode.position.y;
    const parentId = draggedNode.parentId ?? null;
    if (parentId) {
      const parentNode = currentNodes.find((node) => node.id === parentId);
      if (parentNode) {
        absX += parentNode.position.x;
        absY += parentNode.position.y;
      }
    }
    return { x: absX, y: absY };
  }, []);

  const getContainerBounds = useCallback((container: Node, currentNodes: Node[]) => {
    if (container.type === 'hardware') {
      const nodeData = container.data as Record<string, unknown>;
      if (nodeData.collapsed) {
        return computeHardwareDragPreviewSize(currentNodes, container.id);
      }
      return {
        width: (container.style?.width as number) || HARDWARE_DRAG_PREVIEW_WIDTH,
        height: (container.style?.height as number) || HARDWARE_DRAG_PREVIEW_COLLAPSED_HEIGHT,
      };
    }

    return {
      width: (container.style?.width as number) || HARDWARE_DRAG_PREVIEW_COLLAPSED_WIDTH,
      height: (container.style?.height as number) || HARDWARE_DRAG_PREVIEW_COLLAPSED_HEIGHT,
    };
  }, []);

  const getHoveredHardwareId = useCallback((draggedNode: Node, currentNodes: Node[]) => {
    if (!CHILD_TYPES.has(draggedNode.type || '')) return null;
    const absolutePosition = getAbsoluteNodePosition(draggedNode, currentNodes);
    const nodeCenterX = absolutePosition.x + 90;
    const nodeCenterY = absolutePosition.y + 18;
    const candidates: Array<{ id: string; distance: number }> = [];

    for (const container of currentNodes) {
      if (container.type !== 'hardware' || container.id === draggedNode.id) continue;
      const containerData = container.data as Record<string, unknown>;
      if (containerData.hardwareType === 'sbc' && !containerData.isMcu) continue;
      const { width, height } = getContainerBounds(container, currentNodes);
      if (
        nodeCenterX >= container.position.x
        && nodeCenterX <= container.position.x + width
        && nodeCenterY >= container.position.y
        && nodeCenterY <= container.position.y + height
      ) {
        candidates.push({
          id: container.id,
          distance: Math.hypot(
            nodeCenterX - (container.position.x + width / 2),
            nodeCenterY - (container.position.y + height / 2),
          ),
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const existingCandidate = candidates.find((candidate) => candidate.id === dragHoverHardwareIdRef.current);
    if (existingCandidate) {
      return existingCandidate.id;
    }

    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0].id;
  }, [CHILD_TYPES, getAbsoluteNodePosition, getContainerBounds]);

  const finalizeNodeDrag = useCallback((draggedNodeId: string | null) => {
    clearDragHoverPreview();
    if (draggedNodeId) {
      setSelectedNode(draggedNodeId);
    }
  }, [clearDragHoverPreview, setSelectedNode]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: AppNode) => {
      clearDragHoverPreview();
      setSelectedNode(node.id);
      setSelectedEdge(null);
      const data = node.data as Record<string, unknown>;
      if (data?.sectionHeader) {
        setSelectedSection(
          data.sectionHeader as string,
          data.configFile as string | undefined,
          typeof data.sectionLineNumber === 'number' ? data.sectionLineNumber as number : null,
        );
      } else {
        setSelectedSection(null);
      }
      // Expand collapsed hardware / customGroup nodes on click,
      // but skip SBC nodes that are not enabled as an MCU (they have no sub-components)
      const isSbcWithoutMcu = node.type === 'hardware' && data?.hardwareType === 'sbc' && !data?.isMcu;
      if (!isSbcWithoutMcu && (node.type === 'hardware' || node.type === 'customGroup') && data?.collapsed) {
        toggleHardwareCollapse(node.id);
      }
    },
    [clearDragHoverPreview, setSelectedNode, setSelectedEdge, setSelectedSection, toggleHardwareCollapse],
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
    clearDragHoverPreview();
    setSelectedNode(null);
    setSelectedEdge(null);
    setSelectedSection(null);
  }, [clearDragHoverPreview, setSelectedNode, setSelectedEdge, setSelectedSection]);

  const onNodeDragStart = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      clearDragHoverPreview();
      const data = draggedNode.data as Record<string, unknown>;
      setSelectedNode(draggedNode.id);
      setSelectedEdge(null);
      setSelectedSection(
        typeof data.sectionHeader === 'string' ? data.sectionHeader : null,
        data.configFile as string | undefined,
        typeof data.sectionLineNumber === 'number' ? data.sectionLineNumber as number : null,
      );

      useGraphStore.setState((s) => ({
        nodes: s.nodes.map((node) => {
          if (node.id !== draggedNode.id || !CHILD_TYPES.has(node.type || '')) return node;
          return { ...node, zIndex: DRAGGED_CHILD_Z_INDEX } as AppNode;
        }),
        edges: s.edges.map((edge) => {
          const edgeData = edge.data as Record<string, unknown> | undefined;
          if ((edge.source !== draggedNode.id && edge.target !== draggedNode.id) || !edgeData?.customMiddlePoints) {
            return edge;
          }
          return {
            ...edge,
            data: {
              ...edgeData,
              customMiddlePoints: undefined,
            } as unknown as AppEdge['data'],
          } as AppEdge;
        }),
      }));
    },
    [CHILD_TYPES, clearDragHoverPreview, setSelectedEdge, setSelectedNode, setSelectedSection],
  );

  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      if (!CHILD_TYPES.has(draggedNode.type || '')) return;

      const currentNodes = useGraphStore.getState().nodes;
      const hoveredHardwareId = getHoveredHardwareId(draggedNode, currentNodes);
      if (hoveredHardwareId === dragHoverHardwareIdRef.current) {
        return;
      }

      dragHoverHardwareIdRef.current = hoveredHardwareId;
      setDragHoverHardwareId(hoveredHardwareId);
    },
    [CHILD_TYPES, getHoveredHardwareId, setDragHoverHardwareId],
  );

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
   * - Child nodes: snap into correct column (features left, components right),
   *   reorder by Y position, group same-componentGroup siblings on overlap,
   *   reparent into containers when dragged outside.
   */
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      const currentNodes = useGraphStore.getState().nodes;

      /* ── Hardware node overlap prevention ───────────────── */
      if (draggedNode.type === 'hardware') {
        const otherHardware = currentNodes.filter(
          (n) => n.type === 'hardware' && n.id !== draggedNode.id && !n.parentId,
        );
        const dragW = (draggedNode.style?.width as number) || 400;
        const dragH = (draggedNode.style?.height as number) || 400;
        const newPos = resolveOverlap(
          draggedNode.id,
          draggedNode.position,
          dragW,
          dragH,
          otherHardware,
          (n) => ({
            w: (n.style?.width as number) || 400,
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
        finalizeNodeDrag(draggedNode.id);
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
        const dragCenterX = draggedNode.position.x + 90;
        const dragCenterY = draggedNode.position.y + 18;
        for (const sib of siblings) {
          const sibW = 180;
          const sibH = 36;
          if (
            dragCenterX >= sib.position.x &&
            dragCenterX <= sib.position.x + sibW &&
            dragCenterY >= sib.position.y &&
            dragCenterY <= sib.position.y + sibH
          ) {
            const dragGroup = (draggedNode.data as Record<string, unknown>)?.componentGroup as string | undefined;
            const sibGroup = (sib.data as Record<string, unknown>)?.componentGroup as string | undefined;

            if (dragGroup && sibGroup && dragGroup === sibGroup) {
              const isFeature = draggedNode.type === 'feature' || sib.type === 'feature';

              const children: Array<{
                sectionType: string;
                label: string;
                sectionHeader: string;
                sectionLineNumber?: number;
                isFeature: boolean;
                params: Array<{ key: string; value: string }>;
                configFile?: string;
              }> = [];
              const configStore = useConfigStore.getState();

              const extractChildren = (nd: Node) => {
                const d = nd.data as Record<string, unknown>;
                if (nd.type === 'group' && Array.isArray(d.children)) {
                  for (const c of d.children as Array<{ sectionType: string; label: string; sectionHeader: string; sectionLineNumber?: number; isFeature: boolean; params: Array<{ key: string; value: string }>; configFile?: string }>) {
                    children.push(c);
                  }
                } else {
                  const configFile = d.configFile as string | undefined;
                  const sectionHeader = (d.sectionHeader as string) || '';
                  const sectionLineNumber = d.sectionLineNumber as number | undefined;
                  const section = configFile && sectionHeader
                    ? configStore.getSection(configFile, sectionHeader, sectionLineNumber)
                    : null;
                  children.push({
                    sectionType: (d.sectionType as string) || '',
                    label: (d.label as string) || '',
                    sectionHeader,
                    sectionLineNumber,
                    isFeature: nd.type === 'feature',
                    params: section?.params.filter((p) => !p.is_commented_out).map((p) => ({ key: p.key, value: p.value })) || [],
                    configFile,
                  });
                }
              };

              extractChildren(draggedNode);
              extractChildren(sib);

              if (children.length > 0) {
                const { addGroupNode, removeNodeFromGraph, reflowParentChildren, pushHistory } = useGraphStore.getState();
                const groupLabel = dragGroup.charAt(0).toUpperCase() + dragGroup.slice(1).replace(/_/g, ' ');
                pushHistory();
                const groupId = addGroupNode(oldParentId, dragGroup, groupLabel + 's', children, isFeature);
                removeNodeFromGraph(draggedNode.id);
                removeNodeFromGraph(sib.id);
                if (oldParentId) reflowParentChildren(oldParentId);
                finalizeNodeDrag(groupId);
              }
              return;
            }
            // Different types — will be snapped into column below
            break;
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
      const nodeCenterX = absX + 90;
      const nodeCenterY = absY + 18;

      for (const container of containerNodes) {
        const { width: w, height: h } = getContainerBounds(container, currentNodes);

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
        if (newParentId) {
          const parentNow = useGraphStore.getState().nodes.find((node) => node.id === newParentId);
          const parentData = parentNow?.data as Record<string, unknown> | undefined;
          if (parentNow?.type === 'hardware' && parentData?.collapsed) {
            toggleHardwareCollapse(newParentId);
          }
        }
        finalizeNodeDrag(draggedNode.id);
        return;
      }

      // Node stayed in same parent — snap into column and reorder by Y position
      if (oldParentId) {
        const { snapChildrenToColumns } = useGraphStore.getState();
        snapChildrenToColumns(oldParentId, draggedNode.id, draggedNode.position.y);
      }
      finalizeNodeDrag(draggedNode.id);
    },
    [CHILD_TYPES, finalizeNodeDrag, getContainerBounds, reparentNode, toggleHardwareCollapse],
  );

  return (
    <div className="flex flex-col h-screen w-screen">
      {/* Header */}
      <header className="flex items-center gap-4 h-12 px-4 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shrink-0 overflow-hidden">
        <div className="flex items-center gap-3 shrink-0">
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
        <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
          <div className="flex justify-end min-w-max pl-2">
            <Toolbar
              showTextView={showTextView}
              onToggleAddMenu={() => setShowAddMenu(!showAddMenu)}
              onOpenMacroDesigner={() => setShowMacroDesigner(true)}
              onToggleTextView={() => {
                // Text edits apply to the model live, so switching views is
                // always safe — nothing to apply, nothing to lose.
                // Both views stay mounted; ReactFlow keeps viewport + selection.
                setShowTextView(!showTextView);
              }}
            />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph or Text view — both stay mounted so ReactFlow keeps its
            viewport/zoom/selection across toggles; only visibility flips. */}
        <div className="flex-1 relative">
          <div className={showTextView ? 'hidden' : 'h-full w-full'}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              snapToGrid
              snapGrid={[20, 20]}
              connectionRadius={30}
              connectionMode={ConnectionMode.Loose}
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
          </div>
          <div className={showTextView ? 'h-full w-full' : 'hidden'}>
            <TextEditor isActive={showTextView} />
          </div>

          {/* Add Menu Overlay */}
          {showAddMenu && (
            <AddMenu onClose={() => setShowAddMenu(false)} />
          )}
          {showMacroDesigner && (
            <MacroDesignerDialog onClose={() => setShowMacroDesigner(false)} />
          )}
        </div>

        {/* Settings Panel (right sidebar) — hidden when text view is active */}
        {!showTextView && (selectedNodeId || selectedEdgeId) && (
          <SettingsPanel />
        )}
      </div>

    </div>
  );
}
