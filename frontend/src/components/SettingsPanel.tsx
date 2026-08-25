import { useState, useCallback, useMemo, useEffect } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import { useNativeStore } from '../stores/nativeStore';
import type { ParamSchema, ConfigParam, ConfigSection, HardwareType, SectionSchema } from '../types/config';
import type { HardwareNodeData, SubComponentNodeData, FeatureNodeData, GroupChildItem, AppNode, AppEdge, ValidationStatus } from '../types/graph';
import { applyBoardTypeMarkerToMcuSections } from '../utils/boardTypeMarker';
import { buildUniqueSectionDraft } from '../utils/sectionNaming';
import { getValidationStatusColor } from '../utils/validationStatus';
import { resolveSection } from '../utils/sectionResolver';
import { hasFeatureSectionType as hasFeatureSectionTypeInFiles } from '../utils/featureSections';
import { toggleSectionSuppressed } from '../utils/sectionSuppress';
import { applyMcuRenameToFiles, planPrimarySwap, applyNodeUpdates, applyGroupChildRenames, mcuHeaderFor } from '../utils/mcuPrimary';
import { ackKindForSection } from '../utils/warningAcknowledgment';
import { acknowledgeWarning, acknowledgeDuplicateWarning } from '../services/api';
import WarningBadge from './nodes/WarningBadge';
import McuNameDialog from './dialogs/McuNameDialog';

// Pin param names that should be unique
const PIN_PARAM_NAMES = new Set(['pin', 'sensor_pin', 'heater_pin', 'step_pin', 'dir_pin', 'enable_pin', 'endstop_pin', 'uart_pin', 'tx_pin', 'cs_pin', 'en_pin', 'a_pin', 'b_pin', 'click_pin', 'pwm_pin']);

type PinUse = {
  section: string;
  sectionType: string;
  param: string;
  label: string;
};

function isPinParam(paramName: string): boolean {
  return PIN_PARAM_NAMES.has(paramName) || paramName.endsWith('_pin');
}

function basename(filename: string): string {
  return filename.replace(/^.*[\\/]/, '');
}

/** Build a map of pin value → list of sections using it (excluding inversion prefix) */
function buildPinUsageMap(configFiles: Record<string, { sections: ConfigSection[] }>) {
  const pinMap = new Map<string, PinUse[]>();
  for (const cf of Object.values(configFiles)) {
    for (const sec of cf.sections) {
      for (const p of sec.params) {
        if (p.is_commented_out) continue;
        if (!isPinParam(p.key)) continue;
        const pinVal = p.value.replace(/^[!^~]*/, '').trim();
        if (!pinVal || pinVal === 'none' || pinVal === '') continue;
        const existing = pinMap.get(pinVal) || [];
        existing.push({
          section: sec.full_header,
          sectionType: sec.section_type,
          param: p.key,
          label: `[${sec.full_header}] ${p.key}`,
        });
        pinMap.set(pinVal, existing);
      }
    }
  }
  return pinMap;
}

function isAllowedSharedPin(users: PinUse[]): boolean {
  if (users.length === 0) return false;

  const sharedTmcParams = new Set(['uart_pin', 'tx_pin']);
  if (users.every((user) => (user.sectionType === 'tmc2208' || user.sectionType === 'tmc2209') && sharedTmcParams.has(user.param))) {
    return true;
  }

  if (users.every((user) => user.param === 'enable_pin' && (
    user.sectionType.startsWith('stepper_')
    || user.sectionType.startsWith('extruder')
    || user.sectionType === 'manual_stepper'
  ))) {
    return true;
  }

  const sharedCommunicationParams = new Set([
    'spi_software_sclk_pin',
    'spi_software_mosi_pin',
    'spi_software_miso_pin',
    'i2c_software_scl_pin',
    'i2c_software_sda_pin',
  ]);
  if (sharedCommunicationParams.has(users[0].param) && users.every((user) => user.param === users[0].param)) {
    return true;
  }

  const sharedDisplayParams = new Set(['up_pin', 'down_pin', 'click_pin', 'back_pin', 'kill_pin']);
  if (users.every((user) => user.sectionType === 'display' && user.section === users[0].section && sharedDisplayParams.has(user.param))) {
    return true;
  }

  return false;
}

