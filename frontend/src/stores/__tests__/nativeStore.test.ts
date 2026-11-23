import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getNativeStatus: vi.fn(),
  getNativeSettings: vi.fn(),
  updateNativeSettings: vi.fn(),
}));

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

  it('setMoonrakerApiKey PUTs the token alongside the config path', async () => {
    api.updateNativeSettings.mockResolvedValue({
      config_path: '/printer_data/config', moonraker_key_set: true,
    });
    await useNativeStore.getState().setMoonrakerApiKey('mk-token');
    expect(api.updateNativeSettings).toHaveBeenCalledWith(
      '/printer_data/config', 'mk-token');
    expect(useNativeStore.getState().moonrakerKeySet).toBe(true);
  });

  it('empty token is the explicit clear and unsets the flag', async () => {
    api.updateNativeSettings.mockResolvedValue({
      config_path: '/printer_data/config', moonraker_key_set: false,
    });
    await useNativeStore.getState().setMoonrakerApiKey('');
    expect(api.updateNativeSettings).toHaveBeenCalledWith(
      '/printer_data/config', '');
    expect(useNativeStore.getState().moonrakerKeySet).toBe(false);
  });
});
