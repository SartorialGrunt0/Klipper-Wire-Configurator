import type {
  ConfigFile,
  ConfigSection,
  ValidationResult,
  BoardInfo,
  ExampleConfig,
  SectionSchema,
} from '../types/config';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || '/api';

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

export async function validateConfig(config: ConfigFile): Promise<ValidationResult> {
  return request('/validate', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export async function acknowledgeWarning(section: ConfigSection): Promise<{ status: string; file: string }> {
  return request('/warning-acknowledgements', {
    method: 'POST',
    body: JSON.stringify({ section }),
  });
}

/* ── Export ───────────────────────────────────────────── */

export async function exportConfig(config: ConfigFile): Promise<string> {
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

/** Client-side fuzzy match — mirrors backend logic, used when API unavailable. */
function _fuzzyMatchStatic(query: string, examples: ExampleConfig[]): ExampleConfig[] {
  const qLower = query.toLowerCase();
  const parts = qLower.split(/\s+/).filter(Boolean);
  const scored: [number, ExampleConfig][] = [];
  for (const ex of examples) {
    let score = 0;
    const n = ex.name.toLowerCase();
    const tags = ex.tags.map((t) => t.toLowerCase());
    if (qLower === n) {
      score += 100;
    } else if (n.includes(qLower)) {
      score += 50;
    } else {
      const all = n + ' ' + tags.join(' ');
      const hits = parts.filter((p) => all.includes(p)).length;
      if (hits > 0) score += (hits / parts.length) * 30;
    }
    for (const p of parts) for (const t of tags) {
      if (t.includes(p)) score += 5;
      if (t === p) score += 10;
    }
    if (score > 0) scored.push([score, ex]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 100).map(([, ex]) => ex);
}

let _staticExamples: ExampleConfig[] | null = null;
async function _loadStaticExamples(): Promise<ExampleConfig[]> {
  if (_staticExamples) return _staticExamples;
  const res = await fetch('/reference/examples.json');
  if (!res.ok) throw new Error('Static examples unavailable');
  const data = await res.json() as { examples: ExampleConfig[] };
  _staticExamples = data.examples;
  return _staticExamples;
}

export async function listExamples(): Promise<{ examples: ExampleConfig[] }> {
  try {
    return await request('/examples');
  } catch {
    const examples = await _loadStaticExamples();
    return { examples };
  }
}

export async function searchExamples(q: string): Promise<{ results: ExampleConfig[] }> {
  try {
    return await request(`/examples/search?q=${encodeURIComponent(q)}`);
  } catch {
    const examples = await _loadStaticExamples();
    return { results: q.trim() ? _fuzzyMatchStatic(q, examples) : examples };
  }
}

export async function getExample(filename: string): Promise<{
  config: ConfigFile;
  raw_text: string;
}> {
  return request(`/examples/${encodeURIComponent(filename)}`);
}

/* ── Schema ──────────────────────────────────────────── */

export async function getSchema(): Promise<{ schemas: Record<string, SectionSchema> }> {
  try {
    return await request('/schema');
  } catch {
    const res = await fetch('/reference/schema.json');
    if (!res.ok) throw new Error('Static schema unavailable');
    return res.json() as Promise<{ schemas: Record<string, SectionSchema> }>;
  }
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

/* ── Native (Pi) API ─────────────────────────────────── */

export interface NativeStatus {
  native: boolean;
  config_path: string;
}

export interface DeviceList {
  usb_serial: Array<{ path: string; description: string; by_id: string }>;
  can: Array<{ name: string; state: string; bitrate: number | null }>;
  uart: Array<{ path: string; description: string; by_id: string }>;
}

export interface CanbusQueryResult {
  uuids: string[];
  interface: string;
  error: string | null;
}

export interface NativeConfigFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export async function getNativeStatus(): Promise<NativeStatus> {
  return request('/native/status');
}

export async function listNativeDevices(): Promise<DeviceList> {
  return request('/native/devices');
}

export async function queryCanbusUuids(iface = 'can0'): Promise<CanbusQueryResult> {
  return request(`/native/canbus-uuids?interface=${encodeURIComponent(iface)}`);
}

export async function getNativeSettings(): Promise<{ config_path: string }> {
  return request('/native/settings');
}

export async function updateNativeSettings(configPath: string): Promise<{ config_path: string }> {
  return request('/native/settings', {
    method: 'PUT',
    body: JSON.stringify({ config_path: configPath }),
  });
}

export async function listNativeConfigFiles(path?: string): Promise<{
  config_path: string;
  files: NativeConfigFile[];
}> {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/native/config-files${q}`);
}

export async function readNativeConfigFiles(
  filenames: string[],
  configPath?: string,
): Promise<{
  files: Record<string, {
    config: ConfigFile;
    validation: ValidationResult;
    board_info: BoardInfo;
    raw_text: string;
  }>;
  project: {
    main_file: string;
    mcus: Array<{ name: string; file: string; params: Record<string, string> }>;
    includes: Array<{ path: string; resolved: boolean; filename: string | null }>;
    file_count: number;
  };
}> {
  return request('/native/config-files/read', {
    method: 'POST',
    body: JSON.stringify({ filenames, config_path: configPath }),
  });
}

export async function applyNativeConfig(
  files: Record<string, string>,
  configPath?: string,
): Promise<{ status: string; files: string[]; config_path: string }> {
  return request('/native/apply', {
    method: 'POST',
    body: JSON.stringify({ files, config_path: configPath }),
  });
}

export async function firmwareRestartKlipper(): Promise<{
  status: string;
  method: string;
  socket_path: string;
}> {
  return request('/native/klipper/firmware-restart', {
    method: 'POST',
  });
}

export interface KlipperStatusResponse {
  status: string;
  socket_path: string;
  state: string;
  state_message: string;
  recent_errors: string[];
  log_path: string | null;
}

export async function getKlipperStatus(): Promise<KlipperStatusResponse> {
  return request('/native/klipper/status');
}

export async function loadNativeLayout(): Promise<{ layout: unknown | null }> {
  return request('/native/layout');
}

export async function saveNativeLayout(layout: unknown): Promise<{ status: string }> {
  return request('/native/layout', {
    method: 'POST',
    body: JSON.stringify({ layout }),
  });
}

export async function deleteNativeLayout(): Promise<{ status: string }> {
  return request('/native/layout', {
    method: 'DELETE',
  });
}
