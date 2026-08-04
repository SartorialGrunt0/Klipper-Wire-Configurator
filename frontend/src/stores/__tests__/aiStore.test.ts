import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '@/stores/aiStore';

// Mock the api service so store tests never touch fetch.
vi.mock('@/services/api', () => ({
  loadAiState: vi.fn(),
  saveAiState: vi.fn(),
  loadAiHistory: vi.fn(),
  saveAiHistory: vi.fn(),
}));

import { loadAiState, saveAiState } from '@/services/api';

const mockedLoadAiState = vi.mocked(loadAiState);
const mockedSaveAiState = vi.mocked(saveAiState);

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
  vi.stubGlobal('localStorage', localStorageMock);
  vi.stubGlobal('window', { localStorage: localStorageMock });
}

beforeEach(() => {
  vi.useFakeTimers();
  installLocalStorage();
  mockedLoadAiState.mockReset();
  mockedSaveAiState.mockReset();
  useAiStore.setState({
    settings: { ...useAiStore.getState().settings },
    messages: [],
  });
});

afterEach(() => {
  // Flush any pending debounced saves so the module-level timer doesn't
  // leak into the next test (which would swallow its scheduled save).
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aiStore file persistence', () => {
  it('loadState seeds settings from the backend file', async () => {
    mockedLoadAiState.mockResolvedValue({
      settings: {
        model: 'gemma-4-12b',
        apiProvider: 'openai-compatible',
        providerModels: { 'openai-compatible': 'gemma-4-12b' },
      },
      messages: [{ role: 'user', content: 'hello' }],
    });

    await useAiStore.getState().loadState();

    const state = useAiStore.getState();
    expect(state.settings.model).toBe('gemma-4-12b');
    expect(state.settings.apiProvider).toBe('openai-compatible');
    expect(state.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('loadState no-ops when the backend file is empty', async () => {
    mockedLoadAiState.mockResolvedValue({});

    await useAiStore.getState().loadState();

    // Settings remain at defaults, not wiped by an empty file.
    expect(useAiStore.getState().messages).toEqual([]);
  });

  it('loadState ignores malformed messages but keeps valid ones', async () => {
    mockedLoadAiState.mockResolvedValue({
      settings: { model: 'gpt-4o' },
      messages: [
        { role: 'user', content: 'valid' },
        { role: 'weird', content: 42 },
        null,
      ],
    });

    await useAiStore.getState().loadState();

    expect(useAiStore.getState().messages).toEqual([{ role: 'user', content: 'valid' }]);
  });

  it('setMessages debounces a single save to the backend file', async () => {
    useAiStore.getState().setMessages([{ role: 'user', content: 'one' }]);
    useAiStore.getState().setMessages([{ role: 'user', content: 'two' }]);

    expect(mockedSaveAiState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(mockedSaveAiState).toHaveBeenCalledTimes(1);
    const arg = mockedSaveAiState.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(arg.messages).toEqual([{ role: 'user', content: 'two' }]);
  });

  it('setSettings persists to the backend file', async () => {
    useAiStore.getState().setSettings({ temperature: 0.2 });

    await vi.advanceTimersByTimeAsync(500);

    expect(mockedSaveAiState).toHaveBeenCalledTimes(1);
    const arg = mockedSaveAiState.mock.calls[0][0] as { settings: { temperature: number } };
    expect(arg.settings.temperature).toBe(0.2);
  });

  it('chatStatus is transient — settable but never persisted', async () => {
    useAiStore.getState().setChatStatus('success');
    expect(useAiStore.getState().chatStatus).toBe('success');

    await vi.advanceTimersByTimeAsync(500);
    // The status change must not trigger a backend write (transient UI state).
    expect(mockedSaveAiState).not.toHaveBeenCalled();

    useAiStore.getState().setChatStatus('error');
    expect(useAiStore.getState().chatStatus).toBe('error');

    useAiStore.getState().setChatStatus('idle');
    expect(useAiStore.getState().chatStatus).toBe('idle');
  });
});
