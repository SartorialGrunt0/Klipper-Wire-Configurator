import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DEFAULTS,
  PROVIDER_OPTIONS,
  buildLocalProviderApiUrl,
  getProviderModel,
  isHttpsUrl,
  isLocalProvider,
  resolveProviderApiUrl,
} from '@/utils/chatProviders';

describe('PROVIDER_OPTIONS / PROVIDER_DEFAULTS', () => {
  it('covers all five providers with labels', () => {
    expect(PROVIDER_OPTIONS).toHaveLength(5);
    const values = PROVIDER_OPTIONS.map((o) => o.value);
    expect(values).toContain('chatgpt');
    expect(values).toContain('openai-compatible');
  });

  it('openai-compatible is the only provider that does not require a key', () => {
    const keyless = (Object.entries(PROVIDER_DEFAULTS) as Array<[keyof typeof PROVIDER_DEFAULTS, { requiresKey: boolean }]>)
      .filter(([, info]) => !info.requiresKey)
      .map(([provider]) => provider);
    expect(keyless).toEqual(['openai-compatible']);
  });
});

describe('isLocalProvider', () => {
  it('returns true only for openai-compatible', () => {
    expect(isLocalProvider('openai-compatible')).toBe(true);
    expect(isLocalProvider('chatgpt')).toBe(false);
    expect(isLocalProvider('anthropic')).toBe(false);
  });
});

describe('buildLocalProviderApiUrl', () => {
  it('builds a v1 chat completions URL from host and port', () => {
    expect(buildLocalProviderApiUrl('192.168.1.133', '8080')).toBe(
      'http://192.168.1.133:8080/v1/chat/completions',
    );
    expect(buildLocalProviderApiUrl('localhost', '11434')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });
});

describe('isHttpsUrl', () => {
  it('detects cloud https endpoints', () => {
    expect(isHttpsUrl('https://api.deepseek.com/v1/chat/completions')).toBe(true);
    expect(isHttpsUrl('  https://api.openrouter.ai/api/v1  ')).toBe(true);
  });

  it('treats http and blank URLs as not-cloud', () => {
    expect(isHttpsUrl('http://192.168.1.133:8080/v1/chat/completions')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

describe('resolveProviderApiUrl', () => {
  it('passes through an explicit cloud URL for openai-compatible', () => {
    expect(resolveProviderApiUrl(
      'openai-compatible',
      'https://api.deepseek.com/v1/chat/completions',
      'localhost',
      '11434',
    )).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('strips trailing slashes from an explicit URL', () => {
    expect(resolveProviderApiUrl(
      'openai-compatible',
      'https://api.deepseek.com/v1/chat/completions/',
      'localhost',
      '11434',
    )).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('falls back to host/port when the openai-compatible URL is blank', () => {
    expect(resolveProviderApiUrl('openai-compatible', '', '192.168.1.133', '8080')).toBe(
      'http://192.168.1.133:8080/v1/chat/completions',
    );
  });

  it('passes through apiUrl for hosted providers', () => {
    expect(resolveProviderApiUrl('chatgpt', 'https://api.openai.com/v1/chat/completions', 'localhost', '1234')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });
});

describe('getProviderModel', () => {
  it('returns the provider-specific model when set', () => {
    expect(getProviderModel('chatgpt', { chatgpt: 'gpt-4o' })).toBe('gpt-4o');
  });

  it('falls back when the provider model is blank and provider matches', () => {
    expect(getProviderModel('chatgpt', {}, 'gpt-4o', 'chatgpt')).toBe('gpt-4o');
  });

  it('does not fall back when the fallback provider differs', () => {
    expect(getProviderModel('chatgpt', {}, 'gpt-4o', 'google')).toBe('');
  });

  it('returns empty when nothing matches', () => {
    expect(getProviderModel('anthropic', { chatgpt: 'gpt-4o' })).toBe('');
  });
});
