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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as T;
  }

  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error(
      'The frontend received HTML instead of JSON from the backend. '
      + 'This usually means the backend service is older than the frontend bundle or the firmware API route is missing. '
      + 'Update and restart the backend service, then refresh the page.',
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid API response from ${url}`);
  }
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

export async function validateProject(
  configFiles: Record<string, ConfigFile>,
): Promise<Record<string, ValidationResult>> {
  const result = await request<{ files: Record<string, ValidationResult> }>('/validate-project', {
    method: 'POST',
    body: JSON.stringify({ config_files: Object.values(configFiles) }),
  });
  return result.files;
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

export async function getConfigReference(): Promise<{ content: string }> {
  return request('/reference/config-reference');
}

export interface KlipperDocResponse {
  filename: string;
  content: string;
}

export async function getKlipperDoc(filename: string): Promise<KlipperDocResponse> {
  return request(`/reference/klipper-docs/${encodeURIComponent(filename)}`);
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

export async function saveConfigsToLocal(
  files: Record<string, string>,
): Promise<{ saved: string[]; file_count: number; errors?: string[] }> {
  return request('/configs/save', {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
}


export async function loadSavedConfigs(): Promise<ProjectImportResult> {
  return request('/project/load-saved');
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
  is_printing: boolean;
  print_state: string | null;
  print_filename: string | null;
}

export async function getKlipperStatus(): Promise<KlipperStatusResponse> {
  return request('/native/klipper/status');
}

export interface KlippyLogExcerptResponse {
  status: string;
  log_path: string | null;
  excerpt: string;
  matched_on: string | null;
}

export async function getKlippyLogExcerpt(
  sectionName?: string,
  errorText?: string,
  contextLines = 40,
): Promise<KlippyLogExcerptResponse> {
  return request('/native/klipper/log-excerpt', {
    method: 'POST',
    body: JSON.stringify({
      section_name: sectionName ?? null,
      error_text: errorText ?? null,
      context_lines: contextLines,
    }),
  });
}

export type FlashTargetKey = 'klipper' | 'katapult';

export interface NativeFlashArtifact {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface NativeFlashDeviceCandidate {
  value: string;
  label: string;
  transport?: 'serial' | 'usb_id' | 'can_uuid' | 'mass_storage';
  interface?: string;
  preferred_flash_method?: string;
}

export interface NativeFlashProfileAssignment {
  symbol: string;
  value: string;
}

export interface NativeFlashProfileSummary {
  name: string;
  target: FlashTargetKey;
  checkout_path: string;
  flash_device: string;
  flash_method: string;
  assignment_count: number;
  created: number;
  modified: number;
}

export interface NativeFlashProfile {
  name: string;
  target: FlashTargetKey;
  checkout_path: string;
  flash_device: string;
  flash_method: string;
  assignments: NativeFlashProfileAssignment[];
  created: number;
  modified: number;
}

export interface NativeFlashArtifactDeleteResult {
  status: string;
  target: FlashTargetKey;
  display_name: string;
  filename: string;
  checkout_path: string;
  out_path: string;
  artifacts: NativeFlashArtifact[];
  primary_artifact: NativeFlashArtifact | null;
}

export interface NativeFlashMethodCandidate {
  value: string;
  label: string;
  description: string;
  supported: boolean;
  reason: string | null;
  device_required: boolean;
  device_placeholder: string;
  default_device: string;
  help: string;
}

export interface NativeFlashChoiceOption {
  symbol: string;
  prompt: string;
  selected: boolean;
}

export interface NativeFlashField {
  id: string;
  kind: 'bool' | 'tristate' | 'string' | 'int' | 'hex' | 'choice';
  symbol: string | null;
  prompt: string;
  value: string;
  help: string;
  menu_path: string[];
  assignable: string[];
  options?: NativeFlashChoiceOption[];
}

export interface NativeFlashState {
  target: FlashTargetKey;
  display_name: string;
  available: boolean;
  error: string | null;
  checkout_path: string;
  config_path: string;
  out_path: string;
  config_exists: boolean;
  fields: NativeFlashField[];
  artifacts: NativeFlashArtifact[];
  primary_artifact: NativeFlashArtifact | null;
  flash_supported: boolean;
  flash_reason: string | null;
  flash_device_required: boolean;
  flash_device_placeholder: string;
  default_flash_device: string;
  flash_device_candidates: NativeFlashDeviceCandidate[];
  flash_method_candidates: NativeFlashMethodCandidate[];
  default_flash_method: string;
  flash_help: string;
}

export interface NativeFlashCommandResult {
  target: FlashTargetKey;
  display_name: string;
  success: boolean;
  error: string | null;
  log: string;
  checkout_path: string;
  out_path: string;
  artifacts: NativeFlashArtifact[];
  primary_artifact: NativeFlashArtifact | null;
  flash_device: string;
  flash_method: string;
}

export type NativeFirmwareArtifact = NativeFlashArtifact;
export type NativeFirmwareChoiceOption = NativeFlashChoiceOption;
export type NativeFirmwareField = NativeFlashField;
export type NativeFirmwareState = NativeFlashState;
export type NativeFirmwareBuildResult = NativeFlashCommandResult;

export async function getNativeFlashState(
  target: FlashTargetKey,
  checkoutPath?: string,
): Promise<NativeFlashState> {
  const q = checkoutPath ? `?checkout_path=${encodeURIComponent(checkoutPath)}` : '';
  return request(`/native/flash/${encodeURIComponent(target)}${q}`);
}

export interface NativeFlashDeviceScanResult {
  target: FlashTargetKey;
  candidates: NativeFlashDeviceCandidate[];
  error: string | null;
  cached: boolean;
}

export async function scanNativeFlashDevices(
  target: FlashTargetKey,
  checkoutPath?: string,
  forceRefresh = false,
): Promise<NativeFlashDeviceScanResult> {
  const params = new URLSearchParams();
  if (checkoutPath) {
    params.set('checkout_path', checkoutPath);
  }
  if (forceRefresh) {
    params.set('force_refresh', 'true');
  }
  const q = params.toString() ? `?${params.toString()}` : '';
  return request(`/native/flash/${encodeURIComponent(target)}/scan-devices${q}`);
}

export async function previewNativeFlashConfig(
  target: FlashTargetKey,
  assignments: Array<{ symbol: string; value: string }>,
  checkoutPath?: string,
): Promise<NativeFlashState> {
  return request(`/native/flash/${encodeURIComponent(target)}/preview`, {
    method: 'POST',
    body: JSON.stringify({ assignments, checkout_path: checkoutPath }),
  });
}

export async function updateNativeFlashConfig(
  target: FlashTargetKey,
  assignments: Array<{ symbol: string; value: string }>,
  checkoutPath?: string,
): Promise<NativeFlashState> {
  return request(`/native/flash/${encodeURIComponent(target)}/config`, {
    method: 'PUT',
    body: JSON.stringify({ assignments, checkout_path: checkoutPath }),
  });
}

export async function buildNativeFlashTarget(
  target: FlashTargetKey,
  checkoutPath?: string,
): Promise<NativeFlashCommandResult> {
  return request(`/native/flash/${encodeURIComponent(target)}/build`, {
    method: 'POST',
    body: JSON.stringify({ checkout_path: checkoutPath }),
  });
}

export async function flashNativeFlashTarget(
  target: FlashTargetKey,
  checkoutPath?: string,
  flashDevice?: string,
  flashMethod?: string,
): Promise<NativeFlashCommandResult> {
  return request(`/native/flash/${encodeURIComponent(target)}/flash`, {
    method: 'POST',
    body: JSON.stringify({ checkout_path: checkoutPath, flash_device: flashDevice, flash_method: flashMethod }),
  });
}

export async function downloadNativeFlashArtifact(
  target: FlashTargetKey,
  filename: string,
  checkoutPath?: string,
): Promise<Blob> {
  const q = checkoutPath ? `?checkout_path=${encodeURIComponent(checkoutPath)}` : '';
  const res = await fetch(
    `${BASE_URL}/native/flash/${encodeURIComponent(target)}/artifacts/${encodeURIComponent(filename)}${q}`,
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Artifact download failed: ${err}`);
  }
  return res.blob();
}

