import type { ConfigFile, ConfigParam, ConfigSection } from '../types/config';
import type {
  BuiltInMacroDefinition,
  DockPosition,
  MachineProfile,
  MacroSourceItem,
  NoGoZone,
  SimulationPoint,
} from '../types/macroDesigner';

const DELTA_KINEMATICS = new Set(['delta', 'rotary_delta']);
const SPECIAL_MACRO_PARAM_KEYS = new Set(['gcode', 'rename_existing', 'description']);

export const BUILT_IN_MACROS: BuiltInMacroDefinition[] = [
  {
    id: 'quad_gantry_level',
    title: 'QGL',
    command: 'QUAD_GANTRY_LEVEL',
    requiredSections: ['quad_gantry_level'],
    description: 'Run quad gantry leveling using the configured probe points.',
  },
  {
    id: 'bed_mesh',
    title: 'Bed Mesh',
    command: 'BED_MESH_CALIBRATE',
    requiredSections: ['bed_mesh'],
    description: 'Probe the bed mesh using the saved bed_mesh section.',
  },
  {
    id: 'z_tilt',
    title: 'Z Tilt',
    command: 'Z_TILT_ADJUST',
    requiredSections: ['z_tilt'],
    description: 'Adjust multiple Z motors using the configured Z tilt probe points.',
  },
  {
    id: 'screws_tilt_adjust',
    title: 'Screws Tilt Adjust',
    command: 'SCREWS_TILT_CALCULATE',
    requiredSections: ['screws_tilt_adjust'],
    description: 'Calculate bed screw adjustments using the configured probe locations.',
  },
  {
    id: 'bed_screws',
    title: 'Bed Screws',
    command: 'BED_SCREWS_ADJUST',
    requiredSections: ['bed_screws'],
    description: 'Walk through configured bed screw locations.',
  },
  {
    id: 'bed_tilt',
    title: 'Bed Tilt',
    command: 'BED_TILT_CALIBRATE',
    requiredSections: ['bed_tilt'],
    description: 'Run bed tilt calibration using configured probe points.',
  },
  {
    id: 'axis_twist_compensation',
    title: 'Axis Twist',
    command: 'AXIS_TWIST_COMPENSATION_CALIBRATE',
    requiredSections: ['axis_twist_compensation'],
    description: 'Calibrate axis twist compensation for a configured axis.',
  },
  {
    id: 'probe',
    title: 'Probe',
    command: 'PROBE',
    requiredSections: ['probe'],
    description: 'Run a single probe cycle using the configured probe offsets.',
  },
  {
    id: 'probe_accuracy',
    title: 'Probe Accuracy',
    command: 'PROBE_ACCURACY',
    requiredSections: ['probe'],
    description: 'Measure probe repeatability using the current probe setup.',
  },
  {
    id: 'probe_calibrate',
    title: 'Probe Calibrate',
    command: 'PROBE_CALIBRATE',
    requiredSections: ['probe'],
    description: 'Calibrate probe Z offset using the current probe setup.',
  },
  {
    id: 'delta_calibrate',
    title: 'Delta Calibrate',
    command: 'DELTA_CALIBRATE',
    requiredSections: ['delta_calibrate'],
    description: 'Calibrate delta parameters by probing seven points on the bed.',
  },
];

function getSections(configFiles: Record<string, ConfigFile>): ConfigSection[] {
  return Object.values(configFiles).flatMap((file) => file.sections);
}

function getParam(section: ConfigSection | undefined, key: string): ConfigParam | undefined {
  return section?.params.find((param) => param.key === key && !param.is_commented_out);
}

function getParamValue(section: ConfigSection | undefined, key: string): string | undefined {
  return getParam(section, key)?.value;
}

function formatMacroParam(param: ConfigParam): string {
  if (param.key === '_comment_') return param.value;
  const prefix = param.is_commented_out ? '#' : '';
  const separator = param.separator === '=' ? ' = ' : ': ';
  return `${prefix}${param.key}${separator}${param.value}`;
}

function stripLeadingGcodeDirective(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*gcode\s*:\s*(?:\n|$)/i);
  if (!match) return normalized;
  return normalized.slice(match[0].length);
}

export function normalizeMacroGcodeForEditor(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return normalized.startsWith('\n') ? normalized.slice(1) : normalized;
}

