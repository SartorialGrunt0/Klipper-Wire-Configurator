import { useEffect, useMemo, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import * as api from '../services/api';
import { applyBoardTypeMarkerToMcuSections, buildBoardTypeMarker } from '../utils/boardTypeMarker';
import { buildUniqueSectionDraft } from '../utils/sectionNaming';
import type { ConfigSection, CommunicationType, ExampleConfig, HardwareType } from '../types/config';
import McuNameDialog from './dialogs/McuNameDialog';

interface AddMenuProps {
  onClose: () => void;
}

type MenuTab = 'hardware' | 'sub_component' | 'feature';

const HARDWARE_OPTIONS: Array<{ type: HardwareType; label: string; icon: string; description?: string }> = [
  { type: 'mainboard', label: 'Mainboard', icon: '', description: 'Main printer control board' },
  { type: 'toolhead', label: 'Toolhead Board', icon: '', description: 'CAN/USB toolhead board' },
  { type: 'expander', label: 'Expander Board', icon: '', description: 'Additional MCU or I/O expander' },
  { type: 'config_file', label: 'Configuration File', icon: '', description: 'Non-MCU configuration files' },
  { type: 'sbc', label: 'SBC', icon: '', description: 'Single-board computer (Raspberry Pi, CB1, etc.)' },
  { type: 'probe', label: 'Probe', icon: '', description: 'Probe with dedicated MCU' },
  { type: 'accelerometer', label: 'Accelerometer', icon: '', description: 'Standalone accelerometer board' },
  { type: 'other', label: 'Other Component', icon: '', description: 'Custom hardware component' },
];

const CARTESIAN_STEPPERS = ['stepper_x', 'stepper_y', 'stepper_z', 'stepper_z1', 'stepper_z2', 'stepper_z3', 'manual_stepper', 'extruder_stepper', 'dual_carriage'];
const DELTA_STEPPERS = ['stepper_a', 'stepper_b', 'stepper_c', 'manual_stepper', 'extruder_stepper'];

const DELTA_KINEMATICS = new Set(['delta', 'rotary_delta']);

const BASE_SUB_COMPONENT_GROUPS: Array<{ group: string; label: string; types: string[] }> = [
  { group: 'stepper', label: 'Steppers', types: CARTESIAN_STEPPERS },
  { group: 'stepper_driver', label: 'Stepper Drivers', types: ['tmc2209', 'tmc2208', 'tmc2130', 'tmc2240', 'tmc5160', 'tmc2660'] },
  { group: 'extruder', label: 'Extruders', types: ['extruder', 'extruder1', 'extruder2'] },
  { group: 'heater', label: 'Heaters', types: ['heater_bed', 'heater_generic'] },
  { group: 'fan', label: 'Fans', types: ['fan', 'heater_fan', 'controller_fan', 'temperature_fan', 'fan_generic'] },
  { group: 'temperature', label: 'Temperature Sensors', types: ['temperature_sensor'] },
  { group: 'probe', label: 'Probes', types: ['probe', 'bltouch', 'smart_effector', 'probe_eddy_current'] },
  { group: 'led', label: 'LEDs', types: ['neopixel', 'dotstar', 'led', 'pca9533', 'pca9632'] },
  { group: 'display', label: 'Displays', types: ['display'] },
  { group: 'servo', label: 'Servos', types: ['servo'] },
  { group: 'pin', label: 'Output Pins', types: ['output_pin', 'gcode_button', 'pwm_tool'] },
  { group: 'filament_sensor', label: 'Filament Sensors', types: ['filament_switch_sensor', 'filament_motion_sensor'] },
  { group: 'accelerometer', label: 'Accelerometers', types: ['adxl345', 'lis2dw', 'lis3dh', 'bmi160', 'mpu9250', 'icm20948'] },
  { group: 'mcu', label: 'MCU', types: ['mcu'] },
];

const FEATURE_TYPES = [
  { group: 'bed_leveling', label: 'Bed Leveling', types: ['bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust', 'bed_screws', 'bed_tilt', 'skew_correction', 'axis_twist_compensation'] },
  { group: 'homing', label: 'Homing', types: ['safe_z_home', 'homing_override', 'endstop_phase'] },
  { group: 'resonance', label: 'Resonance', types: ['input_shaper', 'resonance_tester'] },
  { group: 'gcode', label: 'G-Code Features', types: ['virtual_sdcard', 'pause_resume', 'firmware_retraction', 'force_move', 'idle_timeout', 'gcode_macro', 'delayed_gcode', 'gcode_arcs', 'respond', 'exclude_object', 'save_variables'] },
];

const TEMPLATE_CATEGORIES = new Set<ExampleConfig['category']>(['generic', 'example', 'sample', 'kit']);

function templateMatchesHardwareType(template: ExampleConfig, hwType: HardwareType): boolean {
  if (template.board_type) {
    return template.board_type === hwType;
  }

  return TEMPLATE_CATEGORIES.has(template.category);
}

function detectCommunicationType(mcuSection?: ConfigSection): CommunicationType {
  if (!mcuSection) return 'usb';

  for (const param of mcuSection.params || []) {
    if (param.is_commented_out) continue;
    if (param.key === 'canbus_uuid' || param.key === 'canbus_interface') {
      return 'canbus';
    }
    if (param.key === 'serial') {
      const value = param.value || '';
      if (/\/dev\/tty(S|AMA|ACM|USB)/.test(value)) {
        return 'uart';
      }
      return 'usb';
    }
  }

  return 'usb';
}

export default function AddMenu({ onClose }: AddMenuProps) {
  const [tab, setTab] = useState<MenuTab>('hardware');
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [hwPickerStep, setHwPickerStep] = useState<{ hwType: HardwareType; label: string } | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templates, setTemplates] = useState<ExampleConfig[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);

  // MCU name prompt state
  const [mcuNamePrompt, setMcuNamePrompt] = useState<{
    hwType: HardwareType;
    label: string;
    templateFilename?: string;
  } | null>(null);

  const { schemas } = useConfigStore();
  const { addHardwareNode, addSubComponentNode, addFeatureNode, nodes } = useGraphStore();
  const { configFiles, activeFile, addSection } = useConfigStore();

  const hardwareNodes = nodes.filter((n) => n.type === 'hardware');
  const attachableHardwareNodes = hardwareNodes.filter((n) => {
    const data = n.data as Record<string, unknown>;
    return data.hardwareType !== 'sbc' || !!data.isMcu;
  });
  const hasFeatureSectionType = (sectionType: string) => sectionType !== 'gcode_macro' && Object.values(configFiles).some(
    (configFile) => configFile.sections.some((section) => section.section_type === sectionType),
  );

  // Derive kinematics from the selected parent's config file (fall back to all files)
  const kinematics = (() => {
    const parentNode = selectedParent ? nodes.find((n) => n.id === selectedParent) : null;
    const parentConfigFile = parentNode
      ? (parentNode.data as Record<string, unknown>).configFile as string
      : null;

    const filesToSearch = parentConfigFile
      ? [configFiles[parentConfigFile]].filter(Boolean)
      : Object.values(configFiles);

    for (const cf of filesToSearch) {
      const printerSection = cf.sections.find((s) => s.section_type === 'printer');
      if (printerSection) {
        const kinParam = printerSection.params.find((p) => p.key === 'kinematics' && !p.is_commented_out);
        if (kinParam) return kinParam.value.trim().toLowerCase();
      }
    }
    return 'cartesian';
  })();

  const subComponentGroups = BASE_SUB_COMPONENT_GROUPS.map((g) =>
    g.group === 'stepper'
      ? { ...g, types: DELTA_KINEMATICS.has(kinematics) ? DELTA_STEPPERS : CARTESIAN_STEPPERS }
      : g,
  );

  // Board types that support template selection
  const TEMPLATE_TYPES = new Set<HardwareType>(['mainboard', 'toolhead', 'expander', 'probe', 'accelerometer', 'other']);

  // Load templates when search changes and picker is open
  useEffect(() => {
    if (!hwPickerStep || !TEMPLATE_TYPES.has(hwPickerStep.hwType)) return;
    const timer = setTimeout(() => {
      const query = templateSearch.trim();
      (query ? api.searchExamples(query) : api.listExamples())
        .then((res) => {
          // Filter to generic/board configs (not printer-specific ones)
          const filtered = (res as { examples?: ExampleConfig[]; results?: ExampleConfig[] }).results
            || (res as { examples: ExampleConfig[] }).examples || [];
          setTemplates(filtered.filter((template) => templateMatchesHardwareType(template, hwPickerStep.hwType)));
        })
        .catch(() => setTemplates([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [templateSearch, hwPickerStep]);

  const ensureSbcNode = (preferAnchoredPosition: boolean) => {
    const graphStore = useGraphStore.getState();
    const existingSbc = graphStore.nodes.find(
      (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).hardwareType === 'sbc',
    );
    if (existingSbc) return existingSbc.id;

    const sbcId = graphStore.addHardwareNode(
      'sbc',
      'SBC',
      '',
      preferAnchoredPosition ? { x: 80, y: 140 } : undefined,
      'host_mcu',
    );

    if (preferAnchoredPosition) {
      graphStore.toggleHardwareCollapse(sbcId);
    }

    return sbcId;
  };

  const ensureCommunicationEdge = (targetNodeId: string, commType: CommunicationType, preferAnchoredPosition: boolean) => {
    const graphStore = useGraphStore.getState();
    const sbcId = ensureSbcNode(preferAnchoredPosition);
    const freshGraph = useGraphStore.getState();
    const existingEdge = freshGraph.edges.find((edge) => (
      (edge.data as Record<string, unknown>)?.edgeType === 'communication'
      && ((edge.source === sbcId && edge.target === targetNodeId)
        || (edge.source === targetNodeId && edge.target === sbcId))
    ));

    if (!existingEdge) {
      graphStore.addCommunicationEdge(sbcId, targetNodeId, commType);
    }
  };

  const handleAddHardware = (hwType: HardwareType, label: string) => {
    // SBC is a singleton
    if (hwType === 'sbc') {
      const existingSbc = nodes.find((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc');
      if (existingSbc) return; // already exists
      label = 'SBC'; // enforce standard name
    }

    // For mainboard/toolhead/expander, show template picker first
    if (TEMPLATE_TYPES.has(hwType)) {
      setTemplateSearch('');
      setTemplates([]);
      setHwPickerStep({ hwType, label });
      return;
    }

    finishAddHardware(hwType, label);
  };

  const finishAddHardware = (hwType: HardwareType, label: string, templateFilename?: string, mcuName?: string) => {
    const isFreshHardwareView = hardwareNodes.length === 0;
    const createsMcuSection = hwType !== 'sbc' && hwType !== 'config_file';

    // Determine if this will be the primary MCU
    const hasPrimary = nodes.some(
      (n) => n.type === 'hardware' && !!(n.data as Record<string, unknown>).isPrimary,
    );
    const isPrimary = hwType === 'mainboard' && !hasPrimary;

    // Non-primary non-SBC boards need an MCU name
    if (!isPrimary && createsMcuSection && !mcuName) {
      // Check if template already provides an MCU name (will be resolved after load)
      // For blank (no template), prompt now
      if (!templateFilename) {
        setMcuNamePrompt({ hwType, label });
        return;
      }
      // For templates, we'll check after loading — proceed for now and extract MCU name from template
    }

    const effectiveLabel = mcuName || label;
    const configFile = isPrimary && !configFiles['printer.cfg']
      ? 'printer.cfg'
      : `${effectiveLabel.toLowerCase().replace(/\s+/g, '_')}.cfg`;

    // Ensure the config file exists in configStore
    const { updateConfigFile } = useConfigStore.getState();
    if (!configFiles[configFile]) {
      updateConfigFile(configFile, {
        filename: configFile,
        sections: [],
        includes: [],
        header_comments: [],
      });
    }

    const nodePosition = isFreshHardwareView && hwType !== 'sbc'
      ? { x: 560, y: 140 }
      : { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };

    if (isFreshHardwareView && createsMcuSection) {
      ensureSbcNode(true);
    }

    const nodeId = addHardwareNode(hwType, effectiveLabel, configFile, nodePosition, mcuName || '');

    // Set primary flag
    if (isPrimary) {
      useGraphStore.getState().updateNodeData(nodeId, { isPrimary: true });
    }

    // Create [mcu] or [mcu name] section for the board
    if (createsMcuSection) {
      const mcuHeader = mcuName ? `mcu ${mcuName}` : 'mcu';
      const cs = useConfigStore.getState();
      const existingMcu = cs.configFiles[configFile]?.sections.some(
        (s) => s.section_type === 'mcu',
      );
      if (!existingMcu) {
        cs.addSection(configFile, {
          section_type: 'mcu',
          section_name: mcuName || '',
          full_header: mcuHeader,
          line_number: 0,
          params: [],
          header_comments: [buildBoardTypeMarker(hwType)],
        });
      }
    }

    // If a template was selected, load it and populate sections/graph
    if (templateFilename) {
      setTemplateLoading(true);
      api.getExample(templateFilename).then((res) => {
        const config = res.config;

        // Check if template has an MCU name and use it
        const mcuSection = config.sections.find((s: { section_type: string }) => s.section_type === 'mcu');
        const templateMcuName = mcuSection?.section_name || '';

        // If the board should be non-primary and we don't have an MCU name yet, prompt
        if (!isPrimary && createsMcuSection && !mcuName && !templateMcuName) {
          // Remove the node we just created — will recreate after naming
          useGraphStore.getState().removeNode(nodeId);
          useConfigStore.getState().removeConfigFile(configFile);
          setTemplateLoading(false);
          setMcuNamePrompt({ hwType, label, templateFilename });
          return;
        }

        const finalMcuName = mcuName || templateMcuName;
        // Update node with resolved MCU name
        if (finalMcuName) {
          useGraphStore.getState().updateNodeData(nodeId, { mcuName: finalMcuName, label: finalMcuName });
        }

        // Set config file with the parsed sections
        updateConfigFile(configFile, {
          filename: configFile,
          sections: applyBoardTypeMarkerToMcuSections(config.sections, hwType, finalMcuName),
          includes: config.includes || [],
          header_comments: config.header_comments || [],
        });
        // Build sub-component/feature nodes from the template sections
        const schemas = useConfigStore.getState().schemas;
        const graphStore = useGraphStore.getState();
        for (const sec of config.sections) {
          if (sec.section_type === 'include') continue;
          const displayName = schemas[sec.section_type]?.display_name || sec.section_type;
          const sLabel = sec.section_name ? `${displayName}: ${sec.section_name}` : displayName;
          const isFeature = FEATURE_TYPES.some((g) => g.types.includes(sec.section_type));
          if (isFeature) {
            graphStore.addFeatureNode(nodeId, sec.section_type, sLabel, sec.full_header);
          } else {
            graphStore.addSubComponentNode(nodeId, sec.section_type, sLabel, sec.full_header);
          }
        }
        // Add communication edge from SBC to this hardware node
        if (createsMcuSection) {
          ensureCommunicationEdge(nodeId, detectCommunicationType(mcuSection), isFreshHardwareView);
        }
        setTemplateLoading(false);
        onClose();
      }).catch((err) => {
        console.error('Template load error:', err);
        setTemplateLoading(false);
        onClose();
      });
    } else {
      // Add communication edge from SBC to this hardware node (blank config)
      if (createsMcuSection) {
        ensureCommunicationEdge(nodeId, 'usb', isFreshHardwareView);
      }
      onClose();
    }
  };

  const handleAddSubComponent = (sectionType: string) => {
    const parentNode = selectedParent ? nodes.find((n) => n.id === selectedParent) : null;
    const parentConfigFile = parentNode
      ? ((parentNode.data as Record<string, unknown>).configFile as string) || activeFile
      : activeFile;
    const schema = schemas[sectionType];
    const displayName = schema?.display_name || sectionType;
    const existingSections = configFiles[parentConfigFile]?.sections || [];
    const draft = buildUniqueSectionDraft(sectionType, displayName, schema, existingSections);

    if (selectedParent) {
      addSubComponentNode(selectedParent, draft.sectionType, draft.label, draft.fullHeader, parentConfigFile);
    } else {
      // No parent selected — add as standalone node in empty space
      const { addSubComponentNode: addSub } = useGraphStore.getState();
      addSub(null as unknown as string, draft.sectionType, draft.label, draft.fullHeader, parentConfigFile);
    }

    addSection(parentConfigFile, {
      section_type: draft.sectionType,
      section_name: draft.sectionName,
      full_header: draft.fullHeader,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  };

  const handleAddFeature = (sectionType: string) => {
    // Feature uniqueness: prevent duplicates for non-gcode_macro features
    if (hasFeatureSectionType(sectionType)) {
      return;
    }

    const pId = selectedParent || hardwareNodes[0]?.id || null;
    const parentNode = pId ? nodes.find((n) => n.id === pId) : null;
    const parentConfigFile = parentNode
      ? ((parentNode.data as Record<string, unknown>).configFile as string) || activeFile
      : activeFile;

    const schema = schemas[sectionType];
    const displayName = schema?.display_name || sectionType;
    const existingSections = configFiles[parentConfigFile]?.sections || [];
    const draft = buildUniqueSectionDraft(sectionType, displayName, schema, existingSections);

    if (pId) {
      addFeatureNode(pId, draft.sectionType, draft.label, draft.fullHeader, parentConfigFile);
    } else {
      // No parent selected — add as standalone feature node
      const { addFeatureNode: addFeat } = useGraphStore.getState();
      addFeat(null as unknown as string, draft.sectionType, draft.label, draft.fullHeader, parentConfigFile);
    }

    addSection(parentConfigFile, {
      section_type: draft.sectionType,
      section_name: draft.sectionName,
      full_header: draft.fullHeader,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  };

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      {mcuNamePrompt && (
        <McuNameDialog
          title="Name this MCU"
          message="Non-primary boards need an MCU name for section headers (e.g., [mcu EBBCan]) and pin prefixes (e.g., EBBCan:gpio13)."
          onConfirm={(name) => {
            const { hwType, label, templateFilename } = mcuNamePrompt;
            setMcuNamePrompt(null);
            finishAddHardware(hwType, label, templateFilename, name);
          }}
          onCancel={() => setMcuNamePrompt(null)}
        />
      )}
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[600px] max-h-[70vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs */}
        <div className="flex border-b border-[var(--color-bg-tertiary)]">
          {(['hardware', 'sub_component', 'feature'] as MenuTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${
                tab === t
                  ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {t === 'hardware' ? 'Major Components' : t === 'sub_component' ? 'Sub-Components' : 'Features'}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto max-h-[calc(70vh-48px)] p-4">
          {/* Hardware Tab */}
          {tab === 'hardware' && !hwPickerStep && (
            <div className="grid grid-cols-2 gap-2">
              {HARDWARE_OPTIONS.map((hw) => {
                const isSbcAdded = hw.type === 'sbc' && nodes.some((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc');
                return (
                  <button
                    key={hw.type}
                    onClick={() => handleAddHardware(hw.type, hw.label)}
                    disabled={isSbcAdded}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                      isSbcAdded
                        ? 'border-[var(--color-bg-tertiary)] opacity-40 cursor-not-allowed'
                        : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)]'
                    }`}
                  >
                    <span className="text-2xl">{hw.icon}</span>
                    <div>
                      <span className="text-sm text-[var(--color-text-primary)] block">
                        {hw.label}
                        {isSbcAdded && <span className="ml-1 text-[10px] opacity-60">(added)</span>}
                      </span>
                      {hw.description && (
                        <span className="text-[10px] text-[var(--color-text-secondary)]">{hw.description}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Hardware Template Picker */}
          {tab === 'hardware' && hwPickerStep && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Add {hwPickerStep.label}
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    Start blank or seed the component from a reference config.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setHwPickerStep(null);
                    setTemplateSearch('');
                    setTemplates([]);
                  }}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:border-[var(--color-accent)]"
                >
                  Back
                </button>
              </div>

              <button
                onClick={() => finishAddHardware(hwPickerStep.hwType, hwPickerStep.label)}
                className="w-full p-3 rounded-lg border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all text-left"
              >
                <div className="text-sm font-medium text-[var(--color-text-primary)]">Blank {hwPickerStep.label}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  Create the component with an empty config section set and wire it up manually.
                </div>
              </button>

              <div>
                <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                  Reference templates
                </label>
                <input
                  type="text"
                  placeholder="Search reference templates..."
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
              </div>

              <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {templateLoading && (
                  <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">
                    Loading templates...
                  </div>
                )}
                {!templateLoading && templates.map((template) => (
                  <button
                    key={template.filename}
                    onClick={() => finishAddHardware(hwPickerStep.hwType, hwPickerStep.label, template.filename)}
                    className="w-full p-3 rounded-lg border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all text-left"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-[var(--color-text-primary)]">{template.name}</div>
                        <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                          {template.filename}
                        </div>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-full bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] border border-[var(--color-bg-tertiary)] shrink-0">
                        {template.category}
                      </span>
                    </div>
                  </button>
                ))}
                {!templateLoading && templates.length === 0 && (
                  <div className="px-3 py-5 text-xs text-[var(--color-text-secondary)] text-center border border-dashed border-[var(--color-bg-tertiary)] rounded-lg">
                    No matching templates found.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sub-Component Tab */}
          {tab === 'sub_component' && (
            <div>
              {attachableHardwareNodes.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                    Attach to component (optional):
                  </label>
                  <select
                    value={selectedParent || ''}
                    onChange={(e) => setSelectedParent(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                  >
                    <option value="">-- None (standalone) --</option>
                    {attachableHardwareNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {(n.data as Record<string, unknown>).label as string}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {attachableHardwareNodes.length === 0 && (
                <p className="text-xs text-[var(--color-text-secondary)] mb-4">
                  Add a hardware component first to attach sub-components, or create a standalone section.
                </p>
              )}

              {subComponentGroups.map((group) => (
                <div key={group.group} className="mb-4">
                  <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 gap-1">
                    {group.types.map((t) => (
                      <button
                        key={t}
                        onClick={() => handleAddSubComponent(t)}
                        className="px-3 py-2 rounded-lg text-xs text-left border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all"
                      >
                        {schemas[t]?.display_name || t}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}


          {/* Feature Tab */}
          {tab === 'feature' && (
            <div>
              {attachableHardwareNodes.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                    Attach to component (optional):
                  </label>
                  <select
                    value={selectedParent || ''}
                    onChange={(e) => setSelectedParent(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                  >
                    <option value="">-- None (standalone) --</option>
                    {attachableHardwareNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {(n.data as Record<string, unknown>).label as string}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {FEATURE_TYPES.map((group) => (
                <div key={group.group} className="mb-4">
                  <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 gap-1">
                    {group.types.map((t) => {
                      const alreadyAdded = hasFeatureSectionType(t);
                      return (
                        <button
                          key={t}
                          onClick={() => handleAddFeature(t)}
                          disabled={alreadyAdded}
                          className={`px-3 py-2 rounded-lg text-xs text-left border transition-all ${
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
