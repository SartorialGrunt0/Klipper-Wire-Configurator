/**
 * Builds React Flow graph nodes and edges from parsed Klipper ConfigFiles.
 *
 * Two entry points:
 * - buildGraphFromConfig(): legacy single-file builder (creates one mainboard per file)
 * - buildProjectGraph(): project-aware builder that takes ALL config files,
 *   detects MCUs across files, resolves includes, and builds a unified graph.
 */

import type { ConfigFile, ConfigSection, ConfigParam, SectionSchema } from '../types/config';
import type { HardwareType } from '../types/config';

// Section types that are sub-components (attached to hardware)
const SUB_COMPONENT_TYPES = new Set([
  'stepper_x', 'stepper_y', 'stepper_z', 'stepper_z1', 'stepper_z2', 'stepper_z3',
  'stepper_a', 'stepper_b', 'stepper_c', 'manual_stepper', 'extruder_stepper',
  'dual_carriage', 'extruder', 'extruder1', 'extruder2',
  'tmc2209', 'tmc2208', 'tmc2130', 'tmc2240', 'tmc5160', 'tmc2660',
  'heater_bed', 'heater_generic',
  'fan', 'heater_fan', 'controller_fan', 'temperature_fan', 'fan_generic',
  'temperature_sensor',
  'probe', 'bltouch', 'smart_effector', 'probe_eddy_current',
  'neopixel', 'dotstar', 'led', 'pca9533', 'pca9632',
  'display', 'servo', 'output_pin', 'gcode_button', 'pwm_tool',
  'filament_switch_sensor', 'filament_motion_sensor',
  'adxl345', 'lis2dw', 'lis3dh', 'bmi160', 'mpu9250', 'icm20948',
  'printer',
]);

// Section types that are features
const FEATURE_TYPES = new Set([
  'bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust',
  'bed_screws', 'bed_tilt', 'skew_correction', 'axis_twist_compensation',
  'safe_z_home', 'homing_override', 'endstop_phase',
  'input_shaper', 'resonance_tester',
  'virtual_sdcard', 'pause_resume', 'firmware_retraction', 'force_move',
  'idle_timeout', 'gcode_macro', 'delayed_gcode', 'gcode_arcs',
  'respond', 'exclude_object', 'save_variables',
]);

// Map section types to component groups (for grouping)
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
  printer: 'printer',
  // Feature types
  gcode_macro: 'gcode_macro', delayed_gcode: 'gcode_macro',
  bed_mesh: 'bed_leveling', z_tilt: 'bed_leveling', quad_gantry_level: 'bed_leveling',
  screws_tilt_adjust: 'bed_leveling', bed_screws: 'bed_leveling', bed_tilt: 'bed_leveling',
  skew_correction: 'bed_leveling', axis_twist_compensation: 'bed_leveling',
  safe_z_home: 'homing', homing_override: 'homing', endstop_phase: 'homing',
  input_shaper: 'resonance', resonance_tester: 'resonance',
};

// Human-readable group names
const GROUP_DISPLAY_NAMES: Record<string, string> = {
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
  other: 'Other',
};

interface GroupChildData {
  sectionType: string;
  label: string;
  sectionHeader: string;
  isFeature: boolean;
  params: ConfigParam[];
}

interface GraphStore {
  addHardwareNode: (type: HardwareType, label: string, configFile: string, position?: { x: number; y: number }) => string;
  addSubComponentNode: (parentId: string, sectionType: string, label: string, sectionHeader: string) => string;
  addFeatureNode: (parentId: string, sectionType: string, label: string, sectionHeader: string) => string;
  addGroupNode: (parentId: string, componentGroup: string, label: string, children: GroupChildData[], isFeature: boolean) => string;
  addConfigurationEdge: (sourceId: string, targetId: string, hwType: HardwareType) => string;
  addCommunicationEdge: (sourceId: string, targetId: string, commType: 'usb' | 'canbus' | 'uart') => string;
  updateNodeData: (id: string, data: Record<string, unknown>) => void;
}

/** Info about a discovered MCU across the project */
interface McuInfo {
  /** The MCU name (empty string for unnamed/primary [mcu]) */
  name: string;
  /** Hardware type inferred from name */
  hwType: HardwareType;
  /** Which config file the [mcu] section lives in */
  sourceFile: string;
  /** The graph node ID once created */
  nodeId: string;
}

/**
 * Classify an MCU name into a hardware type.
 */
function classifyMcuName(name: string): HardwareType {
  if (!name) return 'mainboard';
  const lower = name.toLowerCase();
  if (lower.includes('host') || lower.includes('rpi') || lower.includes('cb1') || lower.includes('linux')) return 'sbc';
  if (lower.includes('ebb') || lower.includes('toolhead') || lower.includes('th')) return 'toolhead';
  return 'expander';
}

/**
 * Check if a section references a named MCU via pin prefixes (e.g. "EBBCan:gpio18").
 * Returns the MCU name if found, or empty string for primary MCU / no match.
 */
