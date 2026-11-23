import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getNativeStatus: vi.fn(),
  getNativeSettings: vi.fn(),
  updateNativeSettings: vi.fn(),
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  replaceApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));

const meta = (id: string, expired = false) => ({
  id, name: id, key_prefix: `kwc_${id}…`, created_at: 'now',
  expires_at: null, expired, last_used_at: null,
});

vi.mock('../../services/api', () => api);

import { useNativeStore } from '../nativeStore';

describe('nativeStore moonraker key state (security-work 2.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNativeStore.setState({
      configPath: '/printer_data/config',
      moonrakerKeySet: false,
    });
  });

  it('refreshKeyState mirrors the masked settings flag', async () => {
    api.getNativeSettings.mockResolvedValue({
      config_path: '/printer_data/config', moonraker_key_set: true,
    });
    await useNativeStore.getState().refreshKeyState();
    expect(useNativeStore.getState().moonrakerKeySet).toBe(true);
  });

  it('refreshKeyState tolerates an unreachable backend', async () => {
    api.getNativeSettings.mockRejectedValue(new Error('offline'));
    await useNativeStore.getState().refreshKeyState();
    expect(useNativeStore.getState().moonrakerKeySet).toBe(false);
  });

  it('setMoonrakerApiKey PUTs the token WITHOUT the config path (L-01)', async () => {
    // Shipping the store's configPath copy could repoint the server's
    // containment root with a stale default; the field is omitted and
    // the server's stored value is authoritative, echoed back.
    api.updateNativeSettings.mockResolvedValue({
      config_path: '/real/current', moonraker_key_set: true,
    });
    await useNativeStore.getState().setMoonrakerApiKey('mk-token');
    expect(api.updateNativeSettings).toHaveBeenCalledWith(
      undefined, 'mk-token');
    expect(useNativeStore.getState().moonrakerKeySet).toBe(true);
    expect(useNativeStore.getState().configPath).toBe('/real/current');
  });

  it('empty token is the explicit clear and unsets the flag', async () => {
    api.updateNativeSettings.mockResolvedValue({
      config_path: '/printer_data/config', moonraker_key_set: false,
    });
    await useNativeStore.getState().setMoonrakerApiKey('');
    expect(api.updateNativeSettings).toHaveBeenCalledWith(undefined, '');
    expect(useNativeStore.getState().moonrakerKeySet).toBe(false);
  });
});

describe('nativeStore MCP key actions (security-work 3.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNativeStore.setState({ apiKeys: [] });
  });

  it('refreshKeys loads masked rows only', async () => {
    api.getApiKeys.mockResolvedValue({ keys: [meta('a1')] });
    await useNativeStore.getState().refreshKeys();
    expect(useNativeStore.getState().apiKeys).toEqual([meta('a1')]);
  });

  it('createKey returns the full value once, then refreshes the list', async () => {
    api.createApiKey.mockResolvedValue({ id: 'b2', name: 'n', key: 'kwc_full', expires_at: null });
    api.getApiKeys.mockResolvedValue({ keys: [meta('b2')] });
    const value = await useNativeStore.getState().createKey('n', null);
    expect(value).toBe('kwc_full');
    expect(api.createApiKey).toHaveBeenCalledWith('n', null);
    expect(useNativeStore.getState().apiKeys[0].id).toBe('b2');
    // The full value never enters the stored rows:
    expect(JSON.stringify(useNativeStore.getState().apiKeys)).not.toContain('kwc_full');
  });

  it('createKey failure resolves to null without touching the list', async () => {
    api.createApiKey.mockRejectedValue(new Error('400 bad expiry'));
    expect(await useNativeStore.getState().createKey('n', 'bad')).toBeNull();
    expect(api.getApiKeys).not.toHaveBeenCalled();
  });

  it('replaceKey returns the FRESH value once and refreshes the rows', async () => {
    // reveal is gone (PR #48 D-2): rotation is the only re-mint path.
    useNativeStore.setState({ apiKeys: [meta('a1')] });
    api.replaceApiKey.mockResolvedValue({ id: 'a1', key: 'kwc_fresh' });
    api.getApiKeys.mockResolvedValue({ keys: [meta('a1')] });
    expect(await useNativeStore.getState().replaceKey('a1')).toBe('kwc_fresh');
    expect(api.getApiKeys).toHaveBeenCalled();
    api.replaceApiKey.mockRejectedValue(new Error('404'));
    expect(await useNativeStore.getState().replaceKey('zz')).toBeNull();
  });

  it('removeKey deletes then refreshes; failure keeps the rows and says false', async () => {
    useNativeStore.setState({ apiKeys: [meta('a1'), meta('b2')] });
    api.deleteApiKey.mockResolvedValue({ status: 'deleted' });
    api.getApiKeys.mockResolvedValue({ keys: [meta('a1')] });
    expect(await useNativeStore.getState().removeKey('b2')).toBe(true);
    expect(useNativeStore.getState().apiKeys).toEqual([meta('a1')]);

    api.deleteApiKey.mockRejectedValue(new Error('500'));
    expect(await useNativeStore.getState().removeKey('a1')).toBe(false);
    expect(api.getApiKeys).toHaveBeenCalledTimes(1);  // no refresh after failure
    expect(useNativeStore.getState().apiKeys).toEqual([meta('a1')]);
  });
});
