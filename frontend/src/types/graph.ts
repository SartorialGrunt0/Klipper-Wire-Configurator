import type { Node, Edge } from '@xyflow/react';
import type { HardwareType, CommunicationType, ConfigSection, ConfigParam } from './config';

/* ── Custom Node Data ────────────────────────────────── */

export interface HardwareNodeData {
  label: string;
  hardwareType: HardwareType;
  configFile: string;
  mcuName: string;
  sections: ConfigSection[];
  customImage?: string;
  hasErrors: boolean;
  collapsed?: boolean;
  [key: string]: unknown;
}

export interface SubComponentNodeData {
  label: string;
  sectionType: string;
  sectionHeader: string;
  componentGroup: string;
  section: ConfigSection;
  parentHardwareId: string;
  configFile: string;
  customImage?: string;
  hasErrors: boolean;
  [key: string]: unknown;
}

export interface FeatureNodeData {
  label: string;
  sectionType: string;
  sectionHeader: string;
  section: ConfigSection;
  parentId: string;
  configFile: string;
  customImage?: string;
  hasErrors: boolean;
  [key: string]: unknown;
}

export interface GroupChildItem {
  sectionType: string;
  label: string;
  sectionHeader: string;
  isFeature: boolean;
  params: ConfigParam[];
  configFile: string;
}

export interface GroupNodeData {
  label: string;
  componentGroup: string;
  isFeature: boolean;
  children: GroupChildItem[];
  parentHardwareId: string;
  configFile: string;
  hasErrors: boolean;
  [key: string]: unknown;
}

export interface CustomGroupNodeData {
  label: string;
  color: string;
  collapsed?: boolean;
  hasErrors: boolean;
  [key: string]: unknown;
}

/* ── Custom Edge Data ────────────────────────────────── */

export interface CommunicationEdgeData {
  commType: CommunicationType;
  edgeType: 'communication';
  [key: string]: unknown;
}

export interface ConfigurationEdgeData {
  sourceHardwareType: HardwareType;
  edgeType: 'configuration';
  [key: string]: unknown;
}

/* ── Node/Edge Type Aliases ──────────────────────────── */

export type HardwareNode = Node<HardwareNodeData, 'hardware'>;
export type SubComponentNode = Node<SubComponentNodeData, 'subComponent'>;
export type FeatureNode = Node<FeatureNodeData, 'feature'>;
export type GroupNode = Node<GroupNodeData, 'group'>;
export type CustomGroupNode = Node<CustomGroupNodeData, 'customGroup'>;
export type AppNode = HardwareNode | SubComponentNode | FeatureNode | GroupNode | CustomGroupNode;

export type CommunicationEdge = Edge<CommunicationEdgeData>;
export type ConfigurationEdge = Edge<ConfigurationEdgeData>;
export type AppEdge = CommunicationEdge | ConfigurationEdge;