function detectMcuReference(section: ConfigSection, mcuNames: string[]): string {
  for (const param of section.params) {
    if (param.is_commented_out) continue;
    const val = param.value;
    for (const name of mcuNames) {
      if (name && val.includes(`${name}:`)) {
        return name;
      }
    }
  }
  return '';
}

/**
 * Determine the main config file from a set of files.
 * Priority: printer.cfg > file with most [include] directives > file with unnamed [mcu] > first file.
 */
function findMainFile(configs: Record<string, ConfigFile>): string {
  const filenames = Object.keys(configs);
  // 1. printer.cfg always wins
  if (configs['printer.cfg']) return 'printer.cfg';
  // 2. File with the most includes (it's the root)
  let maxIncludes = -1;
  let maxFile = filenames[0];
  for (const [fn, cf] of Object.entries(configs)) {
    if (cf.includes.length > maxIncludes) {
      maxIncludes = cf.includes.length;
      maxFile = fn;
    }
  }
  if (maxIncludes > 0) return maxFile;
  // 3. File with unnamed [mcu] section
  for (const [fn, cf] of Object.entries(configs)) {
    if (cf.sections.some((s) => s.section_type === 'mcu' && !s.section_name)) {
      return fn;
    }
  }
  return filenames[0];
}

/**
 * Build a unified graph from multiple config files (a Klipper project).
 *
 * This is the primary builder for multi-file imports. It:
 * 1. Discovers all MCU definitions across ALL files
 * 2. Creates one hardware node per MCU (not per file)
 * 3. Assigns each config file to its "owner" hardware node
 * 4. Creates include-based edges between hardware nodes
 * 5. Creates sub-component/feature nodes, assigning each to the correct
 *    hardware via pin prefix detection
 */
