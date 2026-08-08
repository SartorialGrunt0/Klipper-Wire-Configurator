/**
 * AI provider configuration and helpers.
 *
 * Extracted from chatUtils.ts (Phase 3 cleanup) — pure data, no React.
 */
import type { AiProvider } from '../stores/aiStore';

// ── Provider Configuration ──────────────────────────────────────────

export interface ProviderInfo {
  label: string;
  defaultUrl: string;
  requiresKey: boolean;
  defaultHost: string;
  defaultPort: string;
  defaultModel: string;
}

export const PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string }> = [
  { value: 'chatgpt', label: 'ChatGPT (OpenAI)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'github', label: 'GitHub Copilot' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
];

export const PROVIDER_DEFAULTS: Record<AiProvider, ProviderInfo> = {
  chatgpt: {
    label: 'ChatGPT (OpenAI)',
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gpt-4o',
  },
  google: {
    label: 'Google (Gemini)',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gemini-1.5-pro',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultUrl: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'claude-3-5-sonnet',
  },
  github: {
    label: 'GitHub Copilot',
    defaultUrl: 'https://models.github.ai/inference/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gpt-4o',
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    defaultUrl: 'http://localhost:11434/v1/chat/completions',
    requiresKey: false,
    defaultHost: 'localhost',
    defaultPort: '11434',
    defaultModel: 'gpt-4o',
  },
};

// ── Provider Helpers ────────────────────────────────────────────────

export const isLocalProvider = (provider: AiProvider): boolean =>
  provider === 'openai-compatible';

/** True when the URL points at a cloud (https) OpenAI-compatible API. */
export function isHttpsUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith('https://');
}

export function buildLocalProviderApiUrl(host: string, port: string): string {
  return `http://${host}:${port}/v1/chat/completions`;
}

export function resolveProviderApiUrl(
  provider: AiProvider,
  apiUrl: string,
  host: string,
  port: string,
): string {
  if (provider === 'openai-compatible') {
    // An explicit API URL wins (covers cloud OpenAI-compatible providers
    // like DeepSeek, OpenRouter, Groq). Host/port is only the quick local
    // entry path used when no URL has been entered yet.
    const trimmed = apiUrl.trim();
    if (trimmed) {
      return trimmed.replace(/\/+$/, '');
    }
    return buildLocalProviderApiUrl(host, port);
  }
  return apiUrl;
}

export function getProviderModel(
  provider: AiProvider,
  providerModels: Partial<Record<AiProvider, string>>,
  fallbackModel = '',
  fallbackProvider?: AiProvider,
): string {
  const providerModel = providerModels[provider]?.trim();
  if (providerModel) {
    return providerModel;
  }
  if (fallbackProvider === provider && fallbackModel.trim()) {
    return fallbackModel;
  }
  return '';
}
