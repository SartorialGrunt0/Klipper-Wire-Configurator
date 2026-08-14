import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushMacroDesignerLog,
  logMacroDesignerEvent,
} from '@/utils/macroDesignerLog';

/**
 * The logger no-ops outside a browser (node test env), so to exercise
 * its batching/POST logic we stub `window` + `fetch` and flush
 * synchronously.
 */
describe('macroDesignerLog', () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Simulate a browser environment.
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('no-ops outside a browser (no window)', () => {
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    logMacroDesignerEvent({ event: 'section:build', title: 'X' });
    flushMacroDesignerLog();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('batches events and POSTs them to the backend endpoint', () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    logMacroDesignerEvent({ event: 'section:build', title: 'PRINT_START' });
    logMacroDesignerEvent({ event: 'apply', title: 'PRINT_START', action: 'update' });
    flushMacroDesignerLog();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/log/macro-designer');
    const body = JSON.parse(String(init?.body));
    expect(body.events).toHaveLength(2);
    expect(body.events[0].event).toBe('section:build');
    expect(body.events[1].event).toBe('apply');
  });

  it('includes a timestamp on each event', () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    logMacroDesignerEvent({ event: 'sim:plan', macro: 'PRINT_START' });
    flushMacroDesignerLog();

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(typeof body.events[0].ts).toBe('string');
    expect(Number.isNaN(Date.parse(body.events[0].ts))).toBe(false);
  });

  it('never throws when the backend is unreachable', () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    expect(() => {
      logMacroDesignerEvent({ event: 'apply', title: 'X' });
      flushMacroDesignerLog();
    }).not.toThrow();
  });
});