export function buildProjectGraph(
  configs: Record<string, ConfigFile>,
  graphStore: GraphStore,
  schemas: Record<string, SectionSchema>,
): void {
  const filenames = Object.keys(configs);
  if (filenames.length === 0) return;

  const mainFile = findMainFile(configs);

  // ── Phase 1: Discover all MCU sections across all files ──────────
  const mcuInfos: McuInfo[] = [];
  const mcuByName = new Map<string, McuInfo>(); // MCU name → info

  for (const [filename, config] of Object.entries(configs)) {
    for (const sec of config.sections) {
      if (sec.section_type !== 'mcu') continue;
      const name = sec.section_name || '';
      // Skip duplicates (same MCU defined in multiple files)
      if (mcuByName.has(name)) continue;
      const hwType = classifyMcuName(name);
      const info: McuInfo = {
        name,
        hwType,
        sourceFile: filename,
        nodeId: '', // filled in Phase 2
      };
      mcuInfos.push(info);
      mcuByName.set(name, info);
    }
  }

  // If no MCU sections found at all, create a default mainboard for the main file
  if (mcuInfos.length === 0) {
    mcuInfos.push({
      name: '',
      hwType: 'mainboard',
      sourceFile: mainFile,
      nodeId: '',
    });
    mcuByName.set('', mcuInfos[0]);
  }

  // ── Phase 2: Create hardware nodes ───────────────────────────────
  // Count total sections for positioning
  let totalSections = 0;
  for (const cf of Object.values(configs)) {
    totalSections += cf.sections.filter((s) => s.section_type !== 'mcu').length;
  }
  const centerY = Math.max(totalSections * 20, 300);
  const mcuSpacing = 400;

  for (let i = 0; i < mcuInfos.length; i++) {
    const mcu = mcuInfos[i];
    const label = mcu.name || 'Mainboard';
    // Assign config file: MCU file if it has one, otherwise main file
    const configFile = mcu.sourceFile;
    const x = 500 + i * mcuSpacing;
    mcu.nodeId = graphStore.addHardwareNode(mcu.hwType, label, configFile, { x, y: centerY });
    if (mcu.hwType === 'mainboard' && !mcu.name) {
      graphStore.updateNodeData(mcu.nodeId, { isPrimary: true });
    }
  }

  // ── Phase 3: Map files to owner hardware & create include edges ──
  // A file "belongs to" the hardware whose [mcu] section it contains.
  // Files without an [mcu] are include-only files owned by whoever includes them.
  const fileOwner = new Map<string, string>(); // filename → hardware nodeId

  // First pass: files with MCU sections own themselves
  for (const mcu of mcuInfos) {
    // The MCU's source file is owned by this hardware
    if (!fileOwner.has(mcu.sourceFile)) {
      fileOwner.set(mcu.sourceFile, mcu.nodeId);
    }
  }

  // Second pass: resolve include-only files via the include tree
  // The main file includes other files → those belong to mainboard (unless they have their own MCU)
  const primaryMcu = mcuByName.get('') || mcuInfos[0];
  const mainConfig = configs[mainFile];

  if (mainConfig) {
    for (const inc of mainConfig.includes) {
      const incFilename = inc.replace(/^.*[\\/]/, ''); // strip path, keep filename
      // Check if this is one of our imported files
      const matchedFile = filenames.find(
        (fn) => fn === incFilename || fn === inc || fn.endsWith(`/${incFilename}`) || fn.endsWith(`\\${incFilename}`),
      );
      if (matchedFile && !fileOwner.has(matchedFile)) {
        // Include-only file → assign to primary mainboard
        fileOwner.set(matchedFile, primaryMcu.nodeId);
      }
    }
  }

  // Any remaining unassigned files → attach to primary
  for (const fn of filenames) {
    if (!fileOwner.has(fn)) {
      fileOwner.set(fn, primaryMcu.nodeId);
    }
  }

  // Create configuration edges between hardware that have [include] relationships
  // e.g., printer.cfg includes EBB.cfg → edge from EBB hardware to mainboard
  const allMcuNames = mcuInfos.map((m) => m.name);
  if (mainConfig) {
    for (const inc of mainConfig.includes) {
      const incFilename = inc.replace(/^.*[\\/]/, '');
      // Find which MCU node owns the included file
      for (const mcu of mcuInfos) {
        if (mcu.sourceFile === incFilename || mcu.sourceFile.endsWith(`/${incFilename}`)) {
          if (mcu.nodeId !== primaryMcu.nodeId) {
            // Create edge: included hardware → main hardware
            if (mcu.hwType === 'sbc') {
              graphStore.addCommunicationEdge(mcu.nodeId, primaryMcu.nodeId, 'usb');
            } else {
              graphStore.addConfigurationEdge(mcu.nodeId, primaryMcu.nodeId, mcu.hwType);
            }
          }
          break;
        }
      }
    }
  }

  // ── Phase 4: Create sub-component/feature nodes for all sections ─
  // Collect sections by parent+componentGroup for grouping
  const groupedSections: Map<string, Array<{
    sec: ConfigSection;
    sType: string;
    label: string;
    parentId: string;
    isFeature: boolean;
    componentGroup: string;
  }>> = new Map();

  for (const [filename, config] of Object.entries(configs)) {
    for (const sec of config.sections) {
      if (sec.section_type === 'mcu') continue;

      const sType = sec.section_type;

      // Build descriptive label: "Display Name: section_name"
      const displayName = schemas[sType]?.display_name || sType;
      const label = sec.section_name
        ? `${displayName}: ${sec.section_name}`
        : displayName;

      // Determine parent: check pin references to named MCUs first
      const referencedMcu = detectMcuReference(sec, allMcuNames);
      let parentId: string;
      if (referencedMcu) {
        const mcuInfo = mcuByName.get(referencedMcu);
        parentId = mcuInfo ? mcuInfo.nodeId : (fileOwner.get(filename) || primaryMcu.nodeId);
      } else {
        parentId = fileOwner.get(filename) || primaryMcu.nodeId;
      }

      const isFeature = FEATURE_TYPES.has(sType);
      const componentGroup = COMPONENT_GROUP_MAP[sType] || (isFeature ? sType : 'other');

      // Group key: parent + group type + feature/sub distinction
      const groupKey = `${parentId}::${componentGroup}::${isFeature ? 'feat' : 'sub'}`;

      if (!groupedSections.has(groupKey)) {
        groupedSections.set(groupKey, []);
      }
      groupedSections.get(groupKey)!.push({
        sec, sType, label, parentId, isFeature, componentGroup,
      });
    }
  }

  // Create nodes: groups of 3+ become collapsible groups, smaller sets stay individual
  for (const [, items] of groupedSections) {
    if (items.length >= 3) {
      // Create a group node with children collapsed inside
      const first = items[0];
      const groupLabel = GROUP_DISPLAY_NAMES[first.componentGroup] || first.componentGroup;
      const childData = items.map((item) => ({
        sectionType: item.sType,
        label: item.label,
        sectionHeader: item.sec.full_header,
        isFeature: item.isFeature,
        params: item.sec.params.filter((p) => !p.is_commented_out),
      }));
      graphStore.addGroupNode(
        first.parentId,
        first.componentGroup,
        groupLabel,
        childData,
        first.isFeature,
      );
    } else {
      // Create individual nodes
      for (const item of items) {
        if (item.isFeature) {
          graphStore.addFeatureNode(item.parentId, item.sType, item.label, item.sec.full_header);
        } else if (SUB_COMPONENT_TYPES.has(item.sType)) {
          graphStore.addSubComponentNode(item.parentId, item.sType, item.label, item.sec.full_header);
        } else {
          graphStore.addSubComponentNode(item.parentId, item.sType, item.label, item.sec.full_header);
        }
      }
    }
  }
}

/**
 * Legacy single-file builder. Creates one mainboard per file.
 * Use buildProjectGraph() for multi-file imports.
 */
export function buildGraphFromConfig(
  config: ConfigFile,
  graphStore: GraphStore,
  schemas: Record<string, SectionSchema>,
): void {
  buildProjectGraph({ [config.filename]: config }, graphStore, schemas);
}
