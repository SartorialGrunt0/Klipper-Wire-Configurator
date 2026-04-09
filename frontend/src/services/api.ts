import type {
  ConfigFile,
  ValidationResult,
  BoardInfo,
  ExampleConfig,
  SectionSchema,
} from '../types/config';

const BASE_URL = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  return res.json();
}

/* ── Import ──────────────────────────────────────────── */

export async function importConfig(file: File): Promise<{
  config: ConfigFile;
  validation: ValidationResult;
  board_info: BoardInfo;
}> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE_URL}/import`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Import failed: ${res.statusText}`);
  return res.json();
}

export interface ProjectImportResult {
  files: Record<string, {
    config: ConfigFile;
    validation: ValidationResult;
    board_info: BoardInfo;
  }>;
  project: {
    main_file: string;
    mcus: Array<{ name: string; file: string; params: Record<string, string> }>;
    includes: Array<{ path: string; resolved: boolean; filename: string | null }>;
    file_count: number;
  };
}

export async function importProject(files: File[]): Promise<ProjectImportResult> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  const res = await fetch(`${BASE_URL}/import-project`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Project import failed: ${res.statusText}`);
  return res.json();
}

export async function parseConfigText(
  text: string,
  filename = 'printer.cfg',
): Promise<{ config: ConfigFile; validation: ValidationResult }> {
  return request('/parse', {
    method: 'POST',
    body: JSON.stringify({ text, filename }),
  });
}

/* ── Validate ────────────────────────────────────────── */

export async function validateConfig(config: {
  filename: string;
  sections: Array<{
    full_header: string;
    section_type: string;
    section_name?: string;
    params: Array<{ key: string; value: string; is_commented_out?: boolean }>;
  }>;
  includes?: string[];
  header_comments?: string[];
}): Promise<ValidationResult> {
  return request('/validate', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

/* ── Export ───────────────────────────────────────────── */

export async function exportConfig(config: {
  filename: string;
  sections: Array<{
    full_header: string;
    section_type: string;
    section_name?: string;
    params: Array<{ key: string; value: string; is_commented_out?: boolean }>;
  }>;
  includes?: string[];
  header_comments?: string[];
}): Promise<string> {
  const res = await fetch(`${BASE_URL}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
  return res.text();
}

export async function exportProject(project: unknown): Promise<{ files: Record<string, string> }> {
  return request('/export-project', {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
}

/* ── Generate ────────────────────────────────────────── */

export async function generateConfig(opts: {
  template?: string;
  kinematics?: string;
  board_name?: string;
}): Promise<{ config: ConfigFile; validation: ValidationResult }> {
  return request('/generate', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

/* ── Examples ────────────────────────────────────────── */

export async function listExamples(): Promise<{ examples: ExampleConfig[] }> {
  return request('/examples');
}

export async function searchExamples(q: string): Promise<{ results: ExampleConfig[] }> {
  return request(`/examples/search?q=${encodeURIComponent(q)}`);
}

export async function getExample(filename: string): Promise<{
  config: ConfigFile;
  raw_text: string;
}> {
  return request(`/examples/${encodeURIComponent(filename)}`);
}

/* ── Schema ──────────────────────────────────────────── */

export async function getSchema(): Promise<{ schemas: Record<string, SectionSchema> }> {
  return request('/schema');
}

export async function getSectionSchema(sectionType: string): Promise<SectionSchema> {
  return request(`/schema/${encodeURIComponent(sectionType)}`);
}

/* ── Projects ────────────────────────────────────────── */

export async function saveProject(data: unknown): Promise<{ status: string; name: string }> {
  return request('/projects/save', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listProjects(): Promise<{
  projects: Array<{ name: string; files: string[]; has_layout: boolean }>;
}> {
  return request('/projects');
}

export async function loadProject(name: string): Promise<{
  name: string;
  configs: Record<string, ConfigFile>;
  layout: unknown;
}> {
  return request(`/projects/${encodeURIComponent(name)}`);
}