export async function deleteNativeFlashArtifact(
  target: FlashTargetKey,
  filename: string,
  checkoutPath?: string,
): Promise<NativeFlashArtifactDeleteResult> {
  const q = checkoutPath ? `?checkout_path=${encodeURIComponent(checkoutPath)}` : '';
  return request(`/native/flash/${encodeURIComponent(target)}/artifacts/${encodeURIComponent(filename)}${q}`, {
    method: 'DELETE',
  });
}

export async function listNativeFlashProfiles(target: FlashTargetKey): Promise<NativeFlashProfileSummary[]> {
  const result = await request<{ profiles: NativeFlashProfileSummary[] }>(`/native/flash/${encodeURIComponent(target)}/profiles`);
  return result.profiles;
}

export async function loadNativeFlashProfile(target: FlashTargetKey, name: string): Promise<NativeFlashProfile> {
  return request(`/native/flash/${encodeURIComponent(target)}/profiles/${encodeURIComponent(name)}`);
}

export async function saveNativeFlashProfile(
  target: FlashTargetKey,
  profile: {
    name: string;
    checkoutPath?: string;
    flashDevice?: string;
    flashMethod?: string;
    assignments: NativeFlashProfileAssignment[];
  },
): Promise<NativeFlashProfile> {
  return request(`/native/flash/${encodeURIComponent(target)}/profiles`, {
    method: 'POST',
    body: JSON.stringify({
      name: profile.name,
      checkout_path: profile.checkoutPath,
      flash_device: profile.flashDevice,
      flash_method: profile.flashMethod,
      assignments: profile.assignments,
    }),
  });
}

