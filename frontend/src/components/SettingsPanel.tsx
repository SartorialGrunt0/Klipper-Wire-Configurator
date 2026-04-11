import { useState, useCallback, useMemo } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import type { ParamSchema, ConfigParam, ConfigSection } from '../types/config';
import type { HardwareNodeData, SubComponentNodeData, FeatureNodeData, AppNode, AppEdge } from '../types/graph';
import { updateAllSectionPins } from '../utils/pinUtils';
import McuNameDialog from './dialogs/McuNameDialog';

// Pin param names that should be unique
const PIN_PARAM_NAMES = new Set(['pin', 'sensor_pin', 'heater_pin', 'step_pin', 'dir_pin', 'enable_pin', 'endstop_pin', 'uart_pin', 'cs_pin', 'spi_bus', 'en_pin', 'a_pin', 'b_pin', 'click_pin', 'pwm_pin']);

function isPinParam(paramName: string): boolean {
  return PIN_PARAM_NAMES.has(paramName) || paramName.endsWith('_pin');
}

/** Build a map of pin value → list of sections using it (excluding inversion prefix) */
function buildPinUsageMap(configFiles: Record<string, { sections: ConfigSection[] }>) {
  const pinMap = new Map<string, string[]>();
  for (const cf of Object.values(configFiles)) {
    for (const sec of cf.sections) {
      for (const p of sec.params) {
        if (p.is_commented_out) continue;
        if (!isPinParam(p.key)) continue;
        const pinVal = p.value.replace(/^[!^~]*/, '').trim();
        if (!pinVal || pinVal === 'none' || pinVal === '') continue;
        const existing = pinMap.get(pinVal) || [];
        existing.push(sec.full_header);
        pinMap.set(pinVal, existing);
      }
    }
  }
  return pinMap;
}

