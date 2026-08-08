import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRINTER_MEMORY,
  isPrinterMemoryBlank,
  printerMemoryToJsonBlock,
  usePrinterMemoryStore,
} from '@/stores/printerMemoryStore';
import type { PrinterMemory } from '@/stores/printerMemoryStore';

const SAMPLE: PrinterMemory = {
  mainboard: 'Fysetc Spider',
  toolheadBoard: 'EBBCan',
  expanderBoards: 'PIS (RP2040), Hotkey (RP2040)',
  printerName: 'Voron Trident',
  kinematics: 'corexy',
  probe: 'Voron Tap',
  additionalNotes: 'Uses host_mcu',
};

beforeEach(() => {
  usePrinterMemoryStore.setState({
    memory: { ...DEFAULT_PRINTER_MEMORY },
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isPrinterMemoryBlank', () => {
  it('returns true for all-empty memory', () => {
    expect(isPrinterMemoryBlank(DEFAULT_PRINTER_MEMORY)).toBe(true);
  });

  it('returns false when any field has content', () => {
    expect(isPrinterMemoryBlank({ ...DEFAULT_PRINTER_MEMORY, mainboard: 'Spider' })).toBe(false);
  });

  it('treats whitespace-only values as blank', () => {
    expect(isPrinterMemoryBlank({ ...DEFAULT_PRINTER_MEMORY, probe: '   ' })).toBe(true);
  });
});

describe('printerMemoryToJsonBlock', () => {
  it('wraps memory in a printer-memory fenced block', () => {
    const block = printerMemoryToJsonBlock(SAMPLE);
    expect(block.startsWith('```printer-memory\n')).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
    expect(block).toContain('"mainboard": "Fysetc Spider"');
    expect(block).toContain('"kinematics": "corexy"');
  });
});

describe('printerMemoryStore actions', () => {
  it('load() populates memory from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => SAMPLE,
      })),
    );

    await usePrinterMemoryStore.getState().load();

    const state = usePrinterMemoryStore.getState();
    expect(state.memory).toEqual(SAMPLE);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(fetch).toHaveBeenCalledWith('/api/printer-memory');
  });

  it('load() fills missing fields with empty strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mainboard: 'Spider' }),
      })),
    );

    await usePrinterMemoryStore.getState().load();

    const state = usePrinterMemoryStore.getState();
    expect(state.memory.mainboard).toBe('Spider');
    expect(state.memory.toolheadBoard).toBe('');
    expect(state.memory.kinematics).toBe('');
  });

  it('load() records an error when the API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
      })),
    );

    await usePrinterMemoryStore.getState().load();

    const state = usePrinterMemoryStore.getState();
    expect(state.error).toBe('API error 500');
    expect(state.loading).toBe(false);
  });

  it('save() PUTs memory and updates state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
      })),
    );

    await usePrinterMemoryStore.getState().save(SAMPLE);

    const state = usePrinterMemoryStore.getState();
    expect(state.memory).toEqual(SAMPLE);
    expect(state.error).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      '/api/printer-memory',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE),
      }),
    );
  });

  it('save() records an error on failure and keeps prior memory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await usePrinterMemoryStore.getState().save(SAMPLE);

    const state = usePrinterMemoryStore.getState();
    expect(state.error).toBe('network down');
    expect(state.memory).toEqual(DEFAULT_PRINTER_MEMORY);
  });

  it('updateField updates one field and saves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
      })),
    );

    usePrinterMemoryStore.setState({ memory: { ...DEFAULT_PRINTER_MEMORY, mainboard: 'Spider' } });
    await usePrinterMemoryStore.getState().updateField('probe', 'Voron Tap');

    const state = usePrinterMemoryStore.getState();
    expect(state.memory.mainboard).toBe('Spider');
    expect(state.memory.probe).toBe('Voron Tap');
    expect(state.memory.kinematics).toBe('');
  });
});
