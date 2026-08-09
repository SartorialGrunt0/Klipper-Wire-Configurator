import { describe, expect, it } from 'vitest';
import { isBackupConfigFilename } from '../backupFiles';

describe('isBackupConfigFilename', () => {
  it('matches Klipper SAVE_CONFIG backups', () => {
    expect(isBackupConfigFilename('printer-20250810_142619.cfg')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isBackupConfigFilename('PRINTER-20250810_142619.CFG')).toBe(true);
  });

  it('matches by basename for POSIX and Windows paths', () => {
    expect(isBackupConfigFilename('backups/printer-20250810_142619.cfg')).toBe(true);
    expect(isBackupConfigFilename('config\\backup\\printer-20250810_142619.cfg')).toBe(true);
  });

  it('rejects regular config files', () => {
    for (const name of ['printer.cfg', 'aux_fan.cfg', 'macros.cfg', 'PIS.cfg']) {
      expect(isBackupConfigFilename(name)).toBe(false);
    }
  });

  it('rejects lookalike names', () => {
    for (const name of [
      'printer-20250810.cfg', // no underscore-time component
      'printer-2025081_142619.cfg', // wrong date width
      'printer-20250810_142619.bak', // wrong extension
      'printer-voron-2021.cfg', // example-config naming
      'printer-voron2-350.cfg',
    ]) {
      expect(isBackupConfigFilename(name)).toBe(false);
    }
  });
});
