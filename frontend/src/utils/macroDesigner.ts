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

function dedentLines(lines: string[]): string[] {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (!nonEmptyLines.length) return lines;

  const commonIndent = nonEmptyLines.reduce((smallestIndent, line) => {
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    return Math.min(smallestIndent, indent);
  }, Number.POSITIVE_INFINITY);

  if (!Number.isFinite(commonIndent) || commonIndent <= 0) return lines;
  return lines.map((line) => (line.trim().length ? line.slice(commonIndent) : ''));
}

export function normalizeMacroGcodeForEditor(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return normalized.startsWith('\n') ? normalized.slice(1) : normalized;
}

export function normalizeMacroGcodeForConfig(value: string): string {
  const stripped = stripLeadingGcodeDirective(value).replace(/\r\n?/g, '\n');
  const trimmed = stripped.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!trimmed) return '';
  const lines = dedentLines(trimmed.split('\n'));
  return `\n${lines.join('\n')}`;
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

function parsePair(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1]];
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
    for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
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
      .filter((section) => section.section_type === 'gcode_macro')
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
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const homeX = isRound ? 0 : asNumber(getParamValue(stepperX, 'position_endstop'), minX);
  const homeY = isRound ? 0 : asNumber(getParamValue(stepperY, 'position_endstop'), minY);
  const homeZ = asNumber(getParamValue(stepperZ, 'position_endstop'), minZ);

  const probeSection = sections.find((section) => ['probe', 'bltouch', 'smart_effector', 'probe_eddy_current'].includes(section.section_type));
  const extruder = sections.find((section) => section.section_type === 'extruder');
  const heaterBed = sections.find((section) => section.section_type === 'heater_bed');
  const bedMesh = sections.find((section) => section.section_type === 'bed_mesh');
  const zTilt = sections.find((section) => section.section_type === 'z_tilt');
  const quadGantryLevel = sections.find((section) => section.section_type === 'quad_gantry_level');
  const screwsTiltAdjust = sections.find((section) => section.section_type === 'screws_tilt_adjust');
  const bedScrews = sections.find((section) => section.section_type === 'bed_screws');
  const bedTilt = sections.find((section) => section.section_type === 'bed_tilt');

  const meshMin = parsePair(getParamValue(bedMesh, 'mesh_min'));
  const meshMax = parsePair(getParamValue(bedMesh, 'mesh_max'));
  const probeCount = parsePair(getParamValue(bedMesh, 'probe_count'));

  const featurePoints: Record<string, SimulationPoint[]> = {
    BED_MESH_CALIBRATE: meshMin && meshMax && probeCount
      ? interpolateMeshPoints(meshMin, meshMax, probeCount)
      : [],
    Z_TILT_ADJUST: parsePoints(getParamValue(zTilt, 'points')),
    QUAD_GANTRY_LEVEL: parsePoints(getParamValue(quadGantryLevel, 'points')),
    SCREWS_TILT_CALCULATE: parseScrewPoints(screwsTiltAdjust),
    BED_SCREWS_ADJUST: parseScrewPoints(bedScrews),
    BED_TILT_CALIBRATE: parsePoints(getParamValue(bedTilt, 'points')),
    PROBE: [{ x: centerX, y: centerY, label: 'Probe' }],
    PROBE_ACCURACY: [{ x: centerX, y: centerY, label: 'Probe' }],
    PROBE_CALIBRATE: [{ x: centerX, y: centerY, label: 'Probe' }],
  };

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
    probeOffsetX: asNumber(getParamValue(probeSection, 'x_offset'), 0),
    probeOffsetY: asNumber(getParamValue(probeSection, 'y_offset'), 0),
    nozzleMaxTemp: asNumber(getParamValue(extruder, 'max_temp'), 350),
    bedMaxTemp: asNumber(getParamValue(heaterBed, 'max_temp'), 130),
    maxVelocity: asNumber(getParamValue(printer, 'max_velocity'), 300),
    maxAccel: asNumber(getParamValue(printer, 'max_accel'), 3000),
    noGoZones,
    dockPosition,
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