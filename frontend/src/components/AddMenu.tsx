import { useState, useCallback, useEffect } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import * as api from '../services/api';
import { buildGraphFromConfig } from '../utils/graphBuilder';
import type { HardwareType, CommunicationType, SectionSchema, ExampleConfig } from '../types/config';
import McuNameDialog from './dialogs/McuNameDialog';

interface AddMenuProps {
  onClose: () => void;
}

type MenuTab = 'hardware' | 'sub_component' | 'feature' | 'connection' | 'group';

const HARDWARE_OPTIONS: Array<{ type: HardwareType; label: string; icon: string; description?: string }> = [
  { type: 'mainboard', label: 'Mainboard', icon: '📟', description: 'Main printer control board' },
  { type: 'toolhead', label: 'Toolhead Board', icon: '🔧', description: 'CAN/UART toolhead board' },
  { type: 'expander', label: 'Expander Board', icon: '🔌', description: 'Additional MCU or I/O expander' },
  { type: 'sbc', label: 'SBC', icon: '🖥️', description: 'Single-board computer (Raspberry Pi, CB1, etc.)' },
  { type: 'probe', label: 'Probe', icon: '📍', description: 'Probe with dedicated MCU' },
  { type: 'accelerometer', label: 'Accelerometer', icon: '📊', description: 'Standalone accelerometer board' },
  { type: 'other', label: 'Other Component', icon: '⬜', description: 'Custom hardware component' },
];

const COMM_OPTIONS: Array<{ type: CommunicationType; label: string; color: string }> = [
  { type: 'usb', label: 'USB', color: 'var(--color-usb)' },
  { type: 'canbus', label: 'CAN Bus', color: 'var(--color-canbus)' },
  { type: 'uart', label: 'UART', color: 'var(--color-uart)' },
];

