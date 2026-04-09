/* ── Config Types ─────────────────────────────────────── */

export interface ConfigParam {
  key: string;
  value: string;
  comment: string;
  is_commented_out: boolean;
}

export interface ConfigSection {
  section_type: string;
  section_name: string;
  full_header: string;
  line_number: number;
  params: ConfigParam[];
  header_comments: string[];
}

export interface ConfigFile {
  filename: string;
  sections: ConfigSection[];
  includes: string[];
  header_comments: string[];
}

/* ── Validation Types ────────────────────────────────── */

export interface ValidationError {
  severity: 'error' | 'warning' | 'info';
  section: string;
  param: string;
  message: string;
  line_number: number;
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
  tags: string[];
  path: string;
}

/* ── Hardware Component Types ────────────────────────── */

export type HardwareType =
  | 'sbc'
  | 'mainboard'
  | 'expander'
  | 'toolhead'
  | 'probe'
  | 'accelerometer'
  | 'other';

export type CommunicationType = 'usb' | 'canbus' | 'uart';

export type EdgeType = 'communication' | 'configuration';