export default function SettingsPanel() {
  const {
    selectedSection,
    setSelectedSection,
    configFiles,
    activeFile,
    schemas,
    updateSectionParam,
    addParam,
    removeParam,
    toggleParamCommented,
    addSection,
  } = useConfigStore();
  const { selectedNodeId, nodes, addSubComponentNode, addFeatureNode, updateNodeData, selectedEdgeId, edges, updateEdgeData, setSelectedNode } = useGraphStore();

  const [showHidden, setShowHidden] = useState(false);
  const [textViewMode, setTextViewMode] = useState(false);
  const [sectionEditText, setSectionEditText] = useState('');
  const [sectionTextDirty, setSectionTextDirty] = useState(false);
  const [addingType, setAddingType] = useState<'sub' | 'feature' | null>(null);
  const [nodeRenameValue, setNodeRenameValue] = useState('');
  const [mcuNamePrompt, setMcuNamePrompt] = useState<{
    nodeId: string;
    purpose: 'demote';  // old primary needs a name
  } | null>(null);

  // Find the selected node
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodes.find((n) => n.id === selectedNodeId) || null;
  }, [selectedNodeId, nodes]);

  // Find the section to edit – either from selectedSection or from the node's sectionHeader
  const sectionHeader = useMemo(() => {
    if (selectedSection) return selectedSection;
    if (!selectedNode) return null;
    const data = selectedNode.data as Record<string, unknown>;
    return (data?.sectionHeader as string) || null;
  }, [selectedSection, selectedNode]);

  // Resolve the config file this node belongs to
  const nodeConfigFile = useMemo(() => {
    if (!selectedNode) return null;
    const data = selectedNode.data as Record<string, unknown>;
    // Direct configFile on node (sub-components, features, groups)
    if (data?.configFile) return data.configFile as string;
    // Hardware nodes have configFile directly
    if (selectedNode.type === 'hardware') return data?.configFile as string || null;
    // Fallback: find via parentHardwareId
    const parentId = (data?.parentHardwareId || data?.parentId) as string | undefined;
    if (parentId) {
      const parent = nodes.find((n) => n.id === parentId);
      if (parent) return (parent.data as Record<string, unknown>)?.configFile as string || null;
    }
    return null;
  }, [selectedNode, nodes]);

  const section = useMemo(() => {
    if (!sectionHeader) return null;
    // If we know the config file, look there first
    if (nodeConfigFile) {
      const cf = configFiles[nodeConfigFile];
      if (cf) {
        const found = cf.sections.find((s) => s.full_header === sectionHeader);
        if (found) return found;
      }
    }
    // Fallback: search across all config files
    for (const cf of Object.values(configFiles)) {
      const found = cf.sections.find((s) => s.full_header === sectionHeader);
      if (found) return found;
    }
    return null;
  }, [sectionHeader, nodeConfigFile, configFiles]);

  // Pin conflict detection
  const pinUsageMap = useMemo(() => buildPinUsageMap(configFiles), [configFiles]);

  // Get schema for the section
  const schema = useMemo(() => {
    if (!section) return null;
    return schemas[section.section_type] || null;
  }, [section, schemas]);

  // Get validation errors for this section
  const errors = useMemo(() => {
    if (!sectionHeader) return [];
    return useConfigStore.getState().getSectionErrors(sectionHeader);
  }, [sectionHeader]);

  // Active params (not commented out)
  const activeParams = useMemo(
    () => section?.params.filter((p) => !p.is_commented_out) || [],
    [section],
  );

  // Hidden params (commented out or not yet added)
  const hiddenSchemaParams = useMemo(() => {
    if (!schema || !section) return [];
    const activeKeys = new Set(activeParams.map((p) => p.key));
    return schema.params.filter((p) => !activeKeys.has(p.name) && !p.name.includes('*'));
  }, [schema, section, activeParams]);

  // Auto-expand optional params when section has no active params (newly created)
  const effectiveShowHidden = showHidden || (activeParams.length === 0 && hiddenSchemaParams.length > 0);

  /** Resolve the owning config filename for the current section. */
  const resolveFilename = useCallback(() => {
    if (nodeConfigFile) return nodeConfigFile;
    if (!sectionHeader) return activeFile;
    return Object.entries(configFiles).find(([_, cf]) =>
      cf.sections.some((s) => s.full_header === sectionHeader)
    )?.[0] || activeFile;
  }, [nodeConfigFile, sectionHeader, configFiles, activeFile]);

  const handleParamChange = useCallback(
    (key: string, value: string) => {
      if (!sectionHeader) return;
      updateSectionParam(resolveFilename(), sectionHeader, key, value);
    },
    [sectionHeader, resolveFilename, updateSectionParam],
  );

  const handleAddParam = useCallback(
    (paramSchema: ParamSchema) => {
      if (!sectionHeader) return;
      addParam(resolveFilename(), sectionHeader, {
        key: paramSchema.name,
        value: paramSchema.default || '',
        comment: '',
        is_commented_out: false,
      });
    },
    [sectionHeader, resolveFilename, addParam],
  );

  const handleRemoveParam = useCallback(
    (key: string) => {
      if (!sectionHeader) return;
      removeParam(resolveFilename(), sectionHeader, key);
    },
    [sectionHeader, resolveFilename, removeParam],
  );

  // For hardware nodes: show overview with add buttons
  const isHardwareNode = selectedNode?.type === 'hardware';
  const hwData = isHardwareNode ? (selectedNode!.data as unknown as HardwareNodeData) : null;

  // Get child nodes for this hardware node
  const childNodes = useMemo(() => {
    if (!selectedNodeId) return [];
    return nodes.filter((n) => {
      const d = n.data as Record<string, unknown>;
      return d.parentHardwareId === selectedNodeId || d.parentId === selectedNodeId;
    });
  }, [selectedNodeId, nodes]);

  // Get sections belonging to this hardware node's config file
  const hwSections = useMemo(() => {
    if (!hwData) return [];
    const cf = configFiles[hwData.configFile];
    return cf?.sections || [];
  }, [hwData, configFiles]);

  /** Generate a unique section name by appending a number suffix if the name already exists. */
  const makeUniqueName = useCallback((sectionType: string, baseName: string): string => {
    const allHeaders = new Set<string>();
    for (const cf of Object.values(configFiles)) {
      for (const s of cf.sections) {
        allHeaders.add(s.full_header);
      }
    }
    let name = baseName;
    let header = `${sectionType} ${name}`;
    let counter = 2;
    while (allHeaders.has(header)) {
      name = `${baseName}_${counter}`;
      header = `${sectionType} ${name}`;
      counter++;
    }
    return name;
  }, [configFiles]);

  const handleAddSubComponent = useCallback((sectionType: string) => {
    if (!selectedNodeId) return;
    const schemaDef = schemas[sectionType];
    const label = schemaDef?.display_name || sectionType;
    const isNamed = schemaDef?.is_named;
    const sectionName = isNamed ? makeUniqueName(sectionType, `${sectionType}_default`) : '';
    const header = isNamed ? `${sectionType} ${sectionName}` : sectionType;

    const filename = hwData?.configFile || activeFile;
    addSubComponentNode(selectedNodeId, sectionType, label, header, filename);
    addSection(filename, {
      section_type: sectionType,
      section_name: sectionName,
      full_header: header,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  }, [selectedNodeId, schemas, addSubComponentNode, addSection, hwData, activeFile]);

  const handleAddFeature = useCallback((sectionType: string) => {
    if (!selectedNodeId) return;

    // Feature uniqueness: prevent duplicates for non-gcode_macro features
    if (sectionType !== 'gcode_macro') {
      const existing = nodes.find((n) => {
        const d = n.data as Record<string, unknown>;
        return n.type === 'feature' && d.sectionType === sectionType;
      });
      if (existing) {
        return; // Already exists
      }
    }

    const schemaDef = schemas[sectionType];
    const label = schemaDef?.display_name || sectionType;
    const isNamed = schemaDef?.is_named;
    const sectionName = isNamed ? makeUniqueName(sectionType, `${sectionType}_default`) : '';
    const header = isNamed ? `${sectionType} ${sectionName}` : sectionType;

    const filename = hwData?.configFile || activeFile;
    addFeatureNode(selectedNodeId, sectionType, label, header, filename);
    addSection(filename, {
      section_type: sectionType,
      section_name: sectionName,
      full_header: header,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  }, [selectedNodeId, schemas, nodes, addFeatureNode, addSection, hwData, activeFile, configFiles]);

  /**
   * Apply MCU name change to a hardware node:
   * - Renames the [mcu] / [mcu name] section
   * - Updates pin prefixes on all sections in that node's config file
   * - Updates node data (mcuName)
   */
  const applyMcuNameChange = useCallback((
    nodeId: string,
    oldMcuName: string,
    newMcuName: string,
  ) => {
    const nd = nodes.find((n) => n.id === nodeId);
    if (!nd) return;
    const nData = nd.data as Record<string, unknown>;
    const cfName = nData.configFile as string;
    if (!cfName) return;
    const configState = useConfigStore.getState();
    const cf = configState.configFiles[cfName];
    if (!cf) return;
    const allSchemas = configState.schemas;

    // Rename MCU section header: [mcu oldName] → [mcu newName] (or [mcu] ↔ [mcu name])
    const oldMcuHeader = oldMcuName ? `mcu ${oldMcuName}` : 'mcu';
    const newMcuHeader = newMcuName ? `mcu ${newMcuName}` : 'mcu';
    const updatedSections = cf.sections.map((sec) => {
      if (sec.full_header === oldMcuHeader) {
        return {
          ...sec,
          section_name: newMcuName,
          full_header: newMcuHeader,
        };
      }
      return sec;
    });

    // Update pin prefixes on non-MCU sections
    const finalSections = updateAllSectionPins(updatedSections, oldMcuName, newMcuName, allSchemas);
    configState.setConfigFile(cfName, { ...cf, sections: finalSections });

    // Update node data
    updateNodeData(nodeId, { mcuName: newMcuName } as Partial<AppNode['data']>);

    // Also update configFile on child nodes that reference the old MCU prefix
    // (their pin values are already updated in the config store)
  }, [nodes, updateNodeData]);

  // Toggle primary MCU - handles pin prefix updates and MCU section renaming
  const handleTogglePrimary = useCallback(() => {
    if (!selectedNodeId) return;
    const currentIsPrimary = (hwData as Record<string, unknown>)?.isPrimary as boolean;

    if (!currentIsPrimary) {
      // PROMOTING this node to primary
      // 1. Find the old primary and demote it
      const oldPrimary = nodes.find(
        (n) => n.type === 'hardware' && n.id !== selectedNodeId &&
          !!(n.data as Record<string, unknown>).isPrimary,
      );

      if (oldPrimary) {
        const oldData = oldPrimary.data as Record<string, unknown>;
        const oldMcuName = (oldData.mcuName as string) || '';

        if (!oldMcuName) {
          // Old primary has no MCU name — need to prompt for one before proceeding
          // Store this node's ID so we can complete the swap after the dialog
          updateNodeData(selectedNodeId, { isPrimary: true } as Partial<AppNode['data']>);
          updateNodeData(oldPrimary.id, { isPrimary: false } as Partial<AppNode['data']>);
          setMcuNamePrompt({ nodeId: oldPrimary.id, purpose: 'demote' });

          // Promote the new primary: strip its MCU prefix
          const newMcuName = (hwData as Record<string, unknown>)?.mcuName as string || '';
          if (newMcuName) {
            applyMcuNameChange(selectedNodeId, newMcuName, '');
          }
          return;
        }

        // Old primary already has a name — just demote it
        updateNodeData(oldPrimary.id, { isPrimary: false } as Partial<AppNode['data']>);
      }

      // Promote the new primary: strip MCU prefix, rename [mcu name] → [mcu]
      const newMcuName = (hwData as Record<string, unknown>)?.mcuName as string || '';
      if (newMcuName) {
        applyMcuNameChange(selectedNodeId, newMcuName, '');
      }
      updateNodeData(selectedNodeId, { isPrimary: true } as Partial<AppNode['data']>);
    } else {
      // DEMOTING this node from primary — need an MCU name
      setMcuNamePrompt({ nodeId: selectedNodeId, purpose: 'demote' });
      updateNodeData(selectedNodeId, { isPrimary: false } as Partial<AppNode['data']>);
    }
  }, [selectedNodeId, hwData, nodes, updateNodeData, applyMcuNameChange]);

  // Handle MCU name dialog confirmation
  const handleMcuNameConfirm = useCallback((mcuName: string) => {
    if (!mcuNamePrompt) return;
    applyMcuNameChange(mcuNamePrompt.nodeId, '', mcuName);

    // Also update the label to show the MCU name
    const nd = nodes.find((n) => n.id === mcuNamePrompt.nodeId);
    if (nd) {
      updateNodeData(mcuNamePrompt.nodeId, { label: mcuName } as Partial<AppNode['data']>);
    }

    setMcuNamePrompt(null);
  }, [mcuNamePrompt, applyMcuNameChange, nodes, updateNodeData]);

  // Handle MCU name dialog cancel — revert the primary toggle
  const handleMcuNameCancel = useCallback(() => {
    if (!mcuNamePrompt) return;
    if (mcuNamePrompt.purpose === 'demote') {
      // Revert: re-promote if it was a swap, or re-promote if simple demote
      updateNodeData(mcuNamePrompt.nodeId, { isPrimary: true } as Partial<AppNode['data']>);
      // If there was a newly promoted node, demote it back
      const currentPrimary = nodes.find(
        (n) => n.type === 'hardware' && n.id !== mcuNamePrompt.nodeId &&
          !!(n.data as Record<string, unknown>).isPrimary,
      );
      if (currentPrimary) {
        // Revert its MCU prefix strip
        const itsOldMcuName = (currentPrimary.data as Record<string, unknown>).mcuName as string || '';
        // If it was just promoted and had its name stripped, it's now '' — we can't easily revert
        // For now, just toggle the flags back
        updateNodeData(currentPrimary.id, { isPrimary: false } as Partial<AppNode['data']>);
      }
    }
    setMcuNamePrompt(null);
  }, [mcuNamePrompt, nodes, updateNodeData]);

  // Toggle MCU mode for SBC
  const handleToggleMcu = useCallback(() => {
    if (!selectedNodeId) return;
    const currentIsMcu = !!(hwData as Record<string, unknown>)?.isMcu;
    updateNodeData(selectedNodeId, { isMcu: !currentIsMcu } as Partial<AppNode['data']>);
  }, [selectedNodeId, hwData, updateNodeData]);

  // Rename hardware node
  const handleRename = useCallback((newLabel: string) => {
    if (!selectedNodeId) return;
    updateNodeData(selectedNodeId, { label: newLabel } as Partial<AppNode['data']>);
  }, [selectedNodeId, updateNodeData]);

  // Toggle suppress for sub-component / feature nodes
  const isSuppressable = selectedNode?.type === 'subComponent' || selectedNode?.type === 'feature';
  const nodeIsSuppressed = isSuppressable && !!(selectedNode?.data as Record<string, unknown>)?.isSuppressed;
  const handleToggleSuppress = useCallback(() => {
    if (!selectedNodeId || !isSuppressable) return;
    updateNodeData(selectedNodeId, { isSuppressed: !nodeIsSuppressed } as Partial<AppNode['data']>);
  }, [selectedNodeId, isSuppressable, nodeIsSuppressed, updateNodeData]);

  // Apply section text edits back to config
  const handleApplySectionText = useCallback(async () => {
    try {
      const result = await import('../services/api').then((m) => m.parseConfigText(sectionEditText, activeFile));
      const parsedSection = result.config.sections.find((s: ConfigSection) => s.full_header === sectionHeader);
      if (parsedSection) {
        const filename = Object.entries(configFiles).find(([_, cf]) =>
          cf.sections.some((s) => s.full_header === sectionHeader)
        )?.[0] || activeFile;
        for (const p of parsedSection.params) {
          updateSectionParam(filename, sectionHeader!, p.key, p.value);
        }
      }
      setSectionTextDirty(false);
    } catch (err) {
      console.error('Parse error:', err);
    }
  }, [sectionEditText, activeFile, sectionHeader, configFiles, updateSectionParam]);

  // MCU name dialog overlay (rendered above all other content)
  const mcuNameDialog = mcuNamePrompt ? (
    <McuNameDialog
      title="Name this MCU"
      message="This board is no longer primary. Give it an MCU name for section headers (e.g., [mcu EBBCan]) and pin prefixes (e.g., EBBCan:gpio13)."
      onConfirm={handleMcuNameConfirm}
      onCancel={handleMcuNameCancel}
    />
  ) : null;

  // ── Early returns (all hooks are above this line) ──────────────────

  // Edge selected — show comm type selector if it's a communication edge
  if (selectedEdgeId && !selectedNodeId) {
    const edge = edges.find((e) => e.id === selectedEdgeId);
    const edgeData = edge?.data as Record<string, unknown> | undefined;
    if (edge && edgeData?.edgeType === 'communication') {
      const commType = (edgeData.commType as string) || 'usb';
      return (
        <div className="w-72 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col">
          <div className="p-3 border-b border-[var(--color-bg-tertiary)]">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Communication Link</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Select connection type</p>
          </div>
          <div className="p-3 space-y-2">
            {(['usb', 'canbus', 'uart'] as const).map((type) => {
              const COLORS = { usb: 'var(--color-usb)', canbus: 'var(--color-canbus)', uart: 'var(--color-uart)' };
              const LABELS = { usb: 'USB', canbus: 'CAN Bus', uart: 'UART' };
              const DESCS = { usb: 'Universal Serial Bus', canbus: 'Controller Area Network', uart: 'Universal Async Receiver-Transmitter' };
              return (
                <button
                  key={type}
                  onClick={() => updateEdgeData(selectedEdgeId, { commType: type } as Partial<AppEdge['data']>)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
                    commType === type
                      ? 'border-transparent text-[var(--color-bg-primary)]'
                      : 'border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:border-[var(--color-accent)]'
                  }`}
                  style={commType === type ? { backgroundColor: COLORS[type] } : {}}
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: COLORS[type] }} />
                  <div className="text-left">
                    <div className="text-xs font-semibold">{LABELS[type]}</div>
                    <div className="text-[10px] opacity-70">{DESCS[type]}</div>
                  </div>
                  {commType === type && <span className="ml-auto text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    // Config edge selected — nothing meaningful to show
    return mcuNameDialog;
  }

  if (isHardwareNode && !sectionHeader) {
    return (
      <>
        {mcuNameDialog}
        <HardwareOverviewPanel
        hwData={hwData!}
        nodeId={selectedNodeId!}
        childNodes={childNodes}
        hwSections={hwSections}
        schemas={schemas}
        addingType={addingType}
        setAddingType={setAddingType}
        onAddSubComponent={handleAddSubComponent}
        onAddFeature={handleAddFeature}
        onSelectSection={(header: string) => setSelectedSection(header)}
        onTogglePrimary={handleTogglePrimary}
        onToggleMcu={handleToggleMcu}
        onRename={handleRename}
        allNodes={nodes}
      />
      </>
    );
  }

  if (!section) {
    // GroupNode selected — show its children for editing
    if (selectedNode?.type === 'group') {
      const groupData = selectedNode.data as Record<string, unknown>;
      const children = (groupData.children as Array<{ label: string; sectionHeader: string; params?: Array<{ key: string; value: string }> }>) || [];
      const groupLabel = groupData.label as string;
      const parentId = groupData.parentHardwareId as string | undefined;
      const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;
      return (
        <>{mcuNameDialog}
        <div className="w-80 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
          {parentNode && (
            <button
              onClick={() => { setSelectedNode(parentId!); setSelectedSection(null); }}
              className="flex items-center gap-1 px-3 py-2 text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-colors border-b border-[var(--color-bg-tertiary)] shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to {(parentNode.data as Record<string, unknown>).label as string}
            </button>
          )}
          <div className="p-3 border-b border-[var(--color-bg-tertiary)] shrink-0">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{groupLabel}</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{children.length} items</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {children.map((child, idx) => (
              <button
                key={`${child.sectionHeader}__${idx}`}
                onClick={() => setSelectedSection(child.sectionHeader)}
                className="flex items-center justify-between w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors group"
              >
                <span className="text-[var(--color-text-primary)] font-mono truncate">{child.label}</span>
                <span className="text-[10px] text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-100 shrink-0 ml-2">Edit →</span>
              </button>
            ))}
          </div>
        </div>
        </>
      );
    }
    return (
      <>{mcuNameDialog}
      <div className="w-80 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Select a component to edit its settings.
        </p>
      </div>
      </>
    );
  }

  // Sync edit text when entering text view (no hook call — just state write in effect would be better,
  // but we keep it simple: update on the fly before render)
  if (textViewMode) {
    const textContent = sectionToText(section);
    if (!sectionTextDirty && sectionEditText !== textContent) {
      setSectionEditText(textContent);
    }

    return (
      <>{mcuNameDialog}
      <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">[{section.full_header}]</h2>
          <div className="flex items-center gap-2">
            {sectionTextDirty && (
              <button
                onClick={handleApplySectionText}
                className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors"
              >
                Apply
              </button>
            )}
            <button
              onClick={() => { setTextViewMode(false); setSectionTextDirty(false); }}
              className="text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-accent)] transition-colors"
            >
              Form View
            </button>
          </div>
        </div>
        <textarea
          value={sectionEditText}
          onChange={(e) => { setSectionEditText(e.target.value); setSectionTextDirty(true); }}
          spellCheck={false}
          className="flex-1 overflow-auto p-3 text-xs font-mono text-[var(--color-text-primary)] bg-[var(--color-bg-primary)] resize-none focus:outline-none"
          style={{ tabSize: 4 }}
        />
      </div>
      </>
    );
  }

  return (
    <>{mcuNameDialog}
    <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
      {/* Back button — return to hardware overview or group list */}
      {sectionHeader && (isHardwareNode || selectedNode?.type === 'group') && (
        <button
          onClick={() => setSelectedSection(null)}
          className="flex items-center gap-1 px-3 py-2 text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-colors border-b border-[var(--color-bg-tertiary)] shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to {selectedNode?.type === 'group'
            ? (selectedNode.data as Record<string, unknown>).label as string
            : hwData?.label || 'hardware'}
        </button>
      )}
      {/* Header */}
      <div className="flex items-start justify-between p-3 border-b border-[var(--color-bg-tertiary)] shrink-0">
        <div className="flex-1 min-w-0 mr-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            [{section.full_header}]
          </h2>
          {schema && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {schema.display_name}
            </p>
          )}
          {/* Rename for sub-component / feature nodes */}
          {isSuppressable && (
            <div className="flex items-center gap-1 mt-1.5">
              <input
                value={nodeRenameValue || (selectedNode?.data as Record<string, unknown>)?.label as string || ''}
                onChange={(e) => setNodeRenameValue(e.target.value)}
                onFocus={(e) => { if (!nodeRenameValue) setNodeRenameValue(e.target.value); }}
                onBlur={() => {
                  const trimmed = nodeRenameValue.trim();
                  if (trimmed && selectedNodeId) {
                    updateNodeData(selectedNodeId, { label: trimmed } as Partial<AppNode['data']>);
                  }
                  setNodeRenameValue('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setNodeRenameValue(''); (e.target as HTMLInputElement).blur(); }
                }}
                placeholder="Display name"
                className="text-xs px-2 py-1 rounded bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)] w-full"
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isSuppressable && (
            <button
              onClick={handleToggleSuppress}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                nodeIsSuppressed
                  ? 'bg-[var(--color-warning)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-warning)] hover:text-[var(--color-bg-primary)]'
              }`}
              title={nodeIsSuppressed ? 'Enable this section' : 'Comment out / suppress this section'}
            >
              {nodeIsSuppressed ? 'Suppressed' : 'Suppress'}
            </button>
          )}
          <button
            onClick={() => setTextViewMode(true)}
            className="text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-accent)] transition-colors"
          >
            Text View
          </button>
        </div>
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="px-3 py-2 bg-[#f8717122] border-b border-[var(--color-error)]">
          {errors.map((err, i) => (
            <p key={i} className="text-xs text-[var(--color-error)]">
              ⚠ {err}
            </p>
          ))}
        </div>
      )}

      {/* Active Parameters */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeParams.map((param) => {
          const paramSchema = schema?.params.find((p) => p.name === param.key);
          // Pin conflict check
          let pinConflict: string | null = null;
          if (isPinParam(param.key) && !param.is_commented_out && param.value) {
            const pinVal = param.value.replace(/^[!^~]*/, '').trim();
            const users = pinUsageMap.get(pinVal);
            if (users && users.length > 1) {
              const others = users.filter((h) => h !== sectionHeader);
              if (others.length > 0) {
                pinConflict = `Pin "${pinVal}" also used by: ${others.join(', ')}`;
              }
            }
          }
          return (
            <ParamField
              key={param.key}
              param={param}
              schema={paramSchema}
              pinConflict={pinConflict}
              onChange={(value) => handleParamChange(param.key, value)}
              onRemove={() => handleRemoveParam(param.key)}
            />
          );
        })}

        {/* Add hidden parameters */}
        {hiddenSchemaParams.length > 0 && (
          <div className="border-t border-[var(--color-bg-tertiary)] pt-3 mt-3">
            <button
              onClick={() => setShowHidden(!showHidden)}
              className="flex items-center gap-1 text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                className={`transition-transform ${effectiveShowHidden ? 'rotate-90' : ''}`}
              >
                <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {hiddenSchemaParams.length} optional parameters
            </button>

            {effectiveShowHidden && (
              <div className="mt-2 space-y-1">
                {hiddenSchemaParams.map((ps) => (
                  <button
                    key={ps.name}
                    onClick={() => handleAddParam(ps)}
                    className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors group"
                  >
                    <span className="text-[var(--color-accent)] opacity-0 group-hover:opacity-100">+</span>
                    <span className="text-[var(--color-text-secondary)]">{ps.name}</span>
                    {ps.required && (
                      <span className="text-[var(--color-error)] text-[10px]">required</span>
                    )}
                    {ps.description && (
                      <span className="text-[10px] text-[var(--color-text-secondary)] opacity-50 truncate ml-auto">
                        {ps.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/* ── Individual Parameter Field ──────────────────────── */

function ParamField({
  param,
  schema,
  pinConflict,
  onChange,
  onRemove,
}: {
  param: ConfigParam;
  schema?: ParamSchema;
  pinConflict?: string | null;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const isRequired = schema?.required ?? false;
  const hasError = (isRequired && !param.value.trim()) || !!pinConflict;

  return (
    <div className="group">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-[var(--color-text-secondary)] flex items-center gap-1">
          {param.key}
          {isRequired && <span className="text-[var(--color-error)]">*</span>}
          {schema?.unit && (
            <span className="text-[10px] opacity-50">({schema.unit})</span>
          )}
        </label>
        {!isRequired && (
          <button
            onClick={onRemove}
            className="opacity-0 group-hover:opacity-100 text-[10px] text-[var(--color-error)] hover:text-red-300 transition-opacity"
          >
            ✕
          </button>
        )}
      </div>

      {/* Render appropriate input based on type */}
      {schema?.type === 'enum' && schema.enum_values.length > 0 ? (
        <select
          value={param.value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] ${
            hasError ? 'border-[var(--color-error)]' : 'border-[var(--color-bg-tertiary)]'
          }`}
        >
          <option value="">-- Select --</option>
          {schema.enum_values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : schema?.type === 'bool' ? (
        <select
          value={param.value.toLowerCase()}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : schema?.type === 'multi_line' ? (
        <textarea
          value={param.value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={`w-full px-2 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-y ${
            hasError ? 'border-[var(--color-error)]' : 'border-[var(--color-bg-tertiary)]'
          }`}
        />
      ) : (
        <input
          type="text"
          value={param.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={schema?.default || ''}
          className={`w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] ${
            hasError ? 'border-[var(--color-error)]' : 'border-[var(--color-bg-tertiary)]'
          }`}
        />
      )}

      {/* Description tooltip */}
      {schema?.description && (
        <p className="text-[10px] text-[var(--color-text-secondary)] opacity-50 mt-0.5">
          {schema.description}
          {schema.default && ` (default: ${schema.default})`}
        </p>
      )}

      {/* Pin conflict warning */}
      {pinConflict && (
        <p className="text-[10px] text-[var(--color-warning)] mt-0.5">
          ⚠ {pinConflict}
        </p>
      )}
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────── */

function sectionToText(section: { full_header: string; params: ConfigParam[] }): string {
  let text = `[${section.full_header}]\n`;
  for (const param of section.params) {
    const prefix = param.is_commented_out ? '#' : '';
    if (param.value.includes('\n')) {
      text += `${prefix}${param.key}:\n`;
      for (const line of param.value.split('\n')) {
        text += `${prefix}    ${line}\n`;
      }
    } else {
      text += `${prefix}${param.key}: ${param.value}`;
      if (param.comment) text += `   # ${param.comment}`;
      text += '\n';
    }
  }
  return text;
}

/* ── Hardware Overview Panel ─────────────────────────── */

const SUB_COMPONENT_QUICK: Array<{ group: string; label: string; types: string[] }> = [
  { group: 'stepper', label: 'Steppers', types: ['stepper_x', 'stepper_y', 'stepper_z', 'extruder'] },
  { group: 'stepper_driver', label: 'Stepper Drivers', types: ['tmc2209', 'tmc2208', 'tmc5160', 'tmc2240', 'tmc2130'] },
  { group: 'heater', label: 'Heaters', types: ['heater_bed', 'heater_generic'] },
  { group: 'fan', label: 'Fans', types: ['fan', 'heater_fan', 'controller_fan', 'temperature_fan', 'fan_generic'] },
  { group: 'temperature', label: 'Sensors', types: ['temperature_sensor'] },
  { group: 'probe', label: 'Probes', types: ['probe', 'bltouch', 'probe_eddy_current'] },
  { group: 'led', label: 'LEDs', types: ['neopixel', 'dotstar', 'led'] },
  { group: 'filament_sensor', label: 'Filament', types: ['filament_switch_sensor', 'filament_motion_sensor'] },
  { group: 'pin', label: 'Pins', types: ['output_pin', 'servo', 'pwm_tool'] },
  { group: 'mcu', label: 'MCU', types: ['mcu'] },
];

const FEATURE_QUICK: Array<{ group: string; label: string; types: string[] }> = [
  { group: 'bed_leveling', label: 'Bed Leveling', types: ['bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust'] },
  { group: 'homing', label: 'Homing', types: ['safe_z_home', 'homing_override'] },
  { group: 'resonance', label: 'Resonance', types: ['input_shaper', 'resonance_tester'] },
  { group: 'gcode', label: 'G-Code', types: ['virtual_sdcard', 'pause_resume', 'firmware_retraction', 'gcode_macro', 'idle_timeout', 'exclude_object'] },
];

import type { SectionSchema } from '../types/config';

// Component group display names for the sidebar
const SIDEBAR_GROUP_NAMES: Record<string, string> = {
  stepper: 'Steppers',
  stepper_driver: 'Stepper Drivers',
  extruder: 'Extruders',
  heater: 'Heaters',
  fan: 'Fans',
  temperature: 'Temperature Sensors',
  probe: 'Probes',
  led: 'LEDs',
  display: 'Displays',
  servo: 'Servos',
  pin: 'Output Pins',
  filament_sensor: 'Filament Sensors',
  accelerometer: 'Accelerometers',
  gcode_macro: 'G-Code Macros',
  bed_leveling: 'Bed Leveling',
  homing: 'Homing',
  resonance: 'Resonance',
  printer: 'Printer',
  mcu: 'MCU',
  other: 'Other',
};

function ChildNodesList({ childNodes, onSelectSection }: { childNodes: AppNode[]; onSelectSection: (header: string) => void }) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Group child nodes by componentGroup
  const groups = useMemo(() => {
    const map = new Map<string, AppNode[]>();
    for (const n of childNodes) {
      const d = n.data as Record<string, unknown>;
      const group = (d.componentGroup as string) || (n.type === 'group' ? (d.componentGroup as string) || 'other' : 'other');
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(n);
    }
    return map;
  }, [childNodes]);

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  return (
    <div>
      <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
        Attached Components ({childNodes.length})
      </h3>
      <div className="space-y-1">
        {Array.from(groups.entries()).map(([group, nodes]) => {
          if (nodes.length === 1) {
            // Single node — show directly (no foldout wrapper)
            const n = nodes[0];
            const d = n.data as Record<string, unknown>;
            return (
              <button
                key={n.id}
                onClick={() => {
                  if (d.sectionHeader) onSelectSection(d.sectionHeader as string);
                }}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" />
                <span className="text-[var(--color-text-primary)]">{d.label as string}</span>
                <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">{n.type}</span>
              </button>
            );
          }

          // Multiple nodes in same group — foldable section
          const isExpanded = !!expandedGroups[group];
          const groupLabel = SIDEBAR_GROUP_NAMES[group] || group;
          return (
            <div key={group}>
              <button
                onClick={() => toggleGroup(group)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                <svg
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  className={`transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                >
                  <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <span className="text-[var(--color-text-primary)] font-medium">{groupLabel}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ml-auto">
                  {nodes.length}
                </span>
              </button>
              {isExpanded && (
                <div className="ml-4 space-y-0.5 mt-0.5">
                  {nodes.map((n) => {
                    const d = n.data as Record<string, unknown>;
                    // For group nodes, show each child item within
                    if (n.type === 'group' && Array.isArray(d.children)) {
                      return (d.children as Array<{ label: string; sectionHeader: string }>).map((child, ci) => (
                        <button
                          key={`${n.id}_${ci}`}
                          onClick={() => onSelectSection(child.sectionHeader)}
                          className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] opacity-60" />
                          <span className="text-[var(--color-text-primary)] truncate">{child.label}</span>
                        </button>
                      ));
                    }
                    return (
                      <button
                        key={n.id}
                        onClick={() => {
                          if (d.sectionHeader) onSelectSection(d.sectionHeader as string);
                        }}
                        className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] opacity-60" />
                        <span className="text-[var(--color-text-primary)] truncate">{d.label as string}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HardwareOverviewPanel({
  hwData,
  nodeId,
  childNodes,
  hwSections,
  schemas,
  addingType,
  setAddingType,
  onAddSubComponent,
  onAddFeature,
  onSelectSection,
  onTogglePrimary,
  onToggleMcu,
  onRename,
  allNodes,
}: {
  hwData: HardwareNodeData;
  nodeId: string;
  childNodes: AppNode[];
  hwSections: ConfigSection[];
  schemas: Record<string, SectionSchema>;
  addingType: 'sub' | 'feature' | null;
  setAddingType: (t: 'sub' | 'feature' | null) => void;
  onAddSubComponent: (type: string) => void;
  onAddFeature: (type: string) => void;
  onSelectSection: (header: string) => void;
  onTogglePrimary: () => void;
  onToggleMcu: () => void;
  onRename: (newLabel: string) => void;
  allNodes: AppNode[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(hwData.label);

  const isSbc = hwData.hardwareType === 'sbc';
  const isMcu = !!(hwData as Record<string, unknown>).isMcu;
  // SBC without MCU mode can only receive comm lines — no sub-components
  const canAddSubComponents = !isSbc || isMcu;

  const color = {
    sbc: 'var(--color-sbc)',
    mainboard: 'var(--color-mainboard)',
    toolhead: 'var(--color-toolhead)',
    expander: 'var(--color-expander)',
    probe: 'var(--color-probe)',
    accelerometer: 'var(--color-accelerometer)',
    other: 'var(--color-other)',
  }[hwData.hardwareType] || 'var(--color-other)';

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue.trim() !== hwData.label) {
      onRename(renameValue.trim());
    }
    setRenaming(false);
  };

  return (
    <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-[var(--color-bg-tertiary)] shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
          {renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenaming(false); }}
              className="flex-1 text-sm font-semibold bg-[var(--color-bg-primary)] border border-[var(--color-accent)] rounded px-1 text-[var(--color-text-primary)] focus:outline-none"
            />
          ) : (
            <h2
              className="text-sm font-semibold text-[var(--color-text-primary)] cursor-pointer hover:text-[var(--color-accent)] group flex items-center gap-1"
              onClick={() => { setRenaming(true); setRenameValue(hwData.label); }}
              title="Click to rename"
            >
              {hwData.label}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-0 group-hover:opacity-60">
                <path d="M7 1l2 2-6 6H1V7l6-6z" stroke="currentColor" strokeWidth="1" />
              </svg>
            </h2>
          )}
          {(hwData as Record<string, unknown>).isPrimary === true && (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-bg-primary)] shrink-0">
              Primary
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1">
          {hwData.hardwareType.toUpperCase()} &middot; {hwData.configFile}
        </p>
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            onClick={onTogglePrimary}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              (hwData as Record<string, unknown>).isPrimary
                ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] text-[var(--color-text-secondary)]'
            }`}
          >
            {(hwData as Record<string, unknown>).isPrimary ? '★ Primary (printer.cfg)' : 'Set as Primary'}
          </button>
          {isSbc && (
            <button
              onClick={onToggleMcu}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                isMcu
                  ? 'bg-[var(--color-sbc)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-sbc)] hover:text-[var(--color-bg-primary)] text-[var(--color-text-secondary)]'
              }`}
              title={isMcu ? 'Disable MCU — SBC acts as comms hub only' : 'Enable MCU — allows GPIO sub-components on this SBC'}
            >
              {isMcu ? '● MCU Enabled' : '○ Enable MCU'}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Child sections list */}
        {hwSections.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
              Config Sections ({hwSections.length})
            </h3>
            <div className="space-y-1">
              {hwSections.map((sec, idx) => (
                <button
                  key={`${sec.full_header}__${idx}`}
                  onClick={() => onSelectSection(sec.full_header)}
                  className="flex items-center justify-between w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors group"
                >
                  <span className="text-[var(--color-text-primary)] font-mono">[{sec.full_header}]</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-100">
                    Edit &rarr;
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Child nodes list — grouped by componentGroup with foldable sections */}
        {childNodes.length > 0 && (
          <ChildNodesList childNodes={childNodes} onSelectSection={onSelectSection} />
        )}

        {/* Add buttons */}
        <div className="space-y-2">
          {!canAddSubComponents && (
            <div className="text-xs text-[var(--color-text-secondary)] px-2 py-2 bg-[var(--color-bg-primary)] rounded-lg">
              Enable MCU mode to add GPIO sub-components to this SBC.
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => canAddSubComponents && setAddingType(addingType === 'sub' ? null : 'sub')}
              disabled={!canAddSubComponents}
              className={`flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                !canAddSubComponents
                  ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] opacity-40 cursor-not-allowed'
                  : addingType === 'sub'
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Sub-Component
            </button>
            <button
              onClick={() => setAddingType(addingType === 'feature' ? null : 'feature')}
              className={`flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                addingType === 'feature'
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Feature
            </button>
          </div>

          {/* Sub-Component picker */}
          {addingType === 'sub' && (
            <div className="border border-[var(--color-bg-tertiary)] rounded-lg p-3 space-y-3">
              {SUB_COMPONENT_QUICK.map((group) => (
                <div key={group.group}>
                  <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                    {group.label}
                  </h4>
                  <div className="flex flex-wrap gap-1">
                    {group.types.map((t) => (
                      <button
                        key={t}
                        onClick={() => onAddSubComponent(t)}
                        className="px-2 py-1 rounded text-[10px] border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all"
                      >
                        {schemas[t]?.display_name || t}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Feature picker */}
          {addingType === 'feature' && (
            <div className="border border-[var(--color-bg-tertiary)] rounded-lg p-3 space-y-3">
              {FEATURE_QUICK.map((group) => (
                <div key={group.group}>
                  <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                    {group.label}
                  </h4>
                  <div className="flex flex-wrap gap-1">
                    {group.types.map((t) => {
                      const alreadyAdded = t !== 'gcode_macro' && allNodes.some((n) => {
                        const d = n.data as Record<string, unknown>;
                        return n.type === 'feature' && d.sectionType === t;
                      });
                      return (
                        <button
                          key={t}
                          onClick={() => onAddFeature(t)}
                          disabled={alreadyAdded}
                          className={`px-2 py-1 rounded text-[10px] border transition-all ${
                            alreadyAdded
                              ? 'border-[var(--color-bg-tertiary)] opacity-40 cursor-not-allowed line-through'
                              : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)]'
                          }`}
                        >
                          {schemas[t]?.display_name || t}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
