/* ── Config Types ─────────────────────────────────────── */

export interface ConfigParam {
  key: string;
  value: string;
  comment: string;
  is_commented_out: boolean;
  separator?: string;
}

export interface ConfigSection {
  section_type: string;
  section_name: string;
  full_header: string;
  line_number: number;
  params: ConfigParam[];
  header_comments: string[];
  trailing_comments?: string[];
  is_commented_out?: boolean;
  /**
   * Frontend-only: per-param `is_commented_out` state captured when the
   * section was suppressed, so unsuppressing restores individually-commented
   * params instead of enabling everything. Ignored by the backend (Pydantic
   * drops unknown fields) and never written to config text.
   */
  suppressedParams?: Record<string, boolean>;
}

export interface ConfigFile {
  filename: string;
  sections: ConfigSection[];
  includes: string[];
  header_comments: string[];
  raw_text?: string;
}

/* ── Validation Types ────────────────────────────────── */

export interface ValidationError {
  severity: 'error' | 'warning' | 'info';
  section: string;
  param: string;
  message: string;
  line_number: number;
  /**
   * Stable machine-facing identity for error classes the frontend branches on
   * (retry-exempt, acknowledge gate, Jinja repair derivation). Optional —
   * only set where a consumer needs it. Never branch UI logic on `message`
   * text; use this instead so backend rewording can't silently break it.
   */
  code?: string;
}

export interface ValidationResult {
  has_errors: boolean;
  has_warnings: boolean;
  errors: ValidationError[];
}

/* ── Schema Types ────────────────────────────────────── */

export interface ParamSchema {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'pin' | 'enum' | 'multi_line';
  required: boolean;
  default: string | null;
  description: string;
  enum_values: string[];
  unit: string;
}

export interface SectionSchema {
  section_type: string;
  display_name: string;
  category: 'hardware' | 'sub_component' | 'feature' | 'config_helper';
  component_group: string;
  is_named: boolean;
  description: string;
  max_instances: number;
  requires: string[];
  params: ParamSchema[];
}

/* ── Board Detection ─────────────────────────────────── */

export interface BoardInfo {
  board_name: string;
  mcu_chip: string;
  confidence: number;
  matches: string[];
}

/* ── Example Configs ─────────────────────────────────── */

export interface ExampleConfig {
  filename: string;
  name: string;
  category: 'example' | 'generic' | 'printer' | 'sample' | 'kit' | 'other';
  board_type?: HardwareType;
  tags: string[];
  path?: string;
}

/* ── Hardware Component Types ────────────────────────── */

export type HardwareType =
  | 'sbc'
  | 'mainboard'
  | 'expander'
  | 'toolhead'
  | 'config_file'
  | 'probe'
  | 'accelerometer'
  | 'other';

export type CommunicationType = 'usb' | 'canbus' | 'uart';

export type EdgeType = 'communication' | 'configuration';
