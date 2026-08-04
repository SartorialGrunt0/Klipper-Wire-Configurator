import { create } from 'zustand';
import { loadAiState, saveAiState, type AiToolCallDetail } from '../services/api';

const STORAGE_KEY = 'klipper-wire-ai-state';
const LEGACY_SETTINGS_KEY = 'klipper-wire-ai-settings';
const DEFAULT_PROVIDER: AiProvider = 'chatgpt';

export type AiProvider = 'google' | 'chatgpt' | 'anthropic' | 'github' | 'openai-compatible';
type ProviderModels = Partial<Record<AiProvider, string>>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  hiddenFromUser?: boolean;
  mcpToolNames?: string[];
  /** Executed tool calls with arguments + output, in execution order. */
  toolCalls?: AiToolCallDetail[];
  /** Number of macro sections whose trailing Jinja closers were auto-appended. */
  repairCount?: number;
  /** Number of retries the reply pipeline performed before accepting. */
  retryCount?: number;
  /** Number of backend empty-response re-prompts for this reply. */
  repromptCount?: number;
}

export interface AiSettings {
  apiKey: string;
  model: string;
  providerModels: ProviderModels;
  apiUrl: string;
  apiProvider: AiProvider;
  host: string;
  port: string;
  /** Maximum tokens the AI is allowed to generate per response. */
  maxTokens: number;
  /** Sampling temperature for AI responses (0-2; 0.7 default). */
  temperature: number;
}

interface PersistedAiState {
  settings?: Partial<AiSettings>;
  messages?: ChatMessage[];
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<ChatMessage>;
  return (
    (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
  );
}

function loadPersistedState(): { settings: Partial<AiSettings>; messages: ChatMessage[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedAiState | Partial<AiSettings>;
      if (parsed && typeof parsed === 'object' && ('settings' in parsed || 'messages' in parsed)) {
        const persisted = parsed as PersistedAiState;
        return {
          settings: persisted.settings ?? {},
          messages: Array.isArray(persisted.messages) ? persisted.messages.filter(isChatMessage) : [],
        };
      }
      return {
        settings: parsed as Partial<AiSettings>,
        messages: [],
      };
    }

    const legacyRaw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacyRaw) {
      return {
        settings: JSON.parse(legacyRaw) as Partial<AiSettings>,
        messages: [],
      };
    }
  } catch {}

  return {
    settings: {},
    messages: [],
  };
}

function validateToolCallDetail(value: unknown): value is AiToolCallDetail {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<AiToolCallDetail>;
  return typeof call.name === 'string' && typeof call.arguments === 'string' && typeof call.output === 'string';
}

// Debounced save to the backend file. Chat updates can be bursty (validation
// retries append several messages quickly), so coalesce writes to one POST.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: { settings: AiSettings; messages: ChatMessage[] } | null = null;

function schedulePersistState(state: { settings: AiSettings; messages: ChatMessage[] }): void {
  pendingState = state;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toSave = pendingState;
    pendingState = null;
    if (toSave) {
      void saveAiState({ settings: toSave.settings, messages: toSave.messages });
    }
  }, 400);
}

const DEFAULT_PROVIDER_MODELS: ProviderModels = {
  chatgpt: 'gpt-4o',
  google: '',
  anthropic: '',
  github: '',
  'openai-compatible': 'gpt-4o',

};

function normalizeProviderModels(settings: Partial<AiSettings>): ProviderModels {
  const mergedProviderModels: ProviderModels = {
    ...DEFAULT_PROVIDER_MODELS,
    ...(settings.providerModels ?? {}),
  };
  const activeProvider = settings.apiProvider ?? DEFAULT_PROVIDER;
  const activeModel = typeof settings.model === 'string' ? settings.model.trim() : '';

  if (activeModel && !mergedProviderModels[activeProvider]?.trim()) {
    mergedProviderModels[activeProvider] = activeModel;
  }

  return mergedProviderModels;
}

function buildAiSettings(settings: Partial<AiSettings>): AiSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const providerModels = normalizeProviderModels(merged);
  const modelToUse = providerModels[merged.apiProvider] ?? DEFAULT_PROVIDER_MODELS[merged.apiProvider] ?? '';
  return {
    ...merged,
    providerModels,
    model: modelToUse,
  };
}

export function providerRequiresApiKey(provider: AiProvider): boolean {
  // Only cloud providers require API keys
  return provider === 'chatgpt' || provider === 'google' || provider === 'anthropic' || provider === 'github';
}

interface AiState {
  settings: AiSettings;
  messages: ChatMessage[];
  /** Load AI settings + messages from the backend file (migrating localStorage). */
  loadState: () => Promise<void>;
  setSettings: (settings: Partial<AiSettings>) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  isConfigured: () => boolean;
}

const DEFAULT_SETTINGS: AiSettings = {
  apiKey: '',
  model: 'gpt-4o',
  providerModels: { ...DEFAULT_PROVIDER_MODELS },
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiProvider: DEFAULT_PROVIDER,
  host: 'localhost',
  port: '11434',
  maxTokens: 4096,
  temperature: 0.7,
};

export const useAiStore = create<AiState>()((set, get) => {
  const persisted = loadPersistedState();

  return {
    settings: buildAiSettings(persisted.settings),
    messages: persisted.messages,
    loadState: async () => {
      const file = await loadAiState();
      const fileSettings = file?.settings && typeof file.settings === 'object'
        ? (file.settings as Partial<AiSettings>)
        : {};
      const fileMessages = Array.isArray(file?.messages)
        ? file.messages.filter(isChatMessage)
        : null;

      // Prefer the backend file; fall back to what localStorage seeded.
      const hasFileSettings = Object.keys(fileSettings).length > 0;
      const hasFileMessages = fileMessages !== null && fileMessages.length > 0;
      if (!hasFileSettings && !hasFileMessages) return;

      set((state) => {
        const nextMessages = fileMessages ?? state.messages;
        const nextSettings = hasFileSettings
          ? buildAiSettings(fileSettings)
          : state.settings;
        // Persist the migrated seed so the backend file becomes the source.
        schedulePersistState({ settings: nextSettings, messages: nextMessages });
        return { settings: nextSettings, messages: nextMessages };
      });
    },
    setSettings: (partial) =>
      set((state) => {
        const nextProvider = partial.apiProvider ?? state.settings.apiProvider;
        const nextProviderModels: ProviderModels = {
          ...state.settings.providerModels,
          ...(partial.providerModels ?? {}),
        };

        if (typeof partial.model === 'string') {
          nextProviderModels[nextProvider] = partial.model;
        }

        const newSettings = buildAiSettings({
          ...state.settings,
          ...partial,
          apiProvider: nextProvider,
          providerModels: nextProviderModels,
        });
        schedulePersistState({ settings: newSettings, messages: state.messages });
        return { settings: newSettings };
      }),
    setMessages: (messages) =>
      set((state) => {
        schedulePersistState({ settings: state.settings, messages });
        return { messages };
      }),
    clearMessages: () =>
      set((state) => {
        schedulePersistState({ settings: state.settings, messages: [] });
        return { messages: [] };
      }),
    isConfigured: () => {
      const s = get().settings;
      if (!s.model.trim()) {
        return false;
      }
      if (!providerRequiresApiKey(s.apiProvider)) {
        return true;
      }
      return !!s.apiKey.trim();
    },
  };
});
