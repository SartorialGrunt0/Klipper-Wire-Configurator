import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../clipboard';

// The vitest environment is 'node' — there is no real navigator/document.
// We stub them per-test to exercise both branches of the util.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when available and returns true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is undefined (non-secure context)', async () => {
    vi.stubGlobal('navigator', {}); // LAN plain-HTTP origin: clipboard is absent

    const execCommand = vi.fn().mockReturnValue(true);
    const removeChild = vi.fn();
    const fakeTextarea = {
      value: '',
      setAttribute: vi.fn(),
      style: {},
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue(fakeTextarea),
      body: { appendChild: vi.fn(), removeChild },
      execCommand,
    });

    await expect(copyText('hello')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(fakeTextarea.value).toBe('hello');
    expect(removeChild).toHaveBeenCalledWith(fakeTextarea);
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue({
        value: '',
        setAttribute: vi.fn(),
        style: {},
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand,
    });

    await expect(copyText('hello')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when execCommand fails', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue({
        value: '',
        setAttribute: vi.fn(),
        style: {},
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn().mockReturnValue(false),
    });

    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('returns false when execCommand throws', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue({
        value: '',
        setAttribute: vi.fn(),
        style: {},
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });

    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('returns false with no navigator and no document (SSR)', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    await expect(copyText('hello')).resolves.toBe(false);
  });
});
