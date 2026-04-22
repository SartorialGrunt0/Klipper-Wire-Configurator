/**
 * Builds React Flow graph nodes and edges from parsed Klipper ConfigFiles.
 *
 * Two entry points:
 * - buildGraphFromConfig(): legacy single-file builder (creates one mainboard per file)
 * - buildProjectGraph(): project-aware builder that takes ALL config files,
 *   detects MCUs across files, resolves includes, and builds a unified graph.
 */

import type { ConfigFile, ConfigSection, ConfigParam, SectionSchema, ValidationResult } from '../types/config';
import type { HardwareType, CommunicationType } from '../types/config';
import { getBoardTypeMarker } from './boardTypeMarker';

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
  'printer', 'mcu',
]);

// Section types that are features
const FEATURE_TYPES = new Set([
  'bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust',
  'bed_screws', 'bed_tilt', 'skew_correction', 'axis_twist_compensation',
  'safe_z_home', 'homing_override', 'endstop_phase',
  'input_shaper', 'resonance_tester',
  'virtual_sdcard', 'pause_resume', 'firmware_retraction', 'force_move',
  'idle_timeout', 'gcode_macro', 'delayed_gcode', 'gcode_arcs',
  'respond', 'exclude_object', 'save_variables', 'display_status',
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
  mcu: 'mcu',
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
  mcu: 'MCU',
  other: 'Other',
};

interface GroupChildData {
  sectionType: string;
  label: string;
  sectionHeader: string;
  sectionLineNumber: number;
  isFeature: boolean;
  params: ConfigParam[];
  configFile: string;
}

interface GraphStore {
  addHardwareNode: (type: HardwareType, label: string, configFile: string, position?: { x: number; y: number }, mcuName?: string) => string;
  addSubComponentNode: (parentId: string, sectionType: string, label: string, sectionHeader: string, configFile?: string, sectionLineNumber?: number) => string;
  addFeatureNode: (parentId: string, sectionType: string, label: string, sectionHeader: string, configFile?: string, sectionLineNumber?: number) => string;
  addGroupNode: (parentId: string, componentGroup: string, label: string, children: GroupChildData[], isFeature: boolean, configFile?: string) => string;
  addConfigurationEdge: (sourceId: string, targetId: string, hwType: HardwareType, sourceHandle?: string, targetHandle?: string) => string;
  addCommunicationEdge: (sourceId: string, targetId: string, commType: CommunicationType, sourceHandle?: string, targetHandle?: string, isNotIncluded?: boolean) => string;
  updateNodeData: (id: string, data: Record<string, unknown>) => void;
  toggleHardwareCollapse: (id: string) => void;
  autoArrange: () => void;
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
  /** Communication type detected from serial/canbus params */
  commType: CommunicationType;
  /** Whether this MCU section was fully commented out */
  isSuppressed: boolean;
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
 * Detect the communication type from MCU section parameters.
 */
function detectCommType(section: ConfigSection): CommunicationType {
  for (const param of section.params) {
    if (param.is_commented_out) continue;
    if (param.key === 'canbus_uuid' || param.key === 'canbus_interface') return 'canbus';
    if (param.key === 'serial') {
      const val = param.value;
      if (val.includes('/dev/serial/by-id/usb-')) return 'usb';
      if (val.match(/\/dev\/tty(S|AMA|ACM|USB)/)) return 'uart';
      if (val.includes('/tmp/klipper_host_mcu')) return 'usb'; // SBC host MCU, virtual
    }
  }
  return 'usb'; // default
}

/**
 * Check if a section is fully commented out (suppressed).
 * The backend parser marks these with a _commented_section param.
 */
function isSectionSuppressed(section: ConfigSection): boolean {
  if (section.is_commented_out) return true;
  const realParams = section.params.filter((p) => p.key !== '_comment_');
  return realParams.length > 0 && realParams.every((p) => p.is_commented_out);
}

/**
 * Check if a section explicitly declares its parent MCU via sensor_mcu or mcu parameter.
 * Pin prefixes (e.g. "EBBCan:gpio18") indicate which MCU's GPIO pins are used but do NOT
 * determine ownership — the section belongs to the config file it's defined in.
 * Returns the MCU name if found, or empty string for primary MCU / no match.
 */
function detectMcuReference(section: ConfigSection, mcuNames: string[]): string {
  for (const param of section.params) {
    if (param.is_commented_out) continue;

    // Only explicit MCU ownership params determine parent assignment
    if ((param.key === 'sensor_mcu' || param.key === 'mcu') && param.value) {
      const refMcu = mcuNames.find((n) => n && param.value.trim() === n);
      if (refMcu) return refMcu;
    }
  }
  return '';
}

/**
 * Determine the main config file from a set of files.
 * Priority: printer.cfg > file with most [include] directives > file with unnamed [mcu] > first file.
 */
/** Strip any leading path components and return just the basename. */
function basename(filename: string): string {
  return filename.replace(/^.*[\\/]/, '');
}

function findMainFile(configs: Record<string, ConfigFile>): string {
  const filenames = Object.keys(configs);
  // 1. printer.cfg always wins (match by basename in case browser adds a path prefix)
  const printerKey = filenames.find((fn) => basename(fn) === 'printer.cfg');
  if (printerKey) return printerKey;
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
 * 2. Always creates an SBC node (host)
 * 3. Creates one hardware node per MCU (not per file)
 * 4. Assigns each config file to its "owner" hardware node
 * 5. Creates include-based edges between hardware nodes
 * 6. Creates sub-component/feature nodes, assigning each to the correct
 *    hardware via pin prefix / sensor_mcu detection
 * 7. Marks suppressed (commented-out) sections
 * 8. Starts all hardware nodes collapsed
 */
export function buildProjectGraph(
  configs: Record<string, ConfigFile>,
  graphStore: GraphStore,
  schemas: Record<string, SectionSchema>,
  validations?: Record<string, ValidationResult>,
): void {
  const filenames = Object.keys(configs);
  if (filenames.length === 0) return;

  // Filter out files that have no recognized Klipper sections (e.g. moonraker, crowsnest)
  const RECOGNIZED_TYPES = new Set([...SUB_COMPONENT_TYPES, ...FEATURE_TYPES, 'mcu', 'include']);
  const recognizedConfigs: Record<string, ConfigFile> = {};
  for (const [fn, cfg] of Object.entries(configs)) {
    const hasRecognized = cfg.sections.some((s) => RECOGNIZED_TYPES.has(s.section_type));
    if (hasRecognized) {
      recognizedConfigs[fn] = cfg;
    }
  }
  // Replace configs with filtered set; use original if nothing passed the filter
  const activeConfigs = Object.keys(recognizedConfigs).length > 0 ? recognizedConfigs : configs;
  const activeFilenames = Object.keys(activeConfigs);

  // Build a set of section headers that have validation errors
  const sectionsWithErrors = new Set<string>();
  if (validations) {
    for (const v of Object.values(validations)) {
      for (const err of v.errors) {
        if (err.severity === 'error' && err.section) {
          sectionsWithErrors.add(err.section);
        }
      }
    }
  }

  const mainFile = findMainFile(activeConfigs);

  // Pre-compute included files set (files reachable from main config via active includes).
  // We store BASENAMES only so that path-prefixed filenames (from webkitdirectory uploads)
  // still match correctly.
  const mainConfig = activeConfigs[mainFile];
  const includedBasenames = new Set<string>([basename(mainFile)]);
  if (mainConfig) {
    for (const inc of mainConfig.includes) {
      includedBasenames.add(basename(inc));
    }
  }
  /** Returns true if the given filename is reachable from the main config. */
  const isIncluded = (filename: string): boolean => includedBasenames.has(basename(filename));

  // ── Phase 1: Discover all MCU sections across all files ──────────
  const mcuInfos: McuInfo[] = [];
  const mcuByName = new Map<string, McuInfo>(); // MCU name → info

  for (const [filename, config] of Object.entries(activeConfigs)) {
    for (const sec of config.sections) {
      if (sec.section_type !== 'mcu') continue;
      const name = sec.section_name || '';
      // Skip duplicates (same MCU defined in multiple files)
      if (mcuByName.has(name)) continue;
      const hwType = getBoardTypeMarker(sec.header_comments) || classifyMcuName(name);
      const commType = detectCommType(sec);
      const suppressed = isSectionSuppressed(sec);
      const info: McuInfo = {
        name,
        hwType,
        sourceFile: filename,
        nodeId: '', // filled in Phase 2
        commType,
        isSuppressed: suppressed,
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
      commType: 'usb',
      isSuppressed: false,
    });
    mcuByName.set('', mcuInfos[0]);
  }

  // Always ensure an SBC node exists
  const hasSbc = mcuInfos.some((m) => m.hwType === 'sbc');
  if (!hasSbc) {
    // Check if there's a host_mcu section that was classified as SBC
    const hostMcu = mcuByName.get('host_mcu');
    if (!hostMcu) {
      // Create a virtual SBC entry — it's always present as the Klipper host
      mcuInfos.push({
        name: 'host_mcu',
        hwType: 'sbc',
        sourceFile: mainFile,
        nodeId: '',
        commType: 'usb',
        isSuppressed: false,
      });
      mcuByName.set('host_mcu', mcuInfos[mcuInfos.length - 1]);
    }
  }

  // ── Phase 2: Create hardware nodes ───────────────────────────────
  // Place hardware nodes in a row with enough spacing to avoid overlap
  const HW_SPACING = 480; // wider than CONTAINER_WIDTH (400) + gap

  // Place SBC node to the left
  const sbcInfos = mcuInfos.filter((m) => m.hwType === 'sbc');
  const nonSbcInfos = mcuInfos.filter((m) => m.hwType !== 'sbc');

  for (let i = 0; i < sbcInfos.length; i++) {
    const mcu = sbcInfos[i];
    // Only label as the MCU name when [mcu host_mcu] with serial: /tmp/klipper_host_mcu is present
    const sbcMcuSection = activeConfigs[mcu.sourceFile]?.sections.find(
      (s) => s.section_type === 'mcu' && s.section_name === mcu.name,
    );
    const isActiveHostMcu = !!sbcMcuSection?.params.some(
      (p) => !p.is_commented_out && p.key === 'serial' && p.value.trim() === '/tmp/klipper_host_mcu',
    );
    const label = isActiveHostMcu ? mcu.name : 'SBC';
    const configFile = mcu.sourceFile;
    const x = 50 + i * HW_SPACING;
    mcu.nodeId = graphStore.addHardwareNode(mcu.hwType, label, configFile, { x, y: 100 }, mcu.name);
    // Mark as suppressed if the source file isn't reachable from printer.cfg
    if (!isIncluded(mcu.sourceFile) || mcu.isSuppressed) {
      graphStore.updateNodeData(mcu.nodeId, { isSuppressed: true });
    }
    // If this SBC has a real [mcu] section in its config, mark MCU-enabled
    if (sbcMcuSection) {
      graphStore.updateNodeData(mcu.nodeId, { isMcu: true });
    }
  }

  for (let i = 0; i < nonSbcInfos.length; i++) {
    const mcu = nonSbcInfos[i];
    const label = mcu.name || 'Mainboard';
    const configFile = mcu.sourceFile;
    const x = (sbcInfos.length > 0 ? 50 + sbcInfos.length * HW_SPACING : 50) + i * HW_SPACING;
    mcu.nodeId = graphStore.addHardwareNode(mcu.hwType, label, configFile, { x, y: 100 }, mcu.name);
    if (mcu.hwType === 'mainboard' && !mcu.name) {
      graphStore.updateNodeData(mcu.nodeId, { isPrimary: true });
    }
    // Mark as suppressed if the source file isn't reachable from printer.cfg
    if (!isIncluded(mcu.sourceFile) || mcu.isSuppressed) {
      graphStore.updateNodeData(mcu.nodeId, { isSuppressed: true });
    }
  }

  // ── Phase 3: Map files to owner hardware & create include edges ──
  const fileOwner = new Map<string, string>(); // filename → hardware nodeId

  // Primary MCU is the unnamed [mcu] or first non-SBC
  const primaryMcu = mcuByName.get('') || nonSbcInfos[0] || mcuInfos[0];
  const sbcMcu = sbcInfos[0];

  // First pass: files with MCU sections own themselves
  for (const mcu of mcuInfos) {
    if (mcu.hwType !== 'sbc' && !fileOwner.has(mcu.sourceFile)) {
      fileOwner.set(mcu.sourceFile, mcu.nodeId);
    }
  }

  // Second pass: resolve include-only files
  if (mainConfig) {
    for (const inc of mainConfig.includes) {
      const incFilename = inc.replace(/^.*[\\/]/, '');
      const matchedFile = activeFilenames.find(
        (fn) => fn === incFilename || fn === inc || fn.endsWith(`/${incFilename}`) || fn.endsWith(`\\${incFilename}`),
      );
      if (matchedFile && !fileOwner.has(matchedFile)) {
        fileOwner.set(matchedFile, primaryMcu.nodeId);
      }
    }
  }

  // Remaining unassigned files → primary MCU (not SBC)
  for (const fn of activeFilenames) {
    if (!fileOwner.has(fn)) {
      fileOwner.set(fn, primaryMcu.nodeId);
    }
  }

  // Create communication edges from SBC to each non-SBC hardware
  // Only show comm edges for MCUs that have actual config data imported
  if (sbcMcu) {
    for (const mcu of nonSbcInfos) {
      if (mcu.nodeId !== sbcMcu.nodeId) {
        // Only add comm edge if this MCU's source file was actually imported
        const hasConfigData = !!activeConfigs[mcu.sourceFile];
        if (hasConfigData) {
          // Mark as broken/not-included if the file isn't in printer.cfg's include chain
          // SBC is to the left of MCUs in initial layout → right / left
          graphStore.addCommunicationEdge(sbcMcu.nodeId, mcu.nodeId, mcu.commType, 'right', 'left', !isIncluded(mcu.sourceFile));
        }
      }
    }
  }

  // Create configuration edges between non-SBC hardware that have [include] relationships
  const allMcuNames = mcuInfos.map((m) => m.name);
  if (mainConfig) {
    for (const inc of mainConfig.includes) {
      const incFilename = inc.replace(/^.*[\\/]/, '');
      for (const mcu of mcuInfos) {
        if (mcu.hwType === 'sbc') continue; // SBC edges already handled above
        if (mcu.sourceFile === incFilename || mcu.sourceFile.endsWith(`/${incFilename}`)) {
          if (mcu.nodeId !== primaryMcu.nodeId) {
            // Secondary MCU is to the right of primary in initial layout → left / right
            graphStore.addConfigurationEdge(mcu.nodeId, primaryMcu.nodeId, mcu.hwType, 'left', 'right');
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
    isSuppressed: boolean;
    filename: string;
  }>> = new Map();

  for (const [filename, config] of Object.entries(activeConfigs)) {
    for (const sec of config.sections) {
      // MCU sections already created hardware nodes in Phase 2;
      // also create a sub-component node so they appear in the sidebar
      if (sec.section_type === 'mcu') {
        const mcuName = sec.section_name || '';
        const mcuInfo = mcuByName.get(mcuName);
        if (mcuInfo) {
          const displayName = schemas['mcu']?.display_name || 'MCU';
          const label = mcuName ? `${displayName}: ${mcuName}` : displayName;
          const suppressed = isSectionSuppressed(sec);
          const gKey = `${mcuInfo.nodeId}::mcu::sub`;
          if (!groupedSections.has(gKey)) groupedSections.set(gKey, []);
          groupedSections.get(gKey)!.push({
            sec, sType: 'mcu', label, parentId: mcuInfo.nodeId, isFeature: false,
            componentGroup: 'mcu', isSuppressed: suppressed, filename,
          });
        }
        continue;
      }

      const sType = sec.section_type;
      const suppressed = isSectionSuppressed(sec);

      // Include directives affect file relationships only; they should not create graph cards.
      if (sType === 'include') {
        continue;
      }

      // Build descriptive label: "Display Name: section_name"
      const displayName = schemas[sType]?.display_name || sType;
      const label = sec.section_name
        ? `${displayName}: ${sec.section_name}`
        : displayName;

      // Determine parent: check pin/sensor_mcu references to named MCUs first
      const referencedMcu = detectMcuReference(sec, allMcuNames);
      let parentId: string;
      if (referencedMcu) {
        const mcuInfo = mcuByName.get(referencedMcu);
        // If it references a SBC MCU (host_mcu), assign to the SBC node
        if (mcuInfo && mcuInfo.hwType === 'sbc') {
          parentId = mcuInfo.nodeId;
        } else if (mcuInfo) {
          parentId = mcuInfo.nodeId;
        } else {
          parentId = fileOwner.get(filename) || primaryMcu.nodeId;
        }
      } else {
        // No explicit MCU reference: use the file's owner (primary MCU for main file)
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
        sec, sType, label, parentId, isFeature, componentGroup, isSuppressed: suppressed, filename,
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
        sectionLineNumber: item.sec.line_number,
        isFeature: item.isFeature,
        isSuppressed: item.isSuppressed,
        params: item.sec.params.filter((p) => !p.is_commented_out),
        configFile: item.filename,
      }));
      const hasGroupErrors = items.some((item) => sectionsWithErrors.has(item.sec.full_header));
      const groupId = graphStore.addGroupNode(
        first.parentId,
        first.componentGroup,
        groupLabel,
        childData,
        first.isFeature,
        first.filename,
      );
      if (hasGroupErrors) {
        graphStore.updateNodeData(groupId, { hasErrors: true });
      }
    } else {
      // Create individual nodes
      for (const item of items) {
        let nodeId: string;
        if (item.isFeature) {
          nodeId = graphStore.addFeatureNode(item.parentId, item.sType, item.label, item.sec.full_header, item.filename, item.sec.line_number);
        } else if (SUB_COMPONENT_TYPES.has(item.sType)) {
          nodeId = graphStore.addSubComponentNode(item.parentId, item.sType, item.label, item.sec.full_header, item.filename, item.sec.line_number);
        } else {
          nodeId = graphStore.addSubComponentNode(item.parentId, item.sType, item.label, item.sec.full_header, item.filename, item.sec.line_number);
        }
        // Mark suppressed sections
        if (item.isSuppressed) {
          graphStore.updateNodeData(nodeId, { isSuppressed: true });
        }
        // Mark sections with validation errors
        if (sectionsWithErrors.has(item.sec.full_header)) {
          graphStore.updateNodeData(nodeId, { hasErrors: true });
        }
      }
    }
  }

  // ── Phase 5: Collapse all hardware nodes by default ──────────────
  for (const mcu of mcuInfos) {
    if (mcu.nodeId) {
      graphStore.toggleHardwareCollapse(mcu.nodeId);
    }
  }

  // ── Phase 6: Auto-arrange into radial layout ─────────────────────
  graphStore.autoArrange();
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
