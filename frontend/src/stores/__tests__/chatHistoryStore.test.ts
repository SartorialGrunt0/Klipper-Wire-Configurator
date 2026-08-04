import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatHistoryStore } from '@/stores/chatHistoryStore';

vi.mock('@/services/api', () => ({
  loadAiHistory: vi.fn(),
  saveAiHistory: vi.fn(),
  loadAiState: vi.fn(),
  saveAiState: vi.fn(),
}));

import { loadAiHistory, saveAiHistory } from '@/services/api';

const mockedLoadAiHistory = vi.mocked(loadAiHistory);
const mockedSaveAiHistory = vi.mocked(saveAiHistory);

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
  mockedLoadAiHistory.mockReset();
  mockedSaveAiHistory.mockReset();
  useChatHistoryStore.setState({ conversations: [], _loaded: false });
});

afterEach(() => {
  // Flush any pending debounced saves so the module-level timer doesn't
  // leak into the next test (which would swallow its scheduled save).
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chatHistoryStore file persistence', () => {
  it('loadConversations prefers the backend file', async () => {
    mockedLoadAiHistory.mockResolvedValue({
      conversations: [{
        id: 'chat_a',
        title: 'From file',
        timestamp: 100,
        messages: [{ role: 'user', content: 'hi' }],
        settings: {} as never,
      }],
    });

    await useChatHistoryStore.getState().loadConversations();

    expect(useChatHistoryStore.getState().conversations.map((c) => c.id)).toEqual(['chat_a']);
  });

  it('loadConversations migrates localStorage when the file is empty', async () => {
    mockedLoadAiHistory.mockResolvedValue({});
    window.localStorage.setItem(
      'klipper-wire-chat-history',
      JSON.stringify([{
        id: 'chat_old',
        title: 'Legacy',
        timestamp: 200,
        messages: [{ role: 'user', content: 'old' }],
        settings: {} as never,
      }]),
    );

    await useChatHistoryStore.getState().loadConversations();

    expect(useChatHistoryStore.getState().conversations.map((c) => c.id)).toEqual(['chat_old']);
    // Migration writes through to the backend file after the debounce.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockedSaveAiHistory).toHaveBeenCalledTimes(1);
  });

  it('saveConversation persists to the backend file (debounced)', async () => {
    useChatHistoryStore.getState().saveConversation(
      [{ role: 'user', content: 'question' }],
      {} as never,
    );

    expect(mockedSaveAiHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(mockedSaveAiHistory).toHaveBeenCalledTimes(1);
    const arg = mockedSaveAiHistory.mock.calls[0][0] as { conversations: Array<{ title: string }> };
    expect(arg.conversations[0].title).toBe('question');
  });

  it('deleteConversation persists the reduced list', async () => {
    useChatHistoryStore.setState({
      conversations: [{ id: 'a', title: 'A', timestamp: 1, messages: [], settings: {} as never }],
      _loaded: true,
    });

    useChatHistoryStore.getState().deleteConversation('a');
    await vi.advanceTimersByTimeAsync(500);

    expect(useChatHistoryStore.getState().conversations).toEqual([]);
    const arg = mockedSaveAiHistory.mock.calls[0][0] as { conversations: unknown[] };
    expect(arg.conversations).toEqual([]);
  });
});
