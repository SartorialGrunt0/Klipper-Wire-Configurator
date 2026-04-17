import { create } from 'zustand';
import * as api from '../services/api';
import type { DeviceList, NativeStatus } from '../services/api';

interface NativeStore {
  /** Whether running natively on the Pi (null = not yet checked) */
  isNative: boolean | null;
  /** Config directory path on the Pi */
  configPath: string;
  /** Detected devices */
  devices: DeviceList | null;
  /** Whether devices are currently loading */
  devicesLoading: boolean;

  /** Check native status on startup */
  checkNativeStatus: () => Promise<void>;
  /** Refresh the device list */
  refreshDevices: () => Promise<void>;
  /** Update the config path */
  setConfigPath: (path: string) => Promise<void>;
}

export const useNativeStore = create<NativeStore>((set, get) => ({
  isNative: null,
  configPath: '/home/pi/printer_data/config',
  devices: null,
  devicesLoading: false,

  checkNativeStatus: async () => {
    try {
      const status: NativeStatus = await api.getNativeStatus();
      set({ isNative: status.native, configPath: status.config_path });
    } catch {
      // Backend unavailable or no native endpoint — not native
      set({ isNative: false });
    }
  },

  refreshDevices: async () => {
    if (!get().isNative) return;
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
    if (get().isNative) {
      try {
        await api.updateNativeSettings(path);
      } catch { /* ignore */ }
    }
  },
}));
