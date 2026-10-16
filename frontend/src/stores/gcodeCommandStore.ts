import { create } from 'zustand';
import * as api from '../services/api';

/**
 * The G-code registry, loaded once for editor completion.
 *
 * Same source the validator scans with, so a completion can never suggest a
 * command that then fails validation. Loading is best-effort: without it,
 * completion still offers section types, params, enums, include paths and the
 * project's own macros — it just has no stock command list.
 */

interface GcodeCommandState {
  /** Command names, ascending. */
  commands: string[];
  /** command → the sections it needs, for the suggestion's detail line. */
  requiresSections: Record<string, string[]>;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
}

export const useGcodeCommandStore = create<GcodeCommandState>((set, get) => ({
  commands: [],
  requiresSections: {},
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    const payload = await api.getGcodeCommands();
    const commands = payload ? Object.keys(payload.commands).sort() : [];
    const requiresSections: Record<string, string[]> = {};
    if (payload) {
      for (const [name, entry] of Object.entries(payload.commands)) {
        requiresSections[name] = entry.requires_sections;
      }
    }
    set({ commands, requiresSections, loaded: true, loading: false });
  },
}));