export async function deleteNativeFlashProfile(target: FlashTargetKey, name: string): Promise<{ status: string; name: string }> {
  return request(`/native/flash/${encodeURIComponent(target)}/profiles/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function getNativeFirmwareState(klipperPath?: string): Promise<NativeFirmwareState> {
  return getNativeFlashState('klipper', klipperPath);
}

export async function updateNativeFirmwareConfig(
  assignments: Array<{ symbol: string; value: string }>,
  klipperPath?: string,
): Promise<NativeFirmwareState> {
  return updateNativeFlashConfig('klipper', assignments, klipperPath);
}

export async function buildNativeFirmware(klipperPath?: string): Promise<NativeFirmwareBuildResult> {
  return buildNativeFlashTarget('klipper', klipperPath);
}

export async function downloadNativeFirmwareArtifact(
  filename: string,
  klipperPath?: string,
): Promise<Blob> {
  return downloadNativeFlashArtifact('klipper', filename, klipperPath);
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



/* ── AI Chat ─────────────────────────────────────────── */

export type AiChatRole = 'system' | 'user' | 'assistant';

export interface AiChatRequest {
  messages: Array<{ role: AiChatRole; content: string }>;
  apiKey: string;
  model?: string;
  apiUrl?: string;
  apiProvider?: string;
  /** Client-generated id used to signal a user-initiated stop. */
  requestId?: string;
  /** Maximum number of tokens the provider should generate. */
  maxTokens?: number;
  /** Sampling temperature for the provider (0-2). Omit for provider default. */
  temperature?: number;
}

export interface AiChatResponse {
  content?: string;
  error?: string;
  stopped?: boolean;
  mcpToolTurns?: number;
  mcpToolNames?: string[];
}

/**
 * Thrown when the user presses Stop and the backend confirms cancellation
 * (or the client-side AbortController fires).
 */
export class ChatStoppedError extends Error {
  constructor() {
    super('Chat stopped by user.');
    this.name = 'ChatStoppedError';
  }
}

export async function listLocalModels(
  apiUrl: string,
  apiKey: string = '',
): Promise<string[]> {
  /**
   * List available models from a local OpenAI-compatible server.
   */
  try {
    const modelsUrl = new URL(apiUrl);
    modelsUrl.pathname = '/v1/models';
    
    const params = new URLSearchParams();
    if (apiKey && apiKey.trim()) params.set('apiKey', apiKey);
    
    const res = await fetch(`${modelsUrl.toString()}?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m: any) => m.id);
      }
    }
    
    return [];
  } catch (error) {
    console.error('Failed to list local models:', error);
    return [];
  }
}

export async function aiChat(req: AiChatRequest, signal?: AbortSignal): Promise<AiChatResponse> {
  const res = await fetch('/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(`AI chat failed: ${res.statusText}`);
  const data = (await res.json()) as AiChatResponse;
  if (data.stopped) throw new ChatStoppedError();
  return data;
}

/**
 * Best-effort request to cancel an in-flight /ai/chat call.
 * The client-side AbortController already stops the UI wait; this tells
 * the backend to stop spending provider calls / tool work.
 */
export async function stopChat(requestId: string): Promise<void> {
  try {
    await fetch('/ai/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  } catch {
    // Best-effort only — ignore network failures here.
  }
}
