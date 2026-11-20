// PR #43 C-01: contextPressureStore fences late writes. A probe that lands
// after reset() (new/loaded chat) belongs to a conversation that no longer
// exists — it must write NOTHING, not re-populate the cleared state and not
// claim the probe cache for a model the user already switched away from.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  fetchContextWindow: vi.fn(),
}));

import { useContextPressureStore } from '../../stores/contextPressureStore';
import { fetchContextWindow } from '../../services/api';

const creds = {
  apiKey: 'k',
  apiUrl: 'https://provider.invalid/v1/chat/completions',
  apiProvider: 'openai',
  model: 'model-a',
} as unknown as Parameters<typeof fetchContextWindow>[0];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.mocked(fetchContextWindow).mockReset();
  useContextPressureStore.setState({
    lastPromptTokens: null,
    contextWindow: null,
    probedKey: null,
    pendingKey: null,
    epoch: 0,
    probing: false,
    advisory: false,
    overflowMessage: null,
  });
});

describe('ensureWindow is fenced by generation and probe ownership', () => {
  it('a probe that lands after reset() writes nothing', async () => {
    const d = deferred<number>();
    vi.mocked(fetchContextWindow).mockReturnValue(d.promise);

    void useContextPressureStore.getState().ensureWindow(creds);
    expect(useContextPressureStore.getState().pendingKey).not.toBeNull();

    // The user starts a fresh chat while the probe is in flight.
    useContextPressureStore.getState().reset();

    d.resolve(128000);
    await flush();

    const s = useContextPressureStore.getState();
    expect(s.contextWindow).toBeNull();
    expect(s.probedKey).toBeNull();
    expect(s.probing).toBe(false);
    expect(s.pendingKey).toBeNull();
    // The new conversation may still probe (nothing was falsely cached).
    expect(s.epoch).toBeGreaterThan(0);
  });

  it('a normal probe claims the cache', async () => {
    vi.mocked(fetchContextWindow).mockResolvedValue(64000);
    await useContextPressureStore.getState().ensureWindow(creds);
    const s = useContextPressureStore.getState();
    expect(s.contextWindow).toBe(64000);
    expect(s.probedKey).not.toBeNull();
    expect(s.pendingKey).toBeNull();
  });

  it('reset() clears the in-flight probe slot so the new chat can probe', async () => {
    const d = deferred<number>();
    vi.mocked(fetchContextWindow).mockReturnValue(d.promise);
    void useContextPressureStore.getState().ensureWindow(creds);
    useContextPressureStore.getState().reset();
    expect(useContextPressureStore.getState().pendingKey).toBeNull();

    // The new conversation's probe runs and claims normally.
    const d2 = deferred<number>();
    vi.mocked(fetchContextWindow).mockReturnValue(d2.promise);
    void useContextPressureStore.getState().ensureWindow(creds);
    d2.resolve(32000);
    await flush();
    d.resolve(128000); // the stale first probe lands — must not overwrite
    await flush();
    expect(useContextPressureStore.getState().contextWindow).toBe(32000);
  });
});
