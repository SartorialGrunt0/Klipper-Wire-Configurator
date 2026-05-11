import { create } from 'zustand';

const STORAGE_KEY = 'klipper-wire-ai-state';
const LEGACY_SETTINGS_KEY = 'klipper-wire-ai-settings';

export type AiProvider = 'google' | 'chatgpt' | 'anthropic' | 'github' | 'openai-compatible' | 'lm-studio' | 'ollama';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiSettings {
  apiKey: string;
  model: string;
  apiUrl: string;
  apiProvider: AiProvider;
  lmStudioHost: string;
  lmStudioPort: string;
  ollamaHost: string;
  ollamaPort: string;
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
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiProvider: 'chatgpt',
  lmStudioHost: 'localhost',
  lmStudioPort: '1234',
  ollamaHost: 'localhost',
  ollamaPort: '11434',
};

export const useAiStore = create<AiState>()((set, get) => {
  const persisted = loadPersistedState();

  return {
    settings: { ...DEFAULT_SETTINGS, ...persisted.settings },
    messages: persisted.messages,
    setSettings: (partial) =>
      set((state) => {
        const newSettings = { ...state.settings, ...partial };
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
      // Local providers (LM Studio, Ollama) don't require an API key
      if (s.apiProvider === 'lm-studio' || s.apiProvider === 'ollama') {
        return true;
      }
      return !!s.apiKey.trim();
    },
  };
});