export function parseMacroGcodeFromEditorView(value: string): string {
  return normalizeMacroGcodeForEditor(stripLeadingGcodeDirective(value));
}

export function formatMacroGcodeForEditorView(value: string): string {
  const body = parseMacroGcodeFromEditorView(value).replace(/\n+$/, '');
  return body ? `gcode:\n${body}` : 'gcode:\n';
}

export function normalizeMacroGcodeForConfig(value: string): string {
  const stripped = stripLeadingGcodeDirective(value).replace(/\r\n?/g, '\n');
  const trimmed = stripped.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!trimmed) return '';
  return `\n${trimmed}`;
}

export function serializeMacroVariables(section: ConfigSection): string {
  return section.params
    .filter((param) => !SPECIAL_MACRO_PARAM_KEYS.has(param.key))
    .map((param) => formatMacroParam(param))
    .join('\n');
}

export function parseMacroVariables(value: string): ConfigParam[] {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .reduce<ConfigParam[]>((params, rawLine) => {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        params.push({ key: '_comment_', value: '', comment: '', is_commented_out: false });
        return params;
      }

      const commentedMatch = line.match(/^#\s*(\w[\w]*)\s*([:=])\s*(.*)$/);
      if (commentedMatch) {
        params.push({
          key: commentedMatch[1],
          value: commentedMatch[3],
          comment: '',
          is_commented_out: true,
          separator: commentedMatch[2],
        });
        return params;
      }

      const match = line.match(/^(\w[\w]*)\s*([:=])\s*(.*)$/);
      if (match) {
        params.push({
          key: match[1],
          value: match[3],
          comment: '',
          is_commented_out: false,
          separator: match[2],
        });
        return params;
      }

      params.push({ key: '_comment_', value: line, comment: '', is_commented_out: false });
      return params;
    }, []);
}

function asNumber(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asOptionalNumber(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAxesList(value: string | undefined): Array<'X' | 'Y' | 'Z'> {
  const matches = value?.toUpperCase().match(/[XYZ]/g) || [];
  return Array.from(new Set(matches)) as Array<'X' | 'Y' | 'Z'>;
}

function parsePair(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1]];
}

/**
 * Parse a probe_count value which may be either a comma-separated pair (e.g. "5, 3")
 * or a single integer that applies to both axes (e.g. "5" means 5x5).
 * probe_count must be a positive integer, so zero and negative values are rejected.
 */
function parseProbeCount(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.includes(',')) return parsePair(trimmed);
  const single = Number(trimmed);
  return Number.isFinite(single) && single > 0 ? [single, single] : null;
}

function parsePoints(value: string | undefined): SimulationPoint[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<SimulationPoint[]>((points, line, index) => {
      const pair = parsePair(line);
      if (!pair) return points;
      points.push({ x: pair[0], y: pair[1], label: `P${index + 1}` });
      return points;
    }, []);
}

function parseScrewPoints(section: ConfigSection | undefined): SimulationPoint[] {
  if (!section) return [];
  const points: SimulationPoint[] = [];
  for (let index = 1; index <= 8; index += 1) {
    const value = getParamValue(section, `screw${index}`);
    const pair = parsePair(value);
    if (pair) {
      const label = getParamValue(section, `screw${index}_name`) || `S${index}`;
      points.push({ x: pair[0], y: pair[1], label });
    }
  }
  return points;
}

function interpolateMeshPoints(meshMin: [number, number], meshMax: [number, number], probeCount: [number, number]): SimulationPoint[] {
  const xCount = Math.max(1, Math.round(probeCount[0]));
  const yCount = Math.max(1, Math.round(probeCount[1]));
  const points: SimulationPoint[] = [];
  for (let yIndex = 0; yIndex < yCount; yIndex += 1) {
    const y = yCount === 1
      ? meshMin[1]
      : meshMin[1] + ((meshMax[1] - meshMin[1]) * yIndex) / (yCount - 1);
    // Klipper probes in boustrophedon (serpentine) order: odd rows are reversed
    const reversed = yIndex % 2 !== 0;
    for (let i = 0; i < xCount; i += 1) {
      const xIndex = reversed ? (xCount - 1 - i) : i;
      const x = xCount === 1
        ? meshMin[0]
        : meshMin[0] + ((meshMax[0] - meshMin[0]) * xIndex) / (xCount - 1);
      points.push({ x, y, label: `${xIndex + 1},${yIndex + 1}` });
    }
  }
  return points;
}

