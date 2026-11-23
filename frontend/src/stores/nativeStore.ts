import { create } from 'zustand';
import * as api from '../services/api';
import type { DeviceList, CanbusQueryResult } from '../services/api';

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

  /** Load the active config path from the backend on startup */
  loadConfigPath: () => Promise<void>;
  /** Re-read the masked native settings (token presence flag). */
  refreshKeyState: () => Promise<void>;
  /** Store (string) or clear ('') the Moonraker token. */
  setMoonrakerApiKey: (token: string) => Promise<void>;
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
    // config_path rides along because the PUT replaces the settings
    // object; the token field is explicit ('' clears).
    const updated = await api.updateNativeSettings(get().configPath, token);
    set({ moonrakerKeySet: Boolean(updated.moonraker_key_set) });
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
