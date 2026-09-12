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

describe('master toggle off mid-flight (deadline race)', () => {
  it('a validate response that lands AFTER toggle-off must not repopulate the map', async () => {
    let release!: (v: ValidationResult) => void;
    validateConfigMock.mockImplementationOnce(
      () => new Promise<ValidationResult>((res) => { release = res; }),
    );
    useConfigStore.setState({ validation: {}, validationText: {} });
    const inFlight = useConfigStore.getState().revalidateFile('printer.cfg');
    await new Promise((r) => setTimeout(r, 0)); // let the mock's Promise start
    // Toggle master OFF while the request is in flight (this is what
    // setEnabled does: persist + clear the maps).
    useValidationSettingsStore.setState({ enabled: false });
    useConfigStore.getState().clearValidationState();
    // The stale response now lands.
    release(result);
    await inFlight;
    const s = useConfigStore.getState();
    expect(s.validation).toEqual({});
    expect(s.validationText).toEqual({});
  });

  it('project validate results landing after toggle-off are discarded too', async () => {
    useConfigStore.setState({
      configFiles: {
        'a.cfg': { filename: 'a.cfg', sections: [], includes: [] } as unknown as ConfigFile,
        'b.cfg': { filename: 'b.cfg', sections: [], includes: [] } as unknown as ConfigFile,
      },
      validation: {},
      validationText: {},
    });
    let release!: (v: Record<string, ValidationResult>) => void;
    validateProjectMock.mockImplementationOnce(
      () => new Promise<Record<string, ValidationResult>>((res) => { release = res; }),
    );
    const inFlight = useConfigStore.getState().revalidateAll();
    await new Promise((r) => setTimeout(r, 0)); // let the mock's Promise start
    useValidationSettingsStore.setState({ enabled: false });
    useConfigStore.getState().clearValidationState();
    release({ 'a.cfg': result, 'b.cfg': result });
    await inFlight;
    expect(useConfigStore.getState().validation).toEqual({});
  });
});
