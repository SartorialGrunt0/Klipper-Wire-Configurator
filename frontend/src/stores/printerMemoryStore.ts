/**
 * Printer Memory Store
 *
 * Manages the printer hardware memory — a persistent record of the user's
 * printer details (mainboard, kinematics, probe, etc.) that is sent to the
 * AI with every chat request so it doesn't have to ask repeatedly.
 *
 * Persisted via backend REST API (GET/PUT /api/printer-memory).
 */

import { create } from 'zustand';
// ── Types ───────────────────────────────────────────────────────────

export interface PrinterMemory {
  mainboard: string;
  toolheadBoard: string;
  expanderBoards: string;
  printerName: string;
  kinematics: string;
  probe: string;
  additionalNotes: string;
}

export const DEFAULT_PRINTER_MEMORY: PrinterMemory = {
  mainboard: '',
  toolheadBoard: '',
  expanderBoards: '',
  printerName: '',
  kinematics: '',
  probe: '',
  additionalNotes: '',
};

export function isPrinterMemoryBlank(memory: PrinterMemory): boolean {
  return Object.values(memory).every((val) => !val.trim());
}

export function printerMemoryToJsonBlock(memory: PrinterMemory): string {
  return `\`\`\`printer-memory\n${JSON.stringify(memory, null, 2)}\n\`\`\``;
}

// ── Store ───────────────────────────────────────────────────────────

interface PrinterMemoryStore {
  memory: PrinterMemory;
  loading: boolean;
  error: string | null;

  /** Load printer memory from the backend. */
  load: () => Promise<void>;
  /** Save printer memory to the backend. */
  save: (memory: PrinterMemory) => Promise<void>;
  /** Update a single field in memory and save. */
  updateField: (field: keyof PrinterMemory, value: string) => Promise<void>;
}

export const usePrinterMemoryStore = create<PrinterMemoryStore>((set, get) => ({
  memory: { ...DEFAULT_PRINTER_MEMORY },
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/printer-memory');
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      const memory: PrinterMemory = {
        mainboard: data.mainboard || '',
        toolheadBoard: data.toolheadBoard || '',
        expanderBoards: data.expanderBoards || '',
        printerName: data.printerName || '',
        kinematics: data.kinematics || '',
        probe: data.probe || '',
        additionalNotes: data.additionalNotes || '',
      };
      set({ memory, loading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load printer memory';
      set({ error: message, loading: false });
    }
  },

  save: async (memory: PrinterMemory) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/printer-memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memory),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      set({ memory, loading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save printer memory';
      set({ error: message, loading: false });
    }
  },

  updateField: async (field: keyof PrinterMemory, value: string) => {
    const current = get().memory;
    const updated = { ...current, [field]: value };
    await get().save(updated);
  },
}));
