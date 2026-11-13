import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * readSavedLayout must tell "no layout saved yet" (null payload from the
 * host) apart from "the read failed" — after a failed read the App blocks
 * layout autosave, because an auto-arranged graph POSTed over the real
 * layout.json is silent, irreversible loss. loadSavedLayout keeps the old
 * collapse-to-null contract for the rebuild paths.
 */
vi.mock('../../services/api', () => ({
  loadNativeLayout: vi.fn(),
}));

import * as api from '../../services/api';
import { loadSavedLayout, readSavedLayout } from '../layoutPersistence';

const mockedLoad = vi.mocked(api.loadNativeLayout);

afterEach(() => {
  vi.clearAllMocks();
});

describe('readSavedLayout outcomes', () => {
  it('reports ok with a normalized layout when the host has content', async () => {
    mockedLoad.mockResolvedValue({
      layout: { graphNodes: [{ id: 'n1', position: { x: 1, y: 2 } }], graphEdges: [] },
    });

    const outcome = await readSavedLayout();

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.layout.graphNodes).toHaveLength(1);
    }
  });

  it('reports absent when the host answers with a null payload', async () => {
    mockedLoad.mockResolvedValue({ layout: null });

    expect(await readSavedLayout()).toEqual({ status: 'absent' });
  });

  it('reports error when the read throws — the case autosave must respect', async () => {
    mockedLoad.mockRejectedValue(new Error('backend down'));

    expect(await readSavedLayout()).toEqual({ status: 'error' });
  });

  it('loadSavedLayout still collapses absent and error to null', async () => {
    mockedLoad.mockResolvedValue({ layout: null });
    expect(await loadSavedLayout()).toBeNull();

    mockedLoad.mockRejectedValue(new Error('backend down'));
    expect(await loadSavedLayout()).toBeNull();
  });
});
