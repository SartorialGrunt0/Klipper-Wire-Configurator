/**
 * Build the credential block every /ai/chat request carries.
 *
 * Live report 2026-09-27 (V2.6.3, ApplyDialog "AI Analyze"): the toolbar
 * opens ChatDialog and submits the hidden analysis prompt in the SAME
 * render pass that flips `open` to true. ChatDialog keeps a panel-local
 * mirror of the AI settings (`editApiKey` …) that is only synced by the
 * open-effect — which runs in that same pass but whose state updates are
 * not visible to effects further down the flush. The pending-request
 * effect therefore submitted with the MIRROR'S MOUNT-TIME values: when
 * the async `loadState()` fetch lost the race against the first render,
 * those were the built-in defaults (provider 'chatgpt', empty key), and
 * the backend answered "AI settings not configured" even though the user
 * had a configured local provider.
 *
 * The fix: request credentials are store truth, read fresh at submit
 * time — never the panel mirror. The mirror exists for the settings-form
 * (typed-but-unsaved edits); a send must use what the user actually
 * saved.
 */
import type { AiSettings } from '../stores/aiStore';
import { resolveProviderApiUrl } from './chatProviders';

export interface ChatRequestCredentials {
  apiKey: string;
  model: string;
  apiUrl: string;
  apiProvider: AiSettings['apiProvider'];
  requestId: string;
  maxTokens: number;
  temperature: number;
  toolProtocol: AiSettings['toolProtocol'];
}

/** Same clamp the request path has always used: floor 256, default 4096. */
export function clampMaxTokens(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Math.max(256, Number.isNaN(parsed) ? 4096 : parsed);
}

/** Clamp a temperature to the provider-valid 0-2 range; 0.7 default. */
export function clampTemperature(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (Number.isNaN(parsed)) return 0.7;
  return Math.min(2, Math.max(0, parsed));
}

/**
 * Snapshot the committed store settings into a request-credentials block.
 * apiUrl is resolved exactly like the panel does (explicit URL wins for
 * openai-compatible; host/port is the local quick-entry fallback).
 */
export function buildChatRequestCredentials(
  settings: AiSettings,
  requestId: string,
): ChatRequestCredentials {
  return {
    apiKey: settings.apiKey,
    model: settings.model,
    apiUrl: resolveProviderApiUrl(settings.apiProvider, settings.apiUrl, settings.host, settings.port),
    apiProvider: settings.apiProvider,
    requestId,
    maxTokens: clampMaxTokens(settings.maxTokens),
    temperature: clampTemperature(settings.temperature),
    toolProtocol: settings.toolProtocol ?? 'auto',
  };
}
