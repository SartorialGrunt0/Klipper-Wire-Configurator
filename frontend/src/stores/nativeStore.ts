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

  /** Load the active config path from the backend on startup */
  loadConfigPath: () => Promise<void>;
  /** Refresh the device list */
  refreshDevices: () => Promise<void>;
  /** Update the config path */
  setConfigPath: (path: string) => Promise<void>;
  /** Query CAN bus UUIDs on a given interface */
  queryCanbusUuids: (iface?: string) => Promise<void>;
}

/**
 * Printer-host state. There is no "am I native?" flag any more: the backend
 * refuses to start off-Linux (main._assert_native_platform), so every action
 * here is unconditionally available and simply finds nothing on a host with
 * no printer attached.
 */
export const useNativeStore = create<NativeStore>((set) => ({
  configPath: '/home/pi/printer_data/config',
  devices: null,
  devicesLoading: false,
  canbusQuery: null,
  canbusQueryLoading: false,

  loadConfigPath: async () => {
    try {
      const status = await api.getNativeStatus();
      set({ configPath: status.config_path });
    } catch {
      // Backend unreachable — keep the default; the startup read surfaces it.
    }
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
