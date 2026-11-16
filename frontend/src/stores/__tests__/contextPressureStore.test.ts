import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useContextPressureStore, contextPressureWindowKey } from '@/stores/contextPressureStore';

vi.mock('@/services/api', () => ({
  fetchContextWindow: vi.fn(async () => 256000),
}));

import { fetchContextWindow } from '@/services/api';

const CREDENTIALS = {
  apiKey: 'fake-key',
  apiUrl: 'http://192.168.1.34:8080/v1/chat/completions',
  apiProvider: 'openai-compatible' as const,
  model: 'google/gemma-4-12B',
};

beforeEach(() => {
  useContextPressureStore.getState().reset();
  vi.mocked(fetchContextWindow).mockClear();
});

describe('contextPressureStore', () => {
  it('starts empty and silent', () => {
    const state = useContextPressureStore.getState();
    expect(state.lastPromptTokens).toBeNull();
    expect(state.contextWindow).toBeNull();
    expect(state.advisory).toBe(false);
  });

  it('records the latest prompt tokens and derives the advisory', () => {
    const store = useContextPressureStore.getState();
    store.setWindow(256000);
    store.recordUsage(200000); // 78% of 256000
    expect(useContextPressureStore.getState().lastPromptTokens).toBe(200000);
    expect(useContextPressureStore.getState().advisory).toBe(true);
    // A later reply below the threshold clears the label — it is always the
    // LATEST request's pressure that is shown.
    useContextPressureStore.getState().recordUsage(1000);
    expect(useContextPressureStore.getState().advisory).toBe(false);
  });

  it('stays silent without a window even when tokens are recorded', () => {
    useContextPressureStore.getState().recordUsage(200000);
    expect(useContextPressureStore.getState().advisory).toBe(false);
  });

  it('probes the window once per provider+model key', async () => {
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    expect(fetchContextWindow).toHaveBeenCalledTimes(1);
    expect(useContextPressureStore.getState().contextWindow).toBe(256000);
  });

  it('re-probes when the model or endpoint changes', async () => {
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    await useContextPressureStore.getState().ensureWindow({ ...CREDENTIALS, model: 'default' });
    expect(fetchContextWindow).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed probe result for the key (no retry storm)', async () => {
    vi.mocked(fetchContextWindow).mockResolvedValueOnce(null);
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    expect(fetchContextWindow).toHaveBeenCalledTimes(1);
    expect(useContextPressureStore.getState().contextWindow).toBeNull();
  });

  it('reset clears telemetry and lets the next probe run again', async () => {
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    useContextPressureStore.getState().reset();
    expect(useContextPressureStore.getState().contextWindow).toBeNull();
    await useContextPressureStore.getState().ensureWindow(CREDENTIALS);
    expect(fetchContextWindow).toHaveBeenCalledTimes(2);
  });
});

describe('contextPressureWindowKey', () => {
  it('separates models and endpoints but normalises irrelevant credentials', () => {
    const a = contextPressureWindowKey(CREDENTIALS);
    expect(a).not.toBe(contextPressureWindowKey({ ...CREDENTIALS, model: 'other' }));
    expect(a).not.toBe(contextPressureWindowKey({ ...CREDENTIALS, apiUrl: 'http://host2:8080/v1/chat/completions' }));
    expect(a).toBe(contextPressureWindowKey({ ...CREDENTIALS, apiKey: 'fake-key', apiProvider: 'chatgpt' }));
  });
});
