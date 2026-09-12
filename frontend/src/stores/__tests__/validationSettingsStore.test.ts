import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigFile, ValidationResult } from '@/types/config';
import { useConfigStore } from '@/stores/configStore';
import { useValidationSettingsStore } from '@/stores/validationSettingsStore';

const validateConfigMock = vi.fn(async (_cf: ConfigFile): Promise<ValidationResult> => ({
  has_errors: true,
  has_warnings: false,
  errors: [{
    severity: 'error',
    section: 'stepper_x',
    param: 'step_pin',
    message: 'boom',
    line_number: 1,
  }],
}));
const validateProjectMock = vi.fn(async (): Promise<Record<string, ValidationResult>> => ({}));

vi.mock('@/services/api', () => ({
  get validateConfig() { return validateConfigMock; },
  get validateProject() { return validateProjectMock; },
}));

const result: ValidationResult = {
  has_errors: true,
  has_warnings: false,
  errors: [{
    severity: 'error',
    section: 'stepper_x',
    param: '',
    message: 'boom',
    line_number: 1,
  }],
};

beforeEach(() => {
  validateConfigMock.mockClear();
  validateProjectMock.mockClear();
  useValidationSettingsStore.setState({
    enabled: true, showError: true, showWarning: true, showInfo: true,
  });
  useConfigStore.setState({
    configFiles: {
      'printer.cfg': { filename: 'printer.cfg', sections: [], includes: [], raw_text: '[stepper_x]' } as unknown as ConfigFile,
    },
    validation: { 'printer.cfg': result },
    validationText: { 'printer.cfg': '[stepper_x]' },
  });
});

describe('master validation toggle — store gating', () => {
  it('setValidation writes normally when enabled', () => {
    useConfigStore.getState().setValidation('a.cfg', result);
    expect(useConfigStore.getState().validation['a.cfg']).toBe(result);
  });

  it('setValidation refuses to seed findings when disabled', () => {
    useValidationSettingsStore.setState({ enabled: false });
    useConfigStore.getState().setValidation('a.cfg', result);
    expect(useConfigStore.getState().validation).toEqual({});
    expect(useConfigStore.getState().validationText).toEqual({});
  });

  it('revalidateFile skips the API call when disabled', async () => {
    useValidationSettingsStore.setState({ enabled: false });
    await useConfigStore.getState().revalidateFile('printer.cfg');
    expect(validateConfigMock).not.toHaveBeenCalled();
    expect(validateProjectMock).not.toHaveBeenCalled();
  });

  it('revalidateAll runs the API call when enabled', async () => {
    await useConfigStore.getState().revalidateAll();
    expect(validateConfigMock).toHaveBeenCalledTimes(1);
  });

  it('clearValidationState drops findings but keeps parse errors', () => {
    useConfigStore.setState({ textParseErrors: { 'printer.cfg': 'unparseable' } });
    useConfigStore.getState().clearValidationState();
    const s = useConfigStore.getState();
    expect(s.validation).toEqual({});
    expect(s.validationText).toEqual({});
    expect(s.textParseErrors['printer.cfg']).toBe('unparseable');
  });
});
