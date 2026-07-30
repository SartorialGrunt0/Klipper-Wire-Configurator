import { create } from 'zustand';

const STORAGE_KEY = 'klipper-wire-ai-state';
const LEGACY_SETTINGS_KEY = 'klipper-wire-ai-settings';
const DEFAULT_PROVIDER: AiProvider = 'chatgpt';

export type AiProvider = 'google' | 'chatgpt' | 'anthropic' | 'github' | 'openai-compatible';
type ProviderModels = Partial<Record<AiProvider, string>>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  hiddenFromUser?: boolean;
  autoLoadedDocs?: string[];
  mcpToolNames?: string[];
}

export interface AiSettings {
  apiKey: string;
  model: string;
  providerModels: ProviderModels;
  apiUrl: string;
  apiProvider: AiProvider;
  host: string;
  port: string;
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

function persistState(settings: AiSettings, messages: ChatMessage[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, messages }));
  localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settings));
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
};

export const useAiStore = create<AiState>()((set, get) => {
  const persisted = loadPersistedState();

  return {
    settings: buildAiSettings(persisted.settings),
    messages: persisted.messages,
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
        persistState(newSettings, state.messages);
        return { settings: newSettings };
      }),
    setMessages: (messages) =>
      set((state) => {
        persistState(state.settings, messages);
        return { messages };
      }),
    clearMessages: () =>
      set((state) => {
        persistState(state.settings, []);
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