export default function SettingsPanel() {
  const {
    selectedSection,
    selectedSectionFile,
    selectedSectionLine,
    setSelectedSection,
    configFiles,
    activeFile,
    schemas,
    validation,
    updateConfigFile,
    updateSectionParam,
    addParam,
    removeParam,
    toggleParamCommented,
    addSection,
    revalidateFile,
  } = useConfigStore();
  const { selectedNodeId, nodes, addSubComponentNode, addFeatureNode, updateNodeData, selectedEdgeId, edges, updateEdgeData, setSelectedNode, setSelectedEdge } = useGraphStore();

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

  const nodeSectionLineNumber = useMemo(() => {
    if (!selectedNode) return null;
    const data = selectedNode.data as Record<string, unknown>;
    return typeof data?.sectionLineNumber === 'number' ? data.sectionLineNumber as number : null;
  }, [selectedNode]);

  // Prefer the line carried with the section selection (sidebar rows carry
  // the exact (file, line) of the section they open); fall back to the
  // selected node's line for direct node clicks.
  const effectiveSectionLineNumber = selectedSectionLine ?? nodeSectionLineNumber;

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

  const resolvedSectionInfo = useMemo(() => {
    if (!sectionHeader) return null;
    return resolveSection(configFiles, sectionHeader, selectedSectionFile, selectedSectionLine);
  }, [sectionHeader, selectedSectionFile, selectedSectionLine, configFiles]);

  const section = resolvedSectionInfo?.section || null;
  const sectionConfigFile = resolvedSectionInfo?.filename || null;

  useEffect(() => {
    if (!textViewMode || !section || sectionTextDirty) return;
    setSectionEditText(sectionToText(section));
  }, [textViewMode, section, sectionTextDirty]);

  const includeParents = useMemo(() => {
    if (!sectionConfigFile) return [] as string[];
    const targetBasename = basename(sectionConfigFile);
    return Object.entries(configFiles)
      .filter(([filename, cf]) => (
        filename !== sectionConfigFile
        && cf.includes.some((includePath) => basename(includePath) === targetBasename)
      ))
      .map(([filename]) => filename);
  }, [sectionConfigFile, configFiles]);

  const sourceFileNote = useMemo(() => {
    if (!sectionConfigFile) return null;
    if (includeParents.length === 0) return `Defined in ${sectionConfigFile}`;
    if (includeParents.length === 1) {
      return `Defined in ${sectionConfigFile} via [include ${basename(sectionConfigFile)}] from ${includeParents[0]}`;
    }
    return `Defined in ${sectionConfigFile} via [include ${basename(sectionConfigFile)}] from ${includeParents.join(', ')}`;
  }, [sectionConfigFile, includeParents]);

  // Pin conflict detection
  const pinUsageMap = useMemo(() => buildPinUsageMap(configFiles), [configFiles]);

  // Get schema for the section
  const schema = useMemo(() => {
    if (!section) return null;
    return schemas[section.section_type] || null;
  }, [section, schemas]);

  // Get validation issues for this section
  const sectionIssues = useMemo(() => {
    if (!sectionHeader) return [] as Array<{ severity: 'error' | 'warning'; message: string }>;
    const issues: Array<{ severity: 'error' | 'warning'; message: string }> = [];
    const validationFiles = sectionConfigFile
      ? [sectionConfigFile]
      : nodeConfigFile
        ? [nodeConfigFile]
        : Object.keys(validation);
    for (const filename of validationFiles) {
      const result = validation[filename];
      if (!result) continue;
      for (const issue of result.errors) {
        if (issue.section !== sectionHeader) continue;
        if (issue.severity === 'error' || issue.severity === 'warning') {
          issues.push({ severity: issue.severity, message: issue.message });
        }
      }
    }
    return issues;
  }, [nodeConfigFile, sectionConfigFile, sectionHeader, validation]);

  const sectionAckKind = useMemo(
    () => ackKindForSection(sectionIssues),
    [sectionIssues],
  );

  const hasAcknowledgeableWarning = sectionAckKind !== null;

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
    if (sectionConfigFile) return sectionConfigFile;
    if (nodeConfigFile) return nodeConfigFile;
    if (!sectionHeader) return activeFile;
    return Object.entries(configFiles).find(([_, cf]) =>
      cf.sections.some((s) => s.full_header === sectionHeader)
    )?.[0] || activeFile;
  }, [sectionConfigFile, nodeConfigFile, sectionHeader, configFiles, activeFile]);

  const handleParamChange = useCallback(
    (key: string, value: string) => {
      if (!sectionHeader) return;
      updateSectionParam(resolveFilename(), sectionHeader, key, value, effectiveSectionLineNumber ?? undefined);
    },
    [sectionHeader, resolveFilename, updateSectionParam, effectiveSectionLineNumber],
  );

  const handleParamCommit = useCallback(() => {
    const filename = resolveFilename();
    void revalidateFile(filename);
  }, [resolveFilename, revalidateFile]);

  const handleAddParam = useCallback(
    (paramSchema: ParamSchema) => {
      if (!sectionHeader) return;
      addParam(resolveFilename(), sectionHeader, {
        key: paramSchema.name,
        value: paramSchema.default || '',
        comment: '',
        is_commented_out: false,
      }, effectiveSectionLineNumber ?? undefined);
    },
    [sectionHeader, resolveFilename, addParam, effectiveSectionLineNumber],
  );

  const handleRemoveParam = useCallback(
    (key: string) => {
      if (!sectionHeader) return;
      removeParam(resolveFilename(), sectionHeader, key, effectiveSectionLineNumber ?? undefined);
    },
    [sectionHeader, resolveFilename, removeParam, effectiveSectionLineNumber],
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

  const targetConfigSections = useMemo(() => {
    const filename = hwData?.configFile || sectionConfigFile || nodeConfigFile || activeFile;
    return configFiles[filename]?.sections || [];
  }, [hwData?.configFile, sectionConfigFile, nodeConfigFile, activeFile, configFiles]);

  const hasFeatureSectionType = useCallback((sectionType: string) => (
    hasFeatureSectionTypeInFiles(configFiles, sectionType)
  ), [configFiles]);

  const handleAddSubComponent = useCallback((sectionType: string) => {
    if (!selectedNodeId) return;
    const schemaDef = schemas[sectionType];
    const displayName = schemaDef?.display_name || sectionType;

    const filename = hwData?.configFile || activeFile;
    const existingSections = configFiles[filename]?.sections || targetConfigSections;
    const draft = buildUniqueSectionDraft(sectionType, displayName, schemaDef, existingSections);
    addSubComponentNode(selectedNodeId, draft.sectionType, draft.label, draft.fullHeader, filename);
    addSection(filename, {
      section_type: draft.sectionType,
      section_name: draft.sectionName,
      full_header: draft.fullHeader,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  }, [selectedNodeId, schemas, addSubComponentNode, addSection, hwData, activeFile, configFiles, targetConfigSections]);

  const handleAddFeature = useCallback((sectionType: string) => {
    if (!selectedNodeId) return;

    // Feature uniqueness: prevent duplicates for non-gcode_macro features
    if (hasFeatureSectionType(sectionType)) {
      return; // Already exists
    }

    const schemaDef = schemas[sectionType];
    const displayName = schemaDef?.display_name || sectionType;

    const filename = hwData?.configFile || activeFile;
    const existingSections = configFiles[filename]?.sections || targetConfigSections;
    const draft = buildUniqueSectionDraft(sectionType, displayName, schemaDef, existingSections);
    addFeatureNode(selectedNodeId, draft.sectionType, draft.label, draft.fullHeader, filename);
    addSection(filename, {
      section_type: draft.sectionType,
      section_name: draft.sectionName,
      full_header: draft.fullHeader,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  }, [selectedNodeId, schemas, addFeatureNode, addSection, hwData, activeFile, configFiles, targetConfigSections, hasFeatureSectionType]);

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

    // Update pins in any other config files referenced by child nodes
    const childConfigFiles = new Set<string>();
    for (const child of nodes) {
      if (child.parentId !== nodeId) continue;
      const childData = child.data as Record<string, unknown>;
      const childCf = childData.configFile as string;
      if (childCf && childCf !== cfName) childConfigFiles.add(childCf);
      if (child.type === 'group' && Array.isArray(childData.children)) {
        for (const gc of childData.children as Array<{ configFile?: string }>) {
          if (gc.configFile && gc.configFile !== cfName) childConfigFiles.add(gc.configFile);
        }
      }
    }

    // Rename MCU section + rewrite pin prefixes across affected files (pure)
    const updatedFiles = applyMcuRenameToFiles(
      configState.configFiles,
      cfName,
      [...childConfigFiles],
      oldMcuName,
      newMcuName,
      allSchemas,
    );
    for (const filename of Object.keys(updatedFiles)) {
      if (updatedFiles[filename] === configState.configFiles[filename]) continue;
      configState.updateConfigFile(filename, updatedFiles[filename]);
      void configState.revalidateFile(filename);
    }

    // Update node data
    updateNodeData(nodeId, { mcuName: newMcuName } as Partial<AppNode['data']>);

    // The MCU section header changed ([mcu old] → [mcu new]); any child
    // sub-component/feature node whose sectionHeader matches the old header
    // must be repointed or clicking it resolves null and the sidebar blanks.
    const oldMcuHeader = mcuHeaderFor(oldMcuName);
    const newMcuHeader = mcuHeaderFor(newMcuName);
    for (const child of nodes) {
      if (child.parentId !== nodeId) continue;
      const childData = child.data as Record<string, unknown>;
      if (childData.sectionHeader === oldMcuHeader) {
        updateNodeData(child.id, {
          sectionHeader: newMcuHeader,
          label: newMcuName
            ? `${(useConfigStore.getState().schemas?.['mcu']?.display_name) || 'MCU'}: ${newMcuName}`
            : (useConfigStore.getState().schemas?.['mcu']?.display_name) || 'MCU',
        } as Partial<AppNode['data']>);
      }
    }

    // Sync group node children's params with updated config store data
    const freshConfigs = useConfigStore.getState().configFiles;
    for (const child of nodes) {
      if (child.parentId !== nodeId || child.type !== 'group') continue;
      const gData = child.data as Record<string, unknown>;
      const gChildren = gData.children as Array<{ sectionHeader: string; configFile?: string; [key: string]: unknown }>;
      if (!Array.isArray(gChildren)) continue;
      const updatedChildren = gChildren.map((gc) => {
        const gcFile = (gc.configFile as string) || cfName;
        const gcConfig = freshConfigs[gcFile];
        // A group child that was the MCU section keeps its own header too.
        const gcHeader = gc.sectionHeader === oldMcuHeader ? newMcuHeader : gc.sectionHeader;
        const matchedSection = gcConfig?.sections.find((s: { full_header: string }) => s.full_header === gcHeader);
        if (!matchedSection) return gc;
        return {
          ...gc,
          sectionHeader: gcHeader,
          params: matchedSection.params.filter((p: { is_commented_out?: boolean }) => !p.is_commented_out),
        };
      });
      updateNodeData(child.id, { children: updatedChildren } as Partial<AppNode['data']>);
    }
  }, [nodes, updateNodeData]);

  // Toggle primary MCU - handles pin prefix updates, MCU section renaming, and config file renaming
  const handleTogglePrimary = useCallback(() => {
    if (!selectedNodeId) return;
    useGraphStore.getState().pushHistory();
    const currentIsPrimary = (hwData as Record<string, unknown>)?.isPrimary as boolean;
    const { renameConfigFile } = useConfigStore.getState();

    // Helper to swap config files via the pure plan: old primary's
    // printer.cfg → {mcuName}.cfg, new primary's file → printer.cfg, and
    // repoint every affected hardware + child node.
    const swapConfigFiles = (oldPrimaryNodeId: string | null, oldMcuName: string, newPrimaryNodeId: string, newConfigFile: string) => {
      const plan = planPrimarySwap({
        oldPrimaryId: oldPrimaryNodeId,
        oldMcuName,
        newPrimaryId: newPrimaryNodeId,
        newConfigFile,
        nodes,
      });
      for (const r of plan.renames) renameConfigFile(r.from, r.to);
      applyNodeUpdates(plan, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
      applyGroupChildRenames(plan, nodes, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
    };

    if (!currentIsPrimary) {
      // PROMOTING this node to primary
      const newNodeData = hwData as Record<string, unknown>;
      const newConfigFile = (newNodeData?.configFile as string) || '';

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
          updateNodeData(selectedNodeId, { isPrimary: true } as Partial<AppNode['data']>);
          updateNodeData(oldPrimary.id, { isPrimary: false } as Partial<AppNode['data']>);
          setMcuNamePrompt({ nodeId: oldPrimary.id, purpose: 'demote' });

          // Promote the new primary: strip its MCU prefix
          const newMcuName = (newNodeData?.mcuName as string) || '';
          if (newMcuName) {
            applyMcuNameChange(selectedNodeId, newMcuName, '');
          }
          // File rename will happen when MCU name is confirmed
          return;
        }

        // Old primary already has a name — demote it and swap files
        updateNodeData(oldPrimary.id, { isPrimary: false } as Partial<AppNode['data']>);
        swapConfigFiles(oldPrimary.id, oldMcuName, selectedNodeId, newConfigFile);
      } else if (newConfigFile && newConfigFile !== 'printer.cfg') {
        // No old primary — just rename new primary's file to printer.cfg
        const plan = planPrimarySwap({
          oldPrimaryId: null,
          oldMcuName: '',
          newPrimaryId: selectedNodeId,
          newConfigFile,
          nodes,
        });
        for (const r of plan.renames) renameConfigFile(r.from, r.to);
        applyNodeUpdates(plan, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
        applyGroupChildRenames(plan, nodes, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
      }

      // Promote the new primary: strip MCU prefix, rename [mcu name] → [mcu]
      const newMcuName = (newNodeData?.mcuName as string) || '';
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

    // Handle file rename when demoting: printer.cfg → {mcuName}.cfg
    if (mcuNamePrompt.purpose === 'demote') {
      const { renameConfigFile } = useConfigStore.getState();

      // Now rename the new primary's file to printer.cfg
      const newPrimary = nodes.find(
        (n) => n.type === 'hardware' && n.id !== mcuNamePrompt.nodeId &&
          !!(n.data as Record<string, unknown>).isPrimary,
      );

      // Demote the old primary (printer.cfg → {name}.cfg) and promote the new
      // primary ({file} → printer.cfg) in one pure plan. renameConfigFile
      // no-ops when the source file doesn't exist, so the stale-state guard
      // from the old inline code is unnecessary.
      const plan = planPrimarySwap({
        oldPrimaryId: mcuNamePrompt.nodeId,
        oldMcuName: mcuName,
        newPrimaryId: newPrimary?.id ?? '',
        newConfigFile: newPrimary
          ? ((newPrimary.data as Record<string, unknown>).configFile as string) || ''
          : '',
        nodes,
      });
      for (const r of plan.renames) renameConfigFile(r.from, r.to);
      applyNodeUpdates(plan, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
      applyGroupChildRenames(plan, nodes, (nodeId, data) => updateNodeData(nodeId, data as Partial<AppNode['data']>));
    }

    setMcuNamePrompt(null);
  }, [mcuNamePrompt, applyMcuNameChange, nodes, updateNodeData]);

  // Handle MCU name dialog cancel — revert the primary toggle losslessly.
  // handleTogglePrimary pushed history before any mutation, so undo() restores
  // isPrimary flags, mcuName, file names, and pin prefixes in one step.
  const handleMcuNameCancel = useCallback(() => {
    if (!mcuNamePrompt) return;
    useGraphStore.getState().undo();
    setMcuNamePrompt(null);
  }, [mcuNamePrompt]);

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

  // Toggle suppress for sub-component / feature nodes (standalone or inside a group)
  const isSuppressable = selectedNode?.type === 'subComponent' || selectedNode?.type === 'feature' ||
    (selectedNode?.type === 'group' && !!selectedSection);
  const nodeIsSuppressed = useMemo(() => {
    if (!isSuppressable) return false;
    if (selectedNode?.type === 'subComponent' || selectedNode?.type === 'feature') {
      return !!(selectedNode.data as Record<string, unknown>)?.isSuppressed;
    }
    // Group child: find the child matching selectedSection
    if (selectedNode?.type === 'group' && selectedSection) {
      const children = (selectedNode.data as Record<string, unknown>)?.children as Array<{ sectionHeader: string; isSuppressed?: boolean }> | undefined;
      const child = children?.find((c) => c.sectionHeader === selectedSection);
      return !!child?.isSuppressed;
    }
    return false;
  }, [isSuppressable, selectedNode, selectedSection]);
  const handleToggleSuppress = useCallback(() => {
    if (!selectedNodeId || !isSuppressable) return;
    useGraphStore.getState().pushHistory();
    const newSuppressed = !nodeIsSuppressed;

    if (selectedNode?.type === 'subComponent' || selectedNode?.type === 'feature') {
      updateNodeData(selectedNodeId, { isSuppressed: newSuppressed } as Partial<AppNode['data']>);

      // Sync config store: comment/uncomment all params in the section
      const d = selectedNode.data as Record<string, unknown>;
      const cfName = d.configFile as string | undefined;
      const secHeader = d.sectionHeader as string | undefined;
      if (cfName && secHeader) {
        const cs = useConfigStore.getState();
        const cf = cs.configFiles[cfName];
        if (cf) {
          cs.updateConfigFile(cfName, {
            ...cf,
            sections: cf.sections.map((s) => {
              if (s.full_header !== secHeader) return s;
              return toggleSectionSuppressed(s, newSuppressed);
            }),
          });
          void cs.revalidateFile(cfName);
        }
      }
    } else if (selectedNode?.type === 'group' && selectedSection) {
      // Update the matching child inside the group's children array
      const children = [...((selectedNode.data as Record<string, unknown>)?.children as Array<Record<string, unknown>> || [])];
      const idx = children.findIndex((c) => c.sectionHeader === selectedSection);
      if (idx !== -1) {
        children[idx] = { ...children[idx], isSuppressed: newSuppressed };
        updateNodeData(selectedNodeId, { children } as Partial<AppNode['data']>);

        // Sync config store: comment/uncomment all params in the group child's section
        const childData = children[idx];
        const cfName = (childData.configFile as string) || (selectedNode.data as Record<string, unknown>).configFile as string;
        const secHeader = childData.sectionHeader as string;
        if (cfName && secHeader) {
          const cs = useConfigStore.getState();
          const cf = cs.configFiles[cfName];
          if (cf) {
            cs.updateConfigFile(cfName, {
              ...cf,
              sections: cf.sections.map((s) => {
                if (s.full_header !== secHeader) return s;
                return toggleSectionSuppressed(s, newSuppressed);
              }),
            });
            void cs.revalidateFile(cfName);
          }
        }
      }
    }
  }, [selectedNodeId, isSuppressable, selectedNode, selectedSection, nodeIsSuppressed, updateNodeData]);

  // Apply section text edits back to config
  const handleApplySectionText = useCallback(async () => {
    if (!sectionHeader) return;
    useGraphStore.getState().pushHistory();
    try {
      const filename = sectionConfigFile || Object.entries(configFiles).find(([_, cf]) =>
        cf.sections.some((s) => s.full_header === sectionHeader && (effectiveSectionLineNumber == null || effectiveSectionLineNumber === 0 || s.line_number === effectiveSectionLineNumber))
      )?.[0] || activeFile;
      const currentConfig = configFiles[filename];
      if (!currentConfig) return;

      const result = await import('../services/api').then((m) => m.parseConfigText(sectionEditText, filename));
      const parsedSection = result.config.sections.find((s: ConfigSection) => s.full_header === sectionHeader) || result.config.sections[0];
      if (!parsedSection) return;

      const targetIndex = currentConfig.sections.findIndex((s) =>
        s.full_header === sectionHeader
        && (effectiveSectionLineNumber == null || effectiveSectionLineNumber === 0 || s.line_number === effectiveSectionLineNumber),
      );
      if (targetIndex === -1) return;

      const currentSection = currentConfig.sections[targetIndex];
      const nextSection: ConfigSection = {
        ...parsedSection,
        line_number: currentSection.line_number,
      };
      const nextConfig = {
        ...currentConfig,
        sections: currentConfig.sections.map((candidate, index) => index === targetIndex ? nextSection : candidate),
      };

      updateConfigFile(filename, nextConfig);
      void revalidateFile(filename);

      if (selectedNodeId && selectedNode && selectedNode.type !== 'hardware' && selectedNode.type !== 'group') {
        const displayName = schemas[nextSection.section_type]?.display_name || nextSection.section_type;
        const label = nextSection.section_name ? `${displayName}: ${nextSection.section_name}` : displayName;
        updateNodeData(selectedNodeId, {
          sectionHeader: nextSection.full_header,
          sectionLineNumber: nextSection.line_number,
          sectionType: nextSection.section_type,
          label,
        } as Partial<AppNode['data']>);
      } else if (selectedNodeId && selectedNode?.type === 'group' && selectedSection) {
        const displayName = schemas[nextSection.section_type]?.display_name || nextSection.section_type;
        const label = nextSection.section_name ? `${displayName}: ${nextSection.section_name}` : displayName;
        const sectionParams = nextSection.params.filter((param) => param.key !== '_comment_');
        const realParams = sectionParams.filter((param) => !param.is_commented_out);
        const nextSuppressed = sectionParams.length > 0 && sectionParams.every((param) => param.is_commented_out);
        const groupChildren = ((selectedNode.data as Record<string, unknown>).children as GroupChildItem[] | undefined) || [];
        let updatedChild = false;

        const nextChildren = groupChildren.map((child) => {
          if (updatedChild || child.sectionHeader !== selectedSection) {
            return child;
          }

          updatedChild = true;
          return {
            ...child,
            label,
            sectionType: nextSection.section_type,
            sectionHeader: nextSection.full_header,
            sectionLineNumber: nextSection.line_number,
            params: realParams,
            isSuppressed: nextSuppressed,
          };
        });

        if (updatedChild) {
          updateNodeData(selectedNodeId, { children: nextChildren } as Partial<AppNode['data']>);
        }
      }

      setSelectedSection(nextSection.full_header, filename ?? null, nextSection.line_number ?? null);
      setSectionEditText(sectionToText(nextSection));
      setSectionTextDirty(false);
      void revalidateFile(filename);
    } catch (err) {
      console.error('Parse error:', err);
    }
  }, [sectionEditText, activeFile, sectionHeader, sectionConfigFile, configFiles, effectiveSectionLineNumber, updateConfigFile, selectedNodeId, selectedNode, selectedSection, schemas, updateNodeData, setSelectedSection, revalidateFile]);

  const handleAcknowledgeWarning = useCallback(async () => {
    if (!section || !sectionConfigFile) return;
    if (sectionAckKind === 'duplicate') {
      await acknowledgeDuplicateWarning(section);
    } else {
      await acknowledgeWarning(section);
    }
    // Duplicates (and cross-file warnings generally) live on other files too,
    // so revalidate the whole project — not just this file.
    void revalidateFile(sectionConfigFile);
  }, [section, sectionConfigFile, sectionAckKind, revalidateFile]);

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
      // Find the target hardware node's MCU section for editing. Comm edges
      // connect SBC ↔ hardware and can be drawn in either direction, so the
      // MCU to edit is ALWAYS the non-SBC endpoint (the SBC's host_mcu isn't
      // the one carrying serial/canbus config for the peripheral).
      const srcNode = nodes.find((n) => n.id === edge.source);
      const srcData = srcNode?.data as Record<string, unknown> | undefined;
      const tgtNode = nodes.find((n) => n.id === edge.target);
      const tgtData = tgtNode?.data as Record<string, unknown> | undefined;
      const srcIsSbc = srcData?.hardwareType === 'sbc';
      const tgtIsSbc = tgtData?.hardwareType === 'sbc';
      const targetNode = srcIsSbc && !tgtIsSbc ? tgtNode : srcNode;
      const targetData = targetNode?.data as Record<string, unknown> | undefined;
      const targetConfigFile = targetData?.configFile as string | undefined;
      const targetMcuName = (targetData?.mcuName as string) ?? '';
      const targetConfig = targetConfigFile ? configFiles[targetConfigFile] : undefined;
      const mcuSection = targetConfig?.sections.find(
        (s) => s.section_type === 'mcu' && s.section_name === targetMcuName,
      );
      const mcuSchema = schemas['mcu'] || null;
      return (
        <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
          <div className="p-3 border-b border-[var(--color-bg-tertiary)]">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Communication Link</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {targetData?.label ? `${targetData.label as string} · ` : ''}Select connection type
            </p>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="p-3 space-y-2">
              {(['usb', 'canbus', 'uart'] as const).map((type) => {
                const COLORS = { usb: 'var(--color-usb)', canbus: 'var(--color-canbus)', uart: 'var(--color-uart)' };
                const LABELS = { usb: 'USB', canbus: 'CAN Bus', uart: 'UART' };
                const DESCS = { usb: 'Universal Serial Bus', canbus: 'Controller Area Network', uart: 'Universal Async Receiver-Transmitter' };
                // Params that should be active for each comm type
                const SERIAL_PARAMS = ['serial', 'baud'];
                const CANBUS_PARAMS = ['canbus_uuid', 'canbus_interface'];
                return (
                  <button
                    key={type}
                    onClick={() => {
                      useGraphStore.getState().pushHistory();
                      updateEdgeData(selectedEdgeId, { commType: type } as Partial<AppEdge['data']>);
                      // Toggle MCU params: comment/uncomment based on selected comm type.
                      // USB and UART share the serial field — the edge label and
                      // detect field are the only visible difference between them.
                      // Serial params are only touched when the selected type
                      // actually differs (CAN ⇄ serial-family): switching to CAN
                      // comments serials; switching back restores ONE serial only
                      // if none is active — never uncomment a second serial, which
                      // would silently swap which device is in use.
                      if (mcuSection && targetConfigFile) {
                        const wantSerial = type === 'usb' || type === 'uart';
                        const wantCanbus = type === 'canbus';
                        const serialParams = mcuSection.params.filter((p) => SERIAL_PARAMS.includes(p.key) && p.key !== '_comment_');
                        const activeSerialCount = serialParams.filter((p) => !p.is_commented_out).length;
                        for (const param of mcuSection.params) {
                          if (param.key === '_comment_') continue;
                          if (CANBUS_PARAMS.includes(param.key)) {
                            // Ensure canbus params exist and are uncommented for CAN
                            if (wantCanbus && param.is_commented_out) {
                              toggleParamCommented(targetConfigFile, mcuSection.full_header, param.key);
                            } else if (!wantCanbus && !param.is_commented_out) {
                              toggleParamCommented(targetConfigFile, mcuSection.full_header, param.key);
                            }
                          } else if (SERIAL_PARAMS.includes(param.key)) {
                            // CAN: comment every serial/baud param.
                            if (wantCanbus && !param.is_commented_out) {
                              toggleParamCommented(targetConfigFile, mcuSection.full_header, param.key);
                            } else if (wantSerial && activeSerialCount === 0 && param.is_commented_out) {
                              // Back from CAN with no active serial: restore the
                              // first commented one only. If a serial is already
                              // active, leave everything untouched.
                              toggleParamCommented(targetConfigFile, mcuSection.full_header, param.key);
                            }
                          }
                        }
                        // Add missing params for the selected comm type
                        const existingKeys = new Set(mcuSection.params.map((p) => p.key));
                        if (wantSerial) {
                          if (!existingKeys.has('serial')) {
                            addParam(targetConfigFile, mcuSection.full_header, {
                              key: 'serial', value: '', is_commented_out: false, comment: '',
                            });
                          }
                        }
                        if (wantCanbus) {
                          if (!existingKeys.has('canbus_uuid')) {
                            addParam(targetConfigFile, mcuSection.full_header, {
                              key: 'canbus_uuid', value: '', is_commented_out: false, comment: '',
                            });
                          }
                          if (!existingKeys.has('canbus_interface')) {
                            addParam(targetConfigFile, mcuSection.full_header, {
                              key: 'canbus_interface', value: 'can0', is_commented_out: false, comment: '',
                            });
                          }
                        }
                      }
                    }}
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
            {/* MCU section params */}
            {mcuSection && targetConfigFile && (
              <div className="border-t border-[var(--color-bg-tertiary)] p-3 space-y-3">
                <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  MCU Settings — [{mcuSection.full_header}]
                </h3>
                {mcuSection.params.filter((p) => !p.is_commented_out).map((param) => {
                  const paramSchema = mcuSchema?.params.find((p) => p.name === param.key);
                  return (
                    <ParamField
                      key={`${param.key}_${mcuSection.full_header}`}
                      param={param}
                      schema={paramSchema}
                      isMcuParam
                      commType={commType}
                      onChange={(value) => updateSectionParam(targetConfigFile, mcuSection.full_header, param.key, value)}
                      onCommit={() => { void revalidateFile(targetConfigFile); }}
                      onRemove={() => removeParam(targetConfigFile, mcuSection.full_header, param.key)}
                    />
                  );
                })}
                {mcuSection.params.filter((p) => !p.is_commented_out).length === 0 && (
                  <p className="text-xs text-[var(--color-text-secondary)] italic">No active MCU parameters</p>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }
    // Config (trace) edge selected — show the include relation + delete
    const configEdge = edges.find((e) => e.id === selectedEdgeId);
    const configEdgeData = configEdge?.data as Record<string, unknown> | undefined;
    if (configEdge && configEdgeData?.edgeType === 'configuration') {
      const srcNode = nodes.find((n) => n.id === configEdge.source);
      const tgtNode = nodes.find((n) => n.id === configEdge.target);
      const srcFile = (srcNode?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
      const tgtFile = (tgtNode?.data as Record<string, unknown> | undefined)?.configFile as string | undefined;
      // Include direction: the primary file includes the non-primary one
      const srcIsPrimary = !!(srcNode?.data as Record<string, unknown> | undefined)?.isPrimary || srcFile === 'printer.cfg';
      const tgtIsPrimary = !!(tgtNode?.data as Record<string, unknown> | undefined)?.isPrimary || tgtFile === 'printer.cfg';
      const includingFile = srcIsPrimary && !tgtIsPrimary ? srcFile : tgtFile;
      const includedFile = srcIsPrimary && !tgtIsPrimary ? tgtFile : srcFile;
      return (
        <>{mcuNameDialog}
        <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
          <div className="p-3 border-b border-[var(--color-bg-tertiary)]">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Configuration Link</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Trace connection between hardware nodes
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3 space-y-2">
              <label className="block text-xs">
                <span className="text-[var(--color-text-secondary)]">Source (included file):</span>
                <select
                  className="mt-1 w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
                  value={configEdge.source}
                  onChange={(e) => {
                    const newTarget = e.target.value === configEdge.target ? configEdge.source : configEdge.target;
                    useGraphStore.getState().repointConfigEdge(configEdge.id, e.target.value, newTarget);
                  }}
                >
                  {nodes.filter((n) => n.type === 'hardware').map((n) => (
                    <option key={n.id} value={n.id}>
                      {(n.data as Record<string, unknown>).label as string ?? n.id}
                    </option>
                  ))}
                </select>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">{srcFile || 'unknown file'}</div>
              </label>
              <label className="block text-xs">
                <span className="text-[var(--color-text-secondary)]">Target (including file):</span>
                <select
                  className="mt-1 w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
                  value={configEdge.target}
                  onChange={(e) => {
                    const newSource = e.target.value === configEdge.source ? configEdge.target : configEdge.source;
                    useGraphStore.getState().repointConfigEdge(configEdge.id, newSource, e.target.value);
                  }}
                >
                  {nodes.filter((n) => n.type === 'hardware').map((n) => (
                    <option key={n.id} value={n.id}>
                      {(n.data as Record<string, unknown>).label as string ?? n.id}
                    </option>
                  ))}
                </select>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">{tgtFile || 'unknown file'}</div>
              </label>
              {includingFile && includedFile && includingFile !== includedFile && (
                <div className="pt-2 border-t border-[var(--color-bg-tertiary)] text-xs">
                  <span className="text-[var(--color-text-secondary)]">Include:</span>{' '}
                  <span className="font-mono text-[var(--color-text-primary)]">{includedFile}</span>
                  <span className="text-[var(--color-text-secondary)]"> added to </span>
                  <span className="font-mono text-[var(--color-text-primary)]">{includingFile}</span>
                </div>
              )}
            </div>
            <button
              onClick={() => {
                // removeEdge pushes history itself; include removal is folded
                // into the same undo step since it happens before the next push
                useGraphStore.getState().removeEdge(configEdge.id);
                // Comment out the include in the primary file (direction-agnostic)
                if (srcFile && tgtFile && srcFile !== tgtFile) {
                  const srcIsPrimary2 = !!(srcNode?.data as Record<string, unknown> | undefined)?.isPrimary || srcFile === 'printer.cfg';
                  if (srcIsPrimary2) {
                    useConfigStore.getState().removeInclude(srcFile, tgtFile);
                  } else {
                    useConfigStore.getState().removeInclude(tgtFile, srcFile);
                  }
                }
                setSelectedEdge(null);
              }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors text-xs font-medium"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 6h10M6.5 6V4h3v2M5 6l.5 7h5L11 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Delete link
            </button>
          </div>
        </div>
        </>
      );
    }
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
        schemas={schemas}
        addingType={addingType}
        setAddingType={setAddingType}
        onAddSubComponent={handleAddSubComponent}
        onAddFeature={handleAddFeature}
        onSelectSection={(header: string, cf?: string | null, ln?: number | null) => setSelectedSection(header, cf ?? null, ln ?? null)}
        onSelectNode={(nodeId: string) => { setSelectedNode(nodeId); setSelectedSection(null); }}
        onOpenCommunication={() => {
          if (!selectedNodeId) return;
          const communicationEdge = edges.find((edge) => {
            const edgeData = edge.data as Record<string, unknown> | undefined;
            return edgeData?.edgeType === 'communication' && (edge.source === selectedNodeId || edge.target === selectedNodeId);
          });
          if (communicationEdge) {
            setSelectedSection(null);
            setSelectedNode(null);
            setSelectedEdge(communicationEdge.id);
            return;
          }
          const mcuHeader = hwData?.mcuName ? `mcu ${hwData.mcuName}` : 'mcu';
          setSelectedEdge(null);
          setSelectedSection(mcuHeader, hwData?.configFile ?? null, null);
        }}
        onTogglePrimary={handleTogglePrimary}
        onToggleMcu={handleToggleMcu}
        onRename={handleRename}
        onChangeHardwareType={(newType) => {
          if (!selectedNodeId) return;
          updateNodeData(selectedNodeId, { hardwareType: newType } as Partial<AppNode['data']>);
          if (!hwData?.configFile) return;
          const configState = useConfigStore.getState();
          const configFileData = configState.configFiles[hwData.configFile];
          if (!configFileData) return;
          configState.updateConfigFile(hwData.configFile, {
            ...configFileData,
            sections: applyBoardTypeMarkerToMcuSections(
              configFileData.sections,
              newType,
              hwData.mcuName || '',
            ),
          });
          void configState.revalidateFile(hwData.configFile);
        }}
        allNodes={nodes}
      />
      </>
    );
  }

  if (!section) {
    // GroupNode selected — show its children for editing
    if (selectedNode?.type === 'group') {
      const groupData = selectedNode.data as Record<string, unknown>;
      const children = (groupData.children as Array<{ label: string; sectionHeader: string; configFile?: string; sectionLineNumber?: number; params?: Array<{ key: string; value: string }>; validationStatus?: ValidationStatus }>) || [];
      const groupLabel = groupData.label as string;
      const parentId = groupData.parentHardwareId as string | undefined;
      const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;
      return (
        <>{mcuNameDialog}
        <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] flex flex-col overflow-hidden">
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
                onClick={() => setSelectedSection(child.sectionHeader, child.configFile ?? null, child.sectionLineNumber ?? null)}
                className="flex items-center justify-between w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors group"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: getValidationStatusColor(child.validationStatus || 'valid') }}
                  />
                  <span className="text-[var(--color-text-primary)] font-mono truncate">{child.label}</span>
                </span>
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
      <div className="w-96 border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Select a component to edit its settings.
        </p>
      </div>
      </>
    );
  }

  if (textViewMode) {
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
      <div className="flex flex-col gap-3 p-3 border-b border-[var(--color-bg-tertiary)] shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            [{section.full_header}]
          </h2>
          {schema && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {schema.display_name}
            </p>
          )}
          {sourceFileNote && (
            <p className="text-[11px] text-[var(--color-text-secondary)] mt-1">
              {sourceFileNote}
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
        <div className="flex flex-wrap items-center gap-2">
          {hasAcknowledgeableWarning && (
            <button
              onClick={() => { void handleAcknowledgeWarning(); }}
              className="text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-warning)] hover:text-[var(--color-bg-primary)] transition-colors"
              title={sectionAckKind === 'duplicate'
                ? 'Acknowledge this duplicate section and stop flagging the save button'
                : 'Acknowledge this unknown section and hide its warning in future validations'}
            >
              Acknowledge Warning
            </button>
          )}
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

      {/* Issues */}
      {sectionIssues.length > 0 && (
        <div className="border-b border-[var(--color-bg-tertiary)]">
          {sectionIssues.map((issue, i) => {
            const color = issue.severity === 'error' ? 'var(--color-error)' : 'var(--color-warning)';
            return (
              <div
                key={`${issue.severity}_${i}`}
                className="px-3 py-2"
                style={{
                  backgroundColor: `${color}22`,
                  borderTop: i === 0 ? 'none' : `1px solid ${color}33`,
                }}
              >
                <p className="text-xs" style={{ color }}>
                  ⚠ {issue.message}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Active Parameters */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeParams.map((param, index) => {
          const paramSchema = schema?.params.find((p) => p.name === param.key);
          // Pin conflict check
          let pinConflict: string | null = null;
          if (isPinParam(param.key) && !param.is_commented_out && param.value) {
            const pinVal = param.value.replace(/^[!^~]*/, '').trim();
            const users = pinUsageMap.get(pinVal);
            if (users && users.length > 1) {
              const others = users.filter((user) => user.section !== sectionHeader || user.param !== param.key);
              if (others.length > 0 && !isAllowedSharedPin(users)) {
                pinConflict = `Pin "${pinVal}" also used by: ${others.map((user) => user.label).join(', ')}`;
              }
            }
          }
          return (
            <ParamField
              key={`${param.key}_${index}`}
              param={param}
              schema={paramSchema}
              pinConflict={pinConflict}
              onChange={(value) => handleParamChange(param.key, value)}
              onCommit={handleParamCommit}
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

/* ── Device Picker for MCU params ────────────────────── */

/** Param names that should show a device picker when in native mode */
const DEVICE_PARAM_MAP: Record<string, 'usb_serial' | 'can' | 'uart'> = {
  serial: 'usb_serial',
  canbus_uuid: 'can',
  canbus_interface: 'can',
};

function DevicePicker({
  paramKey,
  currentValue,
  onSelect,
  commType,
}: {
  paramKey: string;
  currentValue: string;
  onSelect: (value: string) => void;
  commType?: string;
}) {
  const { isNative, devices, devicesLoading, refreshDevices, canbusQuery, canbusQueryLoading, queryCanbusUuids } = useNativeStore();

  useEffect(() => {
    if (isNative && !devices && !devicesLoading) {
      refreshDevices();
    }
  }, [isNative, devices, devicesLoading, refreshDevices]);

  if (!isNative || !devices) return null;

  const deviceType = DEVICE_PARAM_MAP[paramKey];
  if (!deviceType) return null;

  // For serial param: show USB or UART devices depending on comm type
  if (paramKey === 'serial') {
    if (commType === 'uart') {
      // Show UART devices when comm type is UART
      if (devices.uart.length === 0) return null;
      return (
        <div className="mt-1">
          <select
            value=""
            onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
            className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          >
            <option value="">Select UART device...</option>
            {devices.uart.map((d) => (
              <option key={d.path} value={d.path}>
                {d.description} ({d.path})
              </option>
            ))}
          </select>
        </div>
      );
    }
    // Default: show USB serial devices
    if (devices.usb_serial.length === 0) return null;
    return (
      <div className="mt-1">
        <select
          value=""
          onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
          className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          <option value="">Select detected device...</option>
          {devices.usb_serial.map((d) => (
            <option key={d.by_id} value={d.by_id}>
              {d.description}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (deviceType === 'can') {
    if (paramKey === 'canbus_interface') {
      if (devices.can.length === 0) return null;
      return (
        <div className="mt-1">
          <select
            value=""
            onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
            className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          >
            <option value="">Select CAN interface...</option>
            {devices.can.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name} ({d.state}{d.bitrate ? `, ${d.bitrate / 1000}kbps` : ''})
              </option>
            ))}
          </select>
        </div>
      );
    }
    // canbus_uuid — show auto-detected UUIDs
    if (paramKey === 'canbus_uuid') {
      return (
        <div className="mt-1 space-y-1">
          <button
            onClick={() => queryCanbusUuids('can0')}
            disabled={canbusQueryLoading}
            className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] transition-colors"
          >
            {canbusQueryLoading ? 'Scanning CAN bus...' : 'Detect CAN bus UUIDs'}
          </button>
          {canbusQuery?.error && (
            <p className="text-[10px] text-[var(--color-error)]">
              ⚠ {canbusQuery.error}
            </p>
          )}
          {canbusQuery && canbusQuery.uuids.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
              className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="">Select detected UUID...</option>
              {canbusQuery.uuids.map((uuid) => (
                <option key={uuid} value={uuid}>
                  {uuid}
                </option>
              ))}
            </select>
          )}
          {canbusQuery && canbusQuery.uuids.length === 0 && !canbusQuery.error && (
            <p className="text-[10px] text-[var(--color-text-secondary)] italic">
              No CAN bus devices found on {canbusQuery.interface}
            </p>
          )}
        </div>
      );
    }
    return null;
  }

  if (deviceType === 'uart') {
    if (devices.uart.length === 0) return null;
    return (
      <div className="mt-1">
        <select
          value=""
          onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
          className="w-full px-2 py-1 rounded text-[10px] bg-[var(--color-bg-tertiary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          <option value="">Select UART device...</option>
          {devices.uart.map((d) => (
            <option key={d.path} value={d.path}>
              {d.description} ({d.path})
            </option>
          ))}
        </select>
      </div>
    );
  }

  return null;
}

/* ── Individual Parameter Field ──────────────────────── */

function ParamField({
  param,
  schema,
  pinConflict,
  onChange,
  onCommit,
  onRemove,
  isMcuParam,
  commType,
}: {
  param: ConfigParam;
  schema?: ParamSchema;
  pinConflict?: string | null;
  onChange: (value: string) => void;
  onCommit?: () => void;
  onRemove: () => void;
  isMcuParam?: boolean;
  commType?: string;
}) {
  const isRequired = schema?.required ?? false;
  const hasError = isRequired && !param.value.trim();
  const hasWarning = !!pinConflict;
  const inputBorderClass = hasError
    ? 'border-[var(--color-error)]'
    : hasWarning
      ? 'border-[var(--color-warning)]'
      : 'border-[var(--color-bg-tertiary)]';

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
          onBlur={onCommit}
          className={`w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] ${inputBorderClass}`}
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
          onBlur={onCommit}
          className="w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : schema?.type === 'multi_line' ? (
        <textarea
          value={param.value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          rows={4}
          className={`w-full px-2 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-y ${inputBorderClass}`}
        />
      ) : (
        <input
          type="text"
          value={param.value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          placeholder={schema?.default || ''}
          className={`w-full px-2 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] ${inputBorderClass}`}
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

      {/* Device picker for MCU serial/CAN/UART params */}
      {isMcuParam && param.key in DEVICE_PARAM_MAP && (
        <DevicePicker paramKey={param.key} currentValue={param.value} onSelect={onChange} commType={commType} />
      )}
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────── */

function sectionToText(section: { full_header: string; params: ConfigParam[] }): string {
  // Detect suppressed sections: all non-comment params are commented out
  const realParams = section.params.filter((p) => p.key !== '_comment_');
  const isSuppressed = realParams.length > 0 && realParams.every((p) => p.is_commented_out);
  let text = isSuppressed ? `#[${section.full_header}]\n` : `[${section.full_header}]\n`;
  for (const param of section.params) {
    // _comment_ pseudo-params are standalone comment lines — emit as-is
    if (param.key === '_comment_') {
      text += param.value + '\n';
      continue;
    }
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

const CARTESIAN_STEPPERS_QUICK = ['stepper_x', 'stepper_y', 'stepper_z', 'extruder'];
const DELTA_STEPPERS_QUICK = ['stepper_a', 'stepper_b', 'stepper_c', 'extruder'];
const DELTA_KINEMATICS_QUICK = new Set(['delta', 'rotary_delta']);

const BASE_SUB_COMPONENT_QUICK: Array<{ group: string; label: string; types: string[] }> = [
  { group: 'stepper', label: 'Steppers', types: CARTESIAN_STEPPERS_QUICK },
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

function ChildNodesList({
  childNodes,
  onSelectSection,
  onSelectNode,
  title,
}: {
  childNodes: AppNode[];
  onSelectSection: (header: string, configFile?: string | null, lineNumber?: number | null) => void;
  onSelectNode: (nodeId: string) => void;
  title?: string;
}) {
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
        {title || 'Attached Components'} ({childNodes.length})
      </h3>
      <div className="space-y-1">
        {Array.from(groups.entries()).map(([group, nodes]) => {
          // "other" group — render items flat with no foldout wrapper
          if (group === 'other') {
            return nodes.map((n) => {
              const d = n.data as Record<string, unknown>;
              const nodeStatus = (d.validationStatus as ValidationStatus | undefined) || 'valid';
              return (
                <button
                  key={n.id}
                  onClick={() => {
                    if (n.type === 'group') { onSelectNode(n.id); return; }
                    if (d.sectionHeader) onSelectSection(d.sectionHeader as string, d.configFile as string | undefined, typeof d.sectionLineNumber === 'number' ? d.sectionLineNumber as number : null);
                  }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getValidationStatusColor(nodeStatus) }} />
                  <span className="text-[var(--color-text-primary)]">{d.label as string}</span>
                </button>
              );
            });
          }

          if (nodes.length === 1) {
            // Single node — show directly (no foldout wrapper)
            const n = nodes[0];
            const d = n.data as Record<string, unknown>;
            const nodeStatus = (d.validationStatus as ValidationStatus | undefined) || 'valid';
            return (
              <button
                key={n.id}
                onClick={() => {
                  if (n.type === 'group') {
                    onSelectNode(n.id);
                    return;
                  }
                  if (d.sectionHeader) onSelectSection(d.sectionHeader as string, d.configFile as string | undefined, typeof d.sectionLineNumber === 'number' ? d.sectionLineNumber as number : null);
                }}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getValidationStatusColor(nodeStatus) }} />
                <span className="text-[var(--color-text-primary)]">{d.label as string}</span>
                <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">{n.type}</span>
              </button>
            );
          }

          // Multiple nodes in same group — foldable section
          const isExpanded = !!expandedGroups[group];
          const groupLabel = SIDEBAR_GROUP_NAMES[group] || group;
          const groupStatus = nodes.some((n) => (n.data as Record<string, unknown>).validationStatus === 'error')
            ? 'error'
            : nodes.some((n) => (n.data as Record<string, unknown>).validationStatus === 'warning')
              ? 'warning'
              : 'valid';
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
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: getValidationStatusColor(groupStatus) }} />
                <span className="text-[var(--color-text-primary)] font-medium">{groupLabel}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ml-auto">
                  {nodes.length}
                </span>
              </button>
              {isExpanded && (
                <div className="ml-4 space-y-0.5 mt-0.5">
                  {nodes.map((n) => {
                    const d = n.data as Record<string, unknown>;
                    const nodeStatus = (d.validationStatus as ValidationStatus | undefined) || 'valid';
                    // For group nodes, show each child item within
                    if (n.type === 'group' && Array.isArray(d.children)) {
                      return (
                        <div key={n.id} className="space-y-0.5">
                          <button
                            onClick={() => onSelectNode(n.id)}
                            className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getValidationStatusColor(nodeStatus) }} />
                            <span className="text-[var(--color-text-primary)] truncate font-medium">{d.label as string}</span>
                            <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">open</span>
                          </button>
                          <div className="ml-3 space-y-0.5">
                            {(d.children as Array<{ label: string; sectionHeader: string; configFile?: string; sectionLineNumber?: number; validationStatus?: ValidationStatus }>).map((child, ci) => (
                              <button
                                key={`${n.id}_${child.configFile || 'cfg'}_${child.sectionHeader}_${ci}`}
                                onClick={() => onSelectSection(child.sectionHeader, child.configFile ?? null, child.sectionLineNumber ?? null)}
                                className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                              >
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getValidationStatusColor(child.validationStatus || 'valid') }} />
                                <span className="text-[var(--color-text-primary)] truncate">{child.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={n.id}
                        onClick={() => {
                          if (d.sectionHeader) onSelectSection(d.sectionHeader as string, d.configFile as string | undefined, typeof d.sectionLineNumber === 'number' ? d.sectionLineNumber as number : null);
                        }}
                        className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-[var(--color-bg-primary)] transition-colors"
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getValidationStatusColor(nodeStatus) }} />
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
  schemas,
  addingType,
  setAddingType,
  onAddSubComponent,
  onAddFeature,
  onSelectSection,
  onSelectNode,
  onOpenCommunication,
  onTogglePrimary,
  onToggleMcu,
  onRename,
  onChangeHardwareType,
  allNodes,
}: {
  hwData: HardwareNodeData;
  nodeId: string;
  childNodes: AppNode[];
  schemas: Record<string, SectionSchema>;
  addingType: 'sub' | 'feature' | null;
  setAddingType: (t: 'sub' | 'feature' | null) => void;
  onAddSubComponent: (type: string) => void;
  onAddFeature: (type: string) => void;
  onSelectSection: (header: string) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenCommunication: () => void;
  onTogglePrimary: () => void;
  onToggleMcu: () => void;
  onRename: (newLabel: string) => void;
  onChangeHardwareType: (newType: HardwareType) => void;
  allNodes: AppNode[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(hwData.label);
  const validationStatus = (hwData.validationStatus || 'valid') as ValidationStatus;

  const { configFiles: allConfigFiles } = useConfigStore();

  // Derive kinematics from this node's config file
  const kinematics = (() => {
    const cf = allConfigFiles[hwData.configFile];
    if (cf) {
      const printerSection = cf.sections.find((s) => s.section_type === 'printer');
      if (printerSection) {
        const kinParam = printerSection.params.find((p) => p.key === 'kinematics' && !p.is_commented_out);
        if (kinParam) return kinParam.value.trim().toLowerCase();
      }
    }
    return 'cartesian';
  })();

  const subComponentQuick = BASE_SUB_COMPONENT_QUICK.map((g) =>
    g.group === 'stepper'
      ? { ...g, types: DELTA_KINEMATICS_QUICK.has(kinematics) ? DELTA_STEPPERS_QUICK : CARTESIAN_STEPPERS_QUICK }
      : g,
  );

  const isSbc = hwData.hardwareType === 'sbc';
  const isMcu = !!(hwData as Record<string, unknown>).isMcu;
  // SBC without MCU mode can only receive comm lines — no sub-components
  const canAddSubComponents = !isSbc || isMcu;

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
          <WarningBadge status={validationStatus} size={10} />
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
        <p className="text-xs text-[var(--color-text-secondary)] mt-1 flex items-center gap-1">
          <select
            value={hwData.hardwareType}
            onChange={(e) => onChangeHardwareType(e.target.value as HardwareType)}
            className="text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] rounded px-1 py-0.5 text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)] uppercase cursor-pointer"
            title="Change board type"
          >
            <option value="mainboard">MAINBOARD</option>
            <option value="toolhead">TOOLHEAD</option>
            <option value="expander">EXPANDER</option>
            <option value="config_file">CONFIG FILE</option>
            <option value="sbc">SBC</option>
            <option value="probe">PROBE</option>
            <option value="accelerometer">ACCELEROMETER</option>
            <option value="other">OTHER</option>
          </select>
          &middot; {hwData.configFile}
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
          <button
            onClick={onOpenCommunication}
            className="text-xs px-3 py-1 rounded transition-colors bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] text-[var(--color-text-secondary)]"
            title="View and edit MCU communication settings"
          >
            Communications
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
        {/* Attached Components — sub-components and non-feature groups, excluding "other" group */}
        {childNodes.filter((n) => {
          const d = n.data as Record<string, unknown>;
          const group = (d.componentGroup as string) || 'other';
          if (group === 'other') return false;
          return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
        }).length > 0 && (
          <ChildNodesList
            childNodes={childNodes.filter((n) => {
              const d = n.data as Record<string, unknown>;
              const group = (d.componentGroup as string) || 'other';
              if (group === 'other') return false;
              return n.type === 'subComponent' || (n.type === 'group' && !d.isFeature);
            })}
            onSelectSection={onSelectSection}
            onSelectNode={onSelectNode}
            title="Attached Components"
          />
        )}

        {/* Features list — features, feature groups, and anything in "other" group */}
        {childNodes.filter((n) => {
          const d = n.data as Record<string, unknown>;
          const group = (d.componentGroup as string) || 'other';
          if (group === 'other') return true;
          return n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
        }).length > 0 && (
          <ChildNodesList
            childNodes={childNodes.filter((n) => {
              const d = n.data as Record<string, unknown>;
              const group = (d.componentGroup as string) || 'other';
              if (group === 'other') return true;
              return n.type === 'feature' || (n.type === 'group' && !!d.isFeature);
            })}
            onSelectSection={onSelectSection}
            onSelectNode={onSelectNode}
            title="Features"
          />
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
              {subComponentQuick.map((group) => (
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
                      const alreadyAdded = t !== 'gcode_macro' && Object.values(allConfigFiles).some(
                        (configFile) => configFile.sections.some((section) => section.section_type === t),
                      );
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
