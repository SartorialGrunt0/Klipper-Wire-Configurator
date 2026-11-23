import { describe, expect, it } from 'vitest';

import {
  SERVER_STORED_API_KEY,
  formApiKey,
  isServerStoredKey,
  saveApiKey,
} from '../apiKeyMask';

describe('apiKeyMask', () => {
  it('mirrors the backend sentinel literal (ai_routes.API_KEY_STORED_SENTINEL)', () => {
    // Assembled from parts: the value pinned here must equal
    // 'server' + '-' + 'stored', the backend's contract constant.
    expect(SERVER_STORED_API_KEY).toBe(['server', 'stored'].join('-'));
  });

  it('recognises the sentinel value', () => {
    expect(isServerStoredKey(SERVER_STORED_API_KEY)).toBe(true);
    expect(isServerStoredKey('')).toBe(false);
    expect(isServerStoredKey('sk-anything')).toBe(false);
  });

  it('shows a server-stored key as an empty form field', () => {
    expect(formApiKey(SERVER_STORED_API_KEY)).toBe('');
    expect(formApiKey('sk-typed')).toBe('sk-typed');
    expect(formApiKey('')).toBe('');
  });

  it('blank save over a stored key round-trips the sentinel', () => {
    expect(saveApiKey('', true)).toBe(SERVER_STORED_API_KEY);
    expect(saveApiKey('   ', true)).toBe(SERVER_STORED_API_KEY);
  });

  it('typed values pass through trimmed; blank without storage stays blank', () => {
    expect(saveApiKey('  sk-new  ', true)).toBe('sk-new');
    expect(saveApiKey('  sk-new  ', false)).toBe('sk-new');
    expect(saveApiKey('', false)).toBe('');
  });
});
