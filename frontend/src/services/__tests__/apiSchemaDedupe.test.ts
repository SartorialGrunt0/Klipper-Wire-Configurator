import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSchema } from '../api';

/**
 * The App mount effect and the startup read both fetch schemas on every cold
 * start. They must share ONE in-flight request — a second /api/schema round
 * trip on a Pi host buys nothing — but the dedupe has to be per-flight, not
 * per-session: a later page load must fetch fresh schemas.
 */
function stubSchemaFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ schemas: { stepper: {} } }), {
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

describe('getSchema in-flight dedupe', () => {
  it('answers concurrent calls from one request', async () => {
    const calls = stubSchemaFetch();

    const [a, b] = await Promise.all([getSchema(), getSchema()]);

    const schemaCalls = calls.filter((u) => u.includes('/schema'));
    expect(schemaCalls).toHaveLength(1);
    expect(a.schemas).toEqual({ stepper: {} });
    expect(b).toBe(a);
  });

  it('fetches again after the first request settles', async () => {
    const calls = stubSchemaFetch();

    await getSchema();
    await getSchema();

    expect(calls.filter((u) => u.includes('/schema'))).toHaveLength(2);
  });
});
