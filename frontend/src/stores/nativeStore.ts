import { create } from 'zustand';
import * as api from '../services/api';
import type { DeviceList, CanbusQueryResult, ApiKeyMeta } from '../services/api';

interface NativeStore {
  /** Config directory path on the printer host */
  configPath: string;
  /** Detected devices */
  devices: DeviceList | null;
  /** Whether devices are currently loading */
  devicesLoading: boolean;
  /** CAN bus UUID query results */
  canbusQuery: CanbusQueryResult | null;
  /** Whether CAN bus UUID query is loading */
  canbusQueryLoading: boolean;

  /** Whether a Moonraker API token is stored on the server (value never sent) */
  moonrakerKeySet: boolean;

  /** MCP API keys (metadata only; values never live in the store) */
  apiKeys: ApiKeyMeta[];

  /** Load the active config path from the backend on startup */
  loadConfigPath: () => Promise<void>;
  /** Re-read the masked native settings (token presence flag). */
  refreshKeyState: () => Promise<void>;
  /** Store (string) or clear ('') the Moonraker token. */
  setMoonrakerApiKey: (token: string) => Promise<void>;
  /** Reload the MCP key list (masked rows only). */
  refreshKeys: () => Promise<void>;
  /** Create a key; resolves to its full value (shown once, copy now). */
  createKey: (name: string, expiresAt: string | null) => Promise<string | null>;
  /** Rotate a key in place; resolves to the FRESH value (shown once).
   *  Replaces reveal: the backend serves no existing value anymore. */
  replaceKey: (id: string) => Promise<string | null>;
  /** Delete a key; false when the backend rejected it. */
  removeKey: (id: string) => Promise<boolean>;
  /** Refresh the device list */
  refreshDevices: () => Promise<void>;
  /** Update the config path */
  setConfigPath: (path: string) => Promise<void>;
  /** Query CAN bus UUIDs on a given interface */
  queryCanbusUuids: (iface?: string) => Promise<void>;
}

/**
 * Printer-host state. There is no "am I native?" flag any more: the backend
 * boots on every OS (main._warn_off_host warns once off a Linux printer
 * host), so every action here is unconditionally available and simply finds
 * nothing off-host or with no printer attached.
 */
export const useNativeStore = create<NativeStore>((set, get) => ({
  configPath: '/home/pi/printer_data/config',
  devices: null,
  devicesLoading: false,
  canbusQuery: null,
  canbusQueryLoading: false,
  moonrakerKeySet: false,
  apiKeys: [],

  loadConfigPath: async () => {
    try {
      const status = await api.getNativeStatus();
      set({ configPath: status.config_path });
    } catch {
      // Backend unreachable — keep the default; the startup read surfaces it.
    }
  },

  refreshKeyState: async () => {
    try {
      const settings = await api.getNativeSettings();
      set({ moonrakerKeySet: Boolean(settings.moonraker_key_set) });
    } catch {
      // Off-host or backend down: nothing to show.
    }
  },

  setMoonrakerApiKey: async (token: string) => {
    // config_path is deliberately NOT sent: the store's copy is only
    // ever as fresh as the startup read, and shipping a stale default
    // would silently repoint the server's config root (PR #48 L-01).
    // Omitting the field preserves it. Token field is explicit ('' clears).
    const updated = await api.updateNativeSettings(undefined, token);
    set({ moonrakerKeySet: Boolean(updated.moonraker_key_set) });
    if (typeof updated.config_path === 'string' && updated.config_path) {
      set({ configPath: updated.config_path });
    }
  },

  refreshKeys: async () => {
    try {
      set({ apiKeys: (await api.getApiKeys()).keys });
    } catch {
      // Off-host or backend down: the dialog shows an empty list.
    }
  },

  createKey: async (name, expiresAt) => {
    try {
      const created = await api.createApiKey(name, expiresAt);
      await get().refreshKeys();
      return created.key;
    } catch {
      return null;
    }
  },

  replaceKey: async (id) => {
    try {
      const rotated = await api.replaceApiKey(id);
      await get().refreshKeys();
      return rotated.key;
    } catch {
      return null;
    }
  },

  removeKey: async (id) => {
    try {
      await api.deleteApiKey(id);
    } catch {
      return false;
    }
    await get().refreshKeys();
    return true;
  },

  refreshDevices: async () => {
    set({ devicesLoading: true });
    try {
      const devices = await api.listNativeDevices();
      set({ devices, devicesLoading: false });
    } catch {
      set({ devicesLoading: false });
    }
  },

  setConfigPath: async (path: string) => {
    set({ configPath: path });
    try {
      await api.updateNativeSettings(path);
    } catch { /* ignore */ }
  },

  queryCanbusUuids: async (iface = 'can0') => {
    set({ canbusQueryLoading: true });
    try {
      const result = await api.queryCanbusUuids(iface);
      set({ canbusQuery: result, canbusQueryLoading: false });
    } catch {
      set({
        canbusQuery: { uuids: [], interface: iface, error: 'Failed to query CAN bus UUIDs.' },
        canbusQueryLoading: false,
      });
    }
  },
}));
