import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveNativeLayout } from '../api';

/**
 * The unload flush only works if the POST carries `keepalive` — a plain fetch is
 * aborted when the document dies, and there is no local copy of the layout to
 * recover from. Browsers cap keepalive bodies at 64 KiB, so the oversized case
 * must degrade to a normal fetch rather than throw.
 */
function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveNativeLayout keepalive', () => {
  it('marks the unload flush keepalive', async () => {
    const calls = stubFetch();

    await saveNativeLayout({ node: 1 }, { keepalive: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.keepalive).toBe(true);
  });

  it('leaves the debounced autosave without keepalive', async () => {
    const calls = stubFetch();

    await saveNativeLayout({ node: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.keepalive).toBeUndefined();
  });

  it('drops keepalive when the payload exceeds the 64 KiB cap', async () => {
    const calls = stubFetch();

    await saveNativeLayout({ blob: 'x'.repeat(70_000) }, { keepalive: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.keepalive).toBeUndefined();
  });
});