const SUB_COMPONENT_GROUPS = [
  { group: 'stepper', label: 'Steppers', types: ['stepper_x', 'stepper_y', 'stepper_z', 'stepper_z1', 'stepper_z2', 'stepper_z3', 'stepper_a', 'stepper_b', 'stepper_c', 'manual_stepper', 'extruder_stepper', 'dual_carriage'] },
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

export default function AddMenu({ onClose }: AddMenuProps) {
  const [tab, setTab] = useState<MenuTab>('hardware');
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [hwPickerStep, setHwPickerStep] = useState<{ hwType: HardwareType; label: string } | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templates, setTemplates] = useState<ExampleConfig[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);

  // Custom group creation state
  const [customGroupLabel, setCustomGroupLabel] = useState('');
  const [customGroupColor, setCustomGroupColor] = useState('#64748b');
  const [customGroupParent, setCustomGroupParent] = useState<string>('');

  // MCU name prompt state
  const [mcuNamePrompt, setMcuNamePrompt] = useState<{
    hwType: HardwareType;
    label: string;
    templateFilename?: string;
  } | null>(null);

  const { schemas } = useConfigStore();
  const { addHardwareNode, addSubComponentNode, addFeatureNode, addCommunicationEdge, addCustomGroupNode, nodes } = useGraphStore();
  const { configFiles, activeFile, addSection } = useConfigStore();

  const hardwareNodes = nodes.filter((n) => n.type === 'hardware');

  // Board types that support template selection
  const TEMPLATE_TYPES = new Set<HardwareType>(['mainboard', 'toolhead', 'expander']);

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
          setTemplates(filtered.filter((e) =>
            e.category === 'generic' || e.category === 'example' || e.category === 'sample' || e.category === 'kit'
          ));
        })
        .catch(() => setTemplates([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [templateSearch, hwPickerStep]);

  const handleAddHardware = (hwType: HardwareType, label: string) => {
    // SBC is a singleton
    if (hwType === 'sbc') {
      const existingSbc = nodes.find((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc');
      if (existingSbc) return; // already exists
      label = 'SBC'; // enforce standard name
    }

    // For mainboard/toolhead/expander, show template picker first
    if (TEMPLATE_TYPES.has(hwType)) {
      setHwPickerStep({ hwType, label });
      return;
    }

    finishAddHardware(hwType, label);
  };

  const finishAddHardware = (hwType: HardwareType, label: string, templateFilename?: string, mcuName?: string) => {
    // Determine if this will be the primary MCU
    const hasPrimary = nodes.some(
      (n) => n.type === 'hardware' && !!(n.data as Record<string, unknown>).isPrimary,
    );
    const isPrimary = hwType === 'mainboard' && !hasPrimary;

    // Non-primary non-SBC boards need an MCU name
    if (!isPrimary && hwType !== 'sbc' && !mcuName) {
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
    const { setConfigFile } = useConfigStore.getState();
    if (!configFiles[configFile]) {
      setConfigFile(configFile, {
        filename: configFile,
        sections: [],
        includes: [],
        header_comments: [],
      });
    }

    const nodeId = addHardwareNode(hwType, effectiveLabel, configFile, { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 }, mcuName || '');

    // Set primary flag
    if (isPrimary) {
      useGraphStore.getState().updateNodeData(nodeId, { isPrimary: true });
    }

    // Create [mcu] or [mcu name] section for the board
    if (hwType !== 'sbc') {
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
          header_comments: [],
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
        if (!isPrimary && hwType !== 'sbc' && !mcuName && !templateMcuName) {
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
        setConfigFile(configFile, {
          filename: configFile,
          sections: config.sections,
          includes: config.includes || [],
          header_comments: config.header_comments || [],
        });
        // Build sub-component/feature nodes from the template sections
        const schemas = useConfigStore.getState().schemas;
        const graphStore = useGraphStore.getState();
        for (const sec of config.sections) {
          if (sec.section_type === 'mcu' || sec.section_type === 'include') continue;
          const displayName = schemas[sec.section_type]?.display_name || sec.section_type;
          const sLabel = sec.section_name ? `${displayName}: ${sec.section_name}` : displayName;
          const isFeature = FEATURE_TYPES.some((g) => g.types.includes(sec.section_type));
          if (isFeature) {
            graphStore.addFeatureNode(nodeId, sec.section_type, sLabel, sec.full_header);
          } else {
            graphStore.addSubComponentNode(nodeId, sec.section_type, sLabel, sec.full_header);
          }
        }
        setTemplateLoading(false);
        onClose();
      }).catch((err) => {
        console.error('Template load error:', err);
        setTemplateLoading(false);
        onClose();
      });
    } else {
      onClose();
    }
  };

  const handleAddSubComponent = (sectionType: string) => {
    const schema = schemas[sectionType];
    const displayName = schema?.display_name || sectionType;
    const isNamed = schema?.is_named;
    const defaultName = `${sectionType}_default`;
    const label = isNamed ? `${displayName}: ${defaultName}` : displayName;
    const header = isNamed ? `${sectionType} ${defaultName}` : sectionType;

    if (selectedParent) {
      addSubComponentNode(selectedParent, sectionType, label, header);
    }

    // Add to the parent's config file (not just activeFile)
    const parentNode = selectedParent ? nodes.find((n) => n.id === selectedParent) : null;
    const parentConfigFile = parentNode
      ? ((parentNode.data as Record<string, unknown>).configFile as string) || activeFile
      : activeFile;

    addSection(parentConfigFile, {
      section_type: sectionType,
      section_name: isNamed ? `${sectionType}_default` : '',
      full_header: header,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  };

  const handleAddFeature = (sectionType: string) => {
    // Feature uniqueness: prevent duplicates for non-gcode_macro features
    if (sectionType !== 'gcode_macro') {
      const existing = nodes.find((n) => {
        const d = n.data as Record<string, unknown>;
        return n.type === 'feature' && d.sectionType === sectionType;
      });
      if (existing) return;
    }

    const schema = schemas[sectionType];
    const displayName = schema?.display_name || sectionType;
    const isNamed = schema?.is_named;
    const defaultName = `${sectionType}_default`;
    const label = isNamed ? `${displayName}: ${defaultName}` : displayName;
    const header = isNamed ? `${sectionType} ${defaultName}` : sectionType;
    const pId = selectedParent || hardwareNodes[0]?.id;

    if (pId) {
      addFeatureNode(pId, sectionType, label, header);
    }

    // Add to the parent's config file
    const parentNode = pId ? nodes.find((n) => n.id === pId) : null;
    const parentConfigFile = parentNode
      ? ((parentNode.data as Record<string, unknown>).configFile as string) || activeFile
      : activeFile;

    addSection(parentConfigFile, {
      section_type: sectionType,
      section_name: isNamed ? `${sectionType}_default` : '',
      full_header: header,
      line_number: 0,
      params: [],
      header_comments: [],
    });
    // Keep menu open for multi-select
  };

  const handleAddCustomGroup = () => {
    const label = customGroupLabel.trim() || 'Custom Group';
    const parentId = customGroupParent || undefined;
    addCustomGroupNode(label, customGroupColor, undefined, parentId);
    setCustomGroupLabel('');
    onClose();
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
          {(['hardware', 'sub_component', 'feature', 'connection', 'group'] as MenuTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${
                tab === t
                  ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {t === 'hardware' ? 'Hardware' : t === 'sub_component' ? 'Sub-Components' : t === 'feature' ? 'Features' : t === 'group' ? 'Groups' : 'Connections'}
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
            <div>
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={() => { setHwPickerStep(null); setTemplateSearch(''); setTemplates([]); }}
                  className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                >
                  &larr; Back
                </button>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Add {hwPickerStep.label}
                </h3>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-4">
                <button
                  onClick={() => finishAddHardware(hwPickerStep.hwType, hwPickerStep.label)}
                  disabled={templateLoading}
                  className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[var(--color-text-secondary)]">
                    <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span className="text-xs font-medium text-[var(--color-text-primary)]">Blank</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">Start from scratch</span>
                </button>
                <div className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border border-dashed border-[var(--color-bg-tertiary)] text-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[var(--color-accent)]">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                    <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                  </svg>
                  <span className="text-xs font-medium text-[var(--color-accent)]">From Board Template</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">Search below</span>
                </div>
              </div>

              {/* Template search */}
              <input
                type="text"
                placeholder="Search board templates (e.g., SKR, Octopus, EBB)..."
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] mb-3"
                autoFocus
              />

              {/* Template list */}
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {templates.map((ex) => (
                  <button
                    key={ex.filename}
                    onClick={() => finishAddHardware(hwPickerStep.hwType, ex.name || hwPickerStep.label, ex.filename)}
                    disabled={templateLoading}
                    className="flex items-center justify-between w-full p-2.5 rounded-lg text-left transition-all border border-transparent hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)]"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[var(--color-text-primary)] truncate">{ex.name}</div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{ex.filename}</div>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 shrink-0 ml-2">
                      {ex.category}
                    </span>
                  </button>
                ))}
                {templates.length === 0 && templateSearch && (
                  <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">
                    No matching board templates found
                  </p>
                )}
                {templates.length === 0 && !templateSearch && (
                  <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">
                    Type to search board templates...
                  </p>
                )}
              </div>

              {templateLoading && (
                <div className="mt-3 p-2 rounded-lg bg-[var(--color-accent)]/10 text-xs text-[var(--color-accent)] text-center">
                  Loading template...
                </div>
              )}
            </div>
          )}

          {/* Sub-Component Tab */}
          {tab === 'sub_component' && (
            <div>
              {/* Parent selector */}
              {hardwareNodes.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                    Attach to hardware component:
                  </label>
                  <select
                    value={selectedParent || ''}
                    onChange={(e) => setSelectedParent(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                  >
                    <option value="">-- Select parent --</option>
                    {hardwareNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {(n.data as Record<string, unknown>).label as string}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {SUB_COMPONENT_GROUPS.map((group) => (
                <div key={group.group} className="mb-4">
                  <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 gap-1">
                    {group.types.map((t) => (
                      <button
                        key={t}
                        onClick={() => handleAddSubComponent(t)}
                        disabled={!selectedParent && hardwareNodes.length > 0}
                        className="px-3 py-2 rounded-lg text-xs text-left border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
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
              {hardwareNodes.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                    Attach to component:
                  </label>
                  <select
                    value={selectedParent || ''}
                    onChange={(e) => setSelectedParent(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                  >
                    <option value="">-- Select parent --</option>
                    {nodes.map((n) => (
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
                      const alreadyAdded = t !== 'gcode_macro' && nodes.some((n) => {
                        const d = n.data as Record<string, unknown>;
                        return n.type === 'feature' && d.sectionType === t;
                      });
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

          {/* Connection Tab */}
          {tab === 'connection' && (
            <div>
              <p className="text-xs text-[var(--color-text-secondary)] mb-4">
                Drag from an output handle to an input handle on the graph to create connections.
                You can also create communication links below:
              </p>
              <div className="space-y-2">
                {COMM_OPTIONS.map((comm) => (
                  <div
                    key={comm.type}
                    className="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-bg-tertiary)]"
                  >
                    <div
                      className="w-4 h-1 rounded"
                      style={{ backgroundColor: comm.color, borderStyle: 'dashed' }}
                    />
                    <span className="text-sm" style={{ color: comm.color }}>
                      {comm.label}
                    </span>
                    <span className="text-xs text-[var(--color-text-secondary)] ml-auto">
                      Dashed line
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] mt-4">
                All hardware components must have a communication trace to the host.
              </p>
            </div>
          )}

          {/* Groups Tab */}
          {tab === 'group' && (
            <div className="space-y-4">
              <p className="text-xs text-[var(--color-text-secondary)]">
                Create a custom group container to organise sub-components and features.
                Groups can be standalone or nested inside hardware nodes.
                Drag nodes in/out of groups freely on the canvas.
              </p>

              {/* Label */}
              <div>
                <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                  Group name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Z Motors, Toolhead, Extras…"
                  value={customGroupLabel}
                  onChange={(e) => setCustomGroupLabel(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
              </div>

              {/* Color picker */}
              <div>
                <label className="text-xs text-[var(--color-text-secondary)] mb-2 block">
                  Border colour
                </label>
                <div className="flex flex-wrap gap-2">
                  {[
                    '#64748b', '#38bdf8', '#f472b6', '#a78bfa',
                    '#22c55e', '#f97316', '#ef4444', '#f59e0b',
                    '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16',
                  ].map((c) => (
                    <button
                      key={c}
                      onClick={() => setCustomGroupColor(c)}
                      className="w-7 h-7 rounded-full border-2 transition-all"
                      style={{
                        backgroundColor: c,
                        borderColor: customGroupColor === c ? '#fff' : 'transparent',
                        boxShadow: customGroupColor === c ? `0 0 0 2px ${c}` : 'none',
                      }}
                    />
                  ))}
                  {/* Native colour input for custom colour */}
                  <label
                    className="w-7 h-7 rounded-full border-2 border-[var(--color-bg-tertiary)] flex items-center justify-center cursor-pointer hover:border-[var(--color-accent)]"
                    title="Custom colour"
                  >
                    <input
                      type="color"
                      value={customGroupColor}
                      onChange={(e) => setCustomGroupColor(e.target.value)}
                      className="sr-only"
                    />
                    <span className="text-[10px]">+</span>
                  </label>
                </div>
              </div>

              {/* Optional parent hardware */}
              {hardwareNodes.length > 0 && (
                <div>
                  <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
                    Place inside hardware node (optional)
                  </label>
                  <select
                    value={customGroupParent}
                    onChange={(e) => setCustomGroupParent(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                  >
                    <option value="">— Standalone (top level) —</option>
                    {hardwareNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {(n.data as Record<string, unknown>).label as string}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Preview */}
              <div
                className="p-3 rounded-lg border-2 border-dashed text-sm font-semibold"
                style={{ borderColor: customGroupColor, color: customGroupColor, backgroundColor: `${customGroupColor}0a` }}
              >
                📦 {customGroupLabel || 'Custom Group'}
              </div>

              <button
                onClick={handleAddCustomGroup}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors"
              >
                Create Group
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
