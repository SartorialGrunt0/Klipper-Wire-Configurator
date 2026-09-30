import { describe, expect, it } from 'vitest';
import {
  buildChatRequestCredentials,
  clampMaxTokens,
  clampTemperature,
} from '@/utils/chatRequestBase';
import type { AiSettings } from '@/stores/aiStore';

const SETTINGS: AiSettings = {
  apiKey: '',
  model: 'klipper-expert',
  providerModels: {},
  apiUrl: 'http://192.168.1.135:8090/v1/chat/completions',
  apiProvider: 'openai-compatible',
  host: 'localhost',
  port: '11434',
  maxTokens: 8192,
  temperature: 0.7,
  toolProtocol: 'native',
};

describe('buildChatRequestCredentials', () => {
  it('carries committed store settings into the request block', () => {
    const creds = buildChatRequestCredentials(SETTINGS, 'req-1');
    expect(creds).toEqual({
      apiKey: '',
      model: 'klipper-expert',
      apiUrl: 'http://192.168.1.135:8090/v1/chat/completions',
      apiProvider: 'openai-compatible',
      requestId: 'req-1',
      maxTokens: 8192,
      temperature: 0.7,
      toolProtocol: 'native',
    });
  });

  it('resolves the local provider URL from host/port when apiUrl is empty', () => {
    const creds = buildChatRequestCredentials(
      { ...SETTINGS, apiUrl: '', host: '192.168.1.135', port: '8090' },
      'req-2',
    );
    expect(creds.apiUrl).toBe('http://192.168.1.135:8090/v1/chat/completions');
  });

  it('explicit apiUrl wins over host/port and drops trailing slashes', () => {
    const creds = buildChatRequestCredentials(
      { ...SETTINGS, apiUrl: 'https://api.deepseek.com/v1///', host: 'nope', port: '1' },
      'req-3',
    );
    expect(creds.apiUrl).toBe('https://api.deepseek.com/v1');
  });

  it('falls back to auto tool protocol when unset', () => {
    const creds = buildChatRequestCredentials(
      { ...SETTINGS, toolProtocol: undefined as unknown as AiSettings['toolProtocol'] },
      'req-4',
    );
    expect(creds.toolProtocol).toBe('auto');
  });
});

describe('clampMaxTokens', () => {
  it('floors at 256 and defaults on garbage', () => {
    expect(clampMaxTokens(8192)).toBe(8192);
    expect(clampMaxTokens(10)).toBe(256);
    expect(clampMaxTokens('abc')).toBe(4096);
    expect(clampMaxTokens('2000')).toBe(2000);
    expect(clampMaxTokens(null)).toBe(4096);
  });
});

describe('clampTemperature', () => {
  it('clamps to 0-2 with 0.7 default', () => {
    expect(clampTemperature(0.7)).toBe(0.7);
    expect(clampTemperature('3')).toBe(2);
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature('nonsense')).toBe(0.7);
  });
});
