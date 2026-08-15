/**
 * Shared graph color maps and hardware geometry styles.
 *
 * Single source of truth for node/edge coloring. Previously duplicated
 * across HardwareNode, FeatureNode, SubComponentNode, GroupNode,
 * ConfigurationEdge, CommunicationEdge, and graphStore.
 */

/** Hardware type → node fill color (CSS variables, theme-aware) */
export const HARDWARE_COLORS: Record<string, string> = {
  sbc: 'var(--color-sbc)',
  mainboard: 'var(--color-mainboard)',
  toolhead: 'var(--color-toolhead)',
  expander: 'var(--color-expander)',
  config_file: '#0f766e',
  probe: 'var(--color-probe)',
  accelerometer: 'var(--color-accelerometer)',
  other: 'var(--color-other)',
};

/** Hardware type → border radius shape */
export const HARDWARE_SHAPES: Record<string, string> = {
  sbc: 'rounded-xl',
  mainboard: 'rounded-lg',
  toolhead: 'rounded-2xl',
  expander: 'rounded-lg',
  config_file: 'rounded-md',
  probe: 'rounded-xl',
  accelerometer: 'rounded-lg',
  other: 'rounded-md',
};

/** Group node component-group colors (feature-bearing groups) */
export const GROUP_NODE_COLORS: Record<string, string> = {
  stepper: '#3b82f6',
  stepper_driver: '#6366f1',
  extruder: '#f97316',
  heater: '#ef4444',
  fan: '#06b6d4',
  probe: '#ec4899',
  temperature: '#f59e0b',
  accelerometer: '#84cc16',
  led: '#a855f7',
  servo: '#14b8a6',
  pin: '#64748b',
  display: '#8b5cf6',
  filament_sensor: '#d946ef',
  gcode_macro: '#22c55e',
  bed_leveling: '#8b5cf6',
  homing: '#ec4899',
  resonance: '#f59e0b',
  other: '#6b7280',
};

/** Sub-component node component-group colors (hardware child tiles) */
export const SUBCOMPONENT_COLORS: Record<string, string> = {
  stepper: '#3b82f6',
  stepper_driver: '#6366f1',
  extruder: '#f97316',
  heater: '#ef4444',
  fan: '#06b6d4',
  probe: '#ec4899',
  temperature: '#f59e0b',
  accelerometer: '#84cc16',
  led: '#a855f7',
  servo: '#14b8a6',
  pin: '#64748b',
  display: '#8b5cf6',
  filament_sensor: '#d946ef',
  sensor: '#0ea5e9',
  mcu: '#22c55e',
  other: '#6b7280',
};

/** Feature section-type colors */
export const FEATURE_COLORS: Record<string, string> = {
  bed_mesh: '#8b5cf6',
  z_tilt: '#6366f1',
  quad_gantry_level: '#6366f1',
  skew_correction: '#a78bfa',
  input_shaper: '#f59e0b',
  resonance_tester: '#f59e0b',
  firmware_retraction: '#f97316',
  pressure_advance: '#f97316',
  gcode_macro: '#22c55e',
  idle_timeout: '#64748b',
  save_variables: '#64748b',
  virtual_sdcard: '#64748b',
  pause_resume: '#06b6d4',
  respond: '#06b6d4',
  exclude_object: '#06b6d4',
  force_move: '#ef4444',
  homing_override: '#ec4899',
  safe_z_home: '#ec4899',
  endstop_phase: '#3b82f6',
  default: '#6b7280',
};

/** Communication type → edge color */
export const COMM_COLORS: Record<string, string> = {
  usb: 'var(--color-usb)',
  canbus: 'var(--color-canbus)',
  uart: 'var(--color-uart)',
};

/** Communication type → display label */
export const COMM_LABELS: Record<string, string> = {
  usb: 'USB',
  canbus: 'CAN',
  uart: 'UART',
};

/** Communication type → expanded description */
export const COMM_DESCRIPTIONS: Record<string, string> = {
  usb: 'Universal Serial Bus',
  canbus: 'Controller Area Network',
  uart: 'Universal Async Receiver/Transmitter',
};

/**
 * Hardware type → fixed hex edge color (used when stamping edge data at
 * creation time, so the color survives graph rebuilds without node lookup).
 */
export const HARDWARE_HEX_COLORS: Record<string, string> = {
  sbc: '#22c55e',
  mainboard: '#38bdf8',
  toolhead: '#f472b6',
  expander: '#a78bfa',
  config_file: '#0f766e',
  probe: '#ec4899',
  accelerometer: '#84cc16',
  other: '#64748b',
};

export function getHardwareHexColor(hwType: string): string {
  return HARDWARE_HEX_COLORS[hwType] || HARDWARE_HEX_COLORS.other;
}