export function deriveCurrentMacroItems(configFiles: Record<string, ConfigFile>): MacroSourceItem[] {
  return Object.entries(configFiles).flatMap(([filename, config]) => (
    config.sections
      .filter((section) => section.section_type === 'gcode_macro' && !section.is_commented_out)
      .map((section) => ({
        key: `config:${filename}:${section.full_header}`,
        source: 'config' as const,
        title: section.section_name || section.full_header.replace(/^gcode_macro\s+/i, ''),
        renameExisting: getParamValue(section, 'rename_existing') || '',
        description: getParamValue(section, 'description') || '',
        variables: serializeMacroVariables(section),
        gcode: normalizeMacroGcodeForEditor(getParamValue(section, 'gcode') || ''),
        sourceFile: filename,
        sourceHeader: section.full_header,
      }))
  ));
}

export function deriveAvailableBuiltInMacros(configFiles: Record<string, ConfigFile>): MacroSourceItem[] {
  const sectionTypes = new Set(getSections(configFiles).map((section) => section.section_type));
  const hasAnyProbe = ['probe', 'bltouch', 'smart_effector', 'probe_eddy_current'].some((type) => sectionTypes.has(type));
  return BUILT_IN_MACROS.filter((definition) => (
    definition.requiredSections.every((required) => (
      required === 'probe' ? hasAnyProbe : sectionTypes.has(required)
    ))
  )).map((definition) => ({
    key: `builtin:${definition.id}`,
    source: 'builtin' as const,
    title: definition.title,
    renameExisting: '',
    description: definition.description,
    variables: '',
    gcode: definition.command,
    readOnly: true,
  }));
}

export function fuzzyFilterItems<T extends { title: string; gcode?: string; description?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const parts = q.split(/\s+/).filter(Boolean);
  return items
    .map((item) => {
      const haystack = `${item.title} ${item.gcode || ''} ${item.description || ''}`.toLowerCase();
      let score = 0;
      if (item.title.toLowerCase() === q) score += 120;
      if (item.title.toLowerCase().includes(q)) score += 60;
      if (haystack.includes(q)) score += 25;
      for (const part of parts) {
        if (item.title.toLowerCase().includes(part)) score += 15;
        if (haystack.includes(part)) score += 5;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

export function sanitizeMacroName(name: string): string {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '_') || 'NEW_MACRO';
}

function generateDeltaCalibrationPoints(bedRadius: number, cx: number, cy: number): SimulationPoint[] {
  const probeRadius = bedRadius * 0.7071;
  const points: SimulationPoint[] = [{ x: cx, y: cy, label: 'Center' }];
  for (let i = 0; i < 6; i += 1) {
    const angle = (i * 60) * Math.PI / 180;
    points.push({
      x: Math.round((cx + probeRadius * Math.cos(angle)) * 100) / 100,
      y: Math.round((cy + probeRadius * Math.sin(angle)) * 100) / 100,
      label: `T${i + 1}`,
    });
  }
  return points;
}

export function createMachineProfile(
  configFiles: Record<string, ConfigFile>,
  noGoZones: NoGoZone[],
  dockPosition: DockPosition | null,
): MachineProfile {
  const sections = getSections(configFiles);
  const printer = sections.find((section) => section.section_type === 'printer');
  const kinematics = (getParamValue(printer, 'kinematics') || 'cartesian').trim().toLowerCase();
  const isRound = DELTA_KINEMATICS.has(kinematics);

  const stepperX = sections.find((section) => section.section_type === 'stepper_x');
  const stepperY = sections.find((section) => section.section_type === 'stepper_y');
  const stepperZ = sections.find((section) => section.section_type === 'stepper_z');

  const posMinX = isRound ? -(asNumber(getParamValue(printer, 'print_radius'), asNumber(getParamValue(printer, 'delta_radius'), 100))) : asNumber(getParamValue(stepperX, 'position_min'), 0);
  const posMaxX = isRound ? asNumber(getParamValue(printer, 'print_radius'), asNumber(getParamValue(printer, 'delta_radius'), 100)) : asNumber(getParamValue(stepperX, 'position_max'), 200);
  const posMinY = isRound ? posMinX : asNumber(getParamValue(stepperY, 'position_min'), 0);
  const posMaxY = isRound ? posMaxX : asNumber(getParamValue(stepperY, 'position_max'), 200);
  const minZ = asNumber(getParamValue(stepperZ, 'position_min'), 0);
  const maxZ = asNumber(getParamValue(stepperZ, 'position_max'), isRound ? 250 : 200);

  const moveMinX = posMinX;
  const moveMaxX = posMaxX;
  const moveMinY = posMinY;
  const moveMaxY = posMaxY;

  const minX = isRound ? posMinX : Math.max(0, posMinX);
  const maxX = posMaxX;
  const minY = isRound ? posMinY : Math.max(0, posMinY);
  const maxY = posMaxY;

  const radius = isRound ? Math.max(Math.abs(posMinX), Math.abs(posMaxX), Math.abs(posMinY), Math.abs(posMaxY)) : null;
  const centerX = isRound ? (minX + maxX) / 2 : (moveMinX + moveMaxX) / 2;
  const centerY = isRound ? (minY + maxY) / 2 : (moveMinY + moveMaxY) / 2;
  const homeX = isRound ? 0 : asNumber(getParamValue(stepperX, 'position_endstop'), moveMinX);
  const homeY = isRound ? 0 : asNumber(getParamValue(stepperY, 'position_endstop'), moveMinY);
  const homeZ = asNumber(getParamValue(stepperZ, 'position_endstop'), minZ);

  const probeSection = sections.find((section) => ['probe', 'bltouch', 'smart_effector', 'probe_eddy_current'].includes(section.section_type));
  const probeSpeed = Math.max(0.1, asNumber(getParamValue(probeSection, 'speed'), 5));
  const configuredProbeLiftSpeed = asOptionalNumber(getParamValue(probeSection, 'lift_speed'));
  const probeLiftSpeed = configuredProbeLiftSpeed !== null && configuredProbeLiftSpeed > 0
    ? configuredProbeLiftSpeed
    : probeSpeed;
  const extruder = sections.find((section) => section.section_type === 'extruder');
  const heaterBed = sections.find((section) => section.section_type === 'heater_bed');
  const bedMesh = sections.find((section) => section.section_type === 'bed_mesh');
  const zTilt = sections.find((section) => section.section_type === 'z_tilt');
  const quadGantryLevel = sections.find((section) => section.section_type === 'quad_gantry_level');
  const screwsTiltAdjust = sections.find((section) => section.section_type === 'screws_tilt_adjust');
  const bedScrews = sections.find((section) => section.section_type === 'bed_screws');
  const bedTilt = sections.find((section) => section.section_type === 'bed_tilt');
  const deltaCalibrate = sections.find((section) => section.section_type === 'delta_calibrate');
  const homingOverride = sections.find((section) => section.section_type === 'homing_override');

  const meshMin = parsePair(getParamValue(bedMesh, 'mesh_min'));
  const meshMax = parsePair(getParamValue(bedMesh, 'mesh_max'));
  const probeCount = parseProbeCount(getParamValue(bedMesh, 'probe_count'));

  const featurePoints: Record<string, SimulationPoint[]> = {
    BED_MESH_CALIBRATE: meshMin && meshMax && probeCount
      ? interpolateMeshPoints(meshMin, meshMax, probeCount)
      : [],
    Z_TILT_ADJUST: parsePoints(getParamValue(zTilt, 'points')),
    QUAD_GANTRY_LEVEL: parsePoints(getParamValue(quadGantryLevel, 'points')),
    SCREWS_TILT_CALCULATE: parseScrewPoints(screwsTiltAdjust),
    BED_SCREWS_ADJUST: parseScrewPoints(bedScrews),
    BED_TILT_CALIBRATE: parsePoints(getParamValue(bedTilt, 'points')),
    DELTA_CALIBRATE: deltaCalibrate && isRound && radius
      ? generateDeltaCalibrationPoints(radius, centerX, centerY)
      : [],
  };

  const homingOverrideGcode = normalizeMacroGcodeForEditor(getParamValue(homingOverride, 'gcode') || '');
  const homingOverrideAxes = parseAxesList(getParamValue(homingOverride, 'axes'));
  const homingOverrideSetPosition: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
  const setPositionX = asOptionalNumber(getParamValue(homingOverride, 'set_position_x'));
  const setPositionY = asOptionalNumber(getParamValue(homingOverride, 'set_position_y'));
  const setPositionZ = asOptionalNumber(getParamValue(homingOverride, 'set_position_z'));
  if (setPositionX !== null) homingOverrideSetPosition.X = setPositionX;
  if (setPositionY !== null) homingOverrideSetPosition.Y = setPositionY;
  if (setPositionZ !== null) homingOverrideSetPosition.Z = setPositionZ;

  const homingOverrideConfig = homingOverrideGcode
    ? {
        axes: homingOverrideAxes.length ? homingOverrideAxes : (['X', 'Y', 'Z'] as Array<'X' | 'Y' | 'Z'>),
        setPosition: homingOverrideSetPosition,
        gcode: homingOverrideGcode,
      }
    : null;

  return {
    shape: isRound ? 'round' : 'rect',
    kinematics,
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    moveMinX,
    moveMaxX,
    moveMinY,
    moveMaxY,
    centerX,
    centerY,
    radius,
    homeX,
    homeY,
    homeZ,
    hasProbe: Boolean(probeSection),
    probeOffsetX: asNumber(getParamValue(probeSection, 'x_offset'), 0),
    probeOffsetY: asNumber(getParamValue(probeSection, 'y_offset'), 0),
    probeSamples: Math.max(1, Math.round(asNumber(getParamValue(probeSection, 'samples'), 1))),
    probeSpeed,
    probeLiftSpeed,
    probeSampleRetractDist: Math.max(0, asNumber(getParamValue(probeSection, 'sample_retract_dist'), 2)),
    horizontalMoveZ: asNumber(getParamValue(bedMesh, 'horizontal_move_z'), 5),
    nozzleMaxTemp: asNumber(getParamValue(extruder, 'max_temp'), 350),
    bedMaxTemp: asNumber(getParamValue(heaterBed, 'max_temp'), 130),
    maxVelocity: asNumber(getParamValue(printer, 'max_velocity'), 300),
    maxAccel: asNumber(getParamValue(printer, 'max_accel'), 3000),
    noGoZones,
    dockPosition,
    homingOverride: homingOverrideConfig,
    featurePoints,
  };
}

export function isPointInBounds(profile: MachineProfile, x: number, y: number): boolean {
  if (profile.shape === 'round' && profile.radius !== null) {
    const dx = x - profile.centerX;
    const dy = y - profile.centerY;
    if (Math.sqrt(dx * dx + dy * dy) > profile.radius) return false;
  }
  return x >= profile.minX && x <= profile.maxX && y >= profile.minY && y <= profile.maxY;
}

export function isPointInMoveBounds(profile: MachineProfile, x: number, y: number): boolean {
  if (profile.shape === 'round' && profile.radius !== null) {
    const dx = x - profile.centerX;
    const dy = y - profile.centerY;
    if (Math.sqrt(dx * dx + dy * dy) > profile.radius) return false;
  }
  return x >= profile.moveMinX && x <= profile.moveMaxX && y >= profile.moveMinY && y <= profile.moveMaxY;
}

export function findZoneHit(profile: MachineProfile, x: number, y: number): NoGoZone | null {
  return profile.noGoZones.find((zone) => {
    return x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height;
  }) || null;
}

function lineSegmentIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tMin = 0;
  let tMax = 1;
  const edges = [
    { p: -dx, q: x1 - rx },
    { p: dx, q: rx + rw - x1 },
    { p: -dy, q: y1 - ry },
    { p: dy, q: ry + rh - y1 },
  ];
  for (const { p, q } of edges) {
    if (Math.abs(p) < 1e-10) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        tMin = Math.max(tMin, t);
      } else {
        tMax = Math.min(tMax, t);
      }
      if (tMin > tMax) return false;
    }
  }
  return true;
}

export function findPathZoneHit(
  profile: MachineProfile,
  x1: number, y1: number,
  x2: number, y2: number,
): NoGoZone | null {
  return profile.noGoZones.find((zone) =>
    lineSegmentIntersectsRect(x1, y1, x2, y2, zone.x, zone.y, zone.width, zone.height)
  ) || null;
}
