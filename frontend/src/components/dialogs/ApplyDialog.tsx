import { useState, useEffect, useRef, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useNativeStore } from '../../stores/nativeStore';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';

interface ApplyDialogProps {
  onClose: () => void;
}

export default function ApplyDialog({ onClose }: ApplyDialogProps) {
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles } = storeSnapshot.current;
  const { configPath } = useNativeStore();
  const filenames = Object.keys(configFiles);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [status, setStatus] = useState<'idle' | 'exporting' | 'applying' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [appliedFiles, setAppliedFiles] = useState<string[]>([]);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'success' | 'error'>('idle');
  const [restartMessage, setRestartMessage] = useState('');

  const toggleFile = (fn: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
  };

  const handleApply = useCallback(async () => {
    const files = Array.from(selectedFiles);
    if (files.length === 0) {
      setStatus('error');
      setMessage('No files selected.');
      return;
    }

    setStatus('exporting');
    setRestartStatus('idle');
    setRestartMessage('');
    setMessage('Exporting config files...');

    try {
      // Export each config file to text
      const exportedFiles: Record<string, string> = {};
      for (const fn of files) {
        const cf = configFiles[fn];
        if (!cf) continue;
        const text = await api.exportConfig(cf);
        exportedFiles[fn] = text;
      }

      setStatus('applying');
      setMessage(`Writing ${Object.keys(exportedFiles).length} files to ${configPath}...`);

      const result = await api.applyNativeConfig(exportedFiles, configPath);
      setAppliedFiles(result.files);
      setStatus('success');
      setMessage(`Successfully applied ${result.files.length} file${result.files.length !== 1 ? 's' : ''} to ${result.config_path}`);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Apply failed');
    }
  }, [selectedFiles, configFiles, configPath]);

  const handleFirmwareRestart = useCallback(async () => {
    setRestartStatus('restarting');
    setRestartMessage('Sending FIRMWARE_RESTART to Klipper...');
    try {
      const result = await api.firmwareRestartKlipper();
      setRestartStatus('success');
      setRestartMessage(`Klipper restart requested via ${result.socket_path}`);
    } catch (err) {
      setRestartStatus('error');
      setRestartMessage(err instanceof Error ? err.message : 'Firmware restart failed');
    }
  }, []);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[480px] max-h-[70vh] flex flex-col border border-[var(--color-bg-tertiary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Apply to Pi</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Write config files to <span className="font-mono">{configPath}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Warning */}
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <p className="text-xs text-amber-400">
            This will overwrite existing config files on the Pi. Make sure you have a backup.
          </p>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--color-text-secondary)]">
              {selectedFiles.size} of {filenames.length} files selected
            </span>
          </div>
          <div className="space-y-1">
            {filenames.map((fn) => (
              <label
                key={fn}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer ${
                  appliedFiles.includes(fn) ? 'bg-green-500/10' : 'hover:bg-[var(--color-bg-primary)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.has(fn)}
                  onChange={() => toggleFile(fn)}
                  disabled={status === 'applying' || status === 'success'}
                  className="rounded"
                />
                <span className="text-xs font-mono text-[var(--color-text-primary)] flex-1">{fn}</span>
                {appliedFiles.includes(fn) && (
                  <span className="text-xs text-green-400">Written</span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* Status */}
        {message && (
          <div className={`px-4 py-2 text-xs ${
            status === 'error' ? 'text-red-400' :
            status === 'success' ? 'text-green-400' :
            'text-[var(--color-text-secondary)]'
          }`}>
            {message}
          </div>
        )}

        {restartMessage && (
          <div className={`px-4 pb-2 text-xs ${
            restartStatus === 'error' ? 'text-red-400' :
            restartStatus === 'success' ? 'text-green-400' :
            'text-[var(--color-text-secondary)]'
          }`}>
            {restartMessage}
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            {status === 'success' ? 'Done' : 'Cancel'}
          </button>
          {status !== 'success' && (
            <button
              onClick={handleApply}
              disabled={status === 'exporting' || status === 'applying' || selectedFiles.size === 0}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {status === 'exporting' ? 'Exporting...' : status === 'applying' ? 'Writing...' : 'Apply Changes'}
            </button>
          )}
          {status === 'success' && (
            <button
              onClick={handleFirmwareRestart}
              disabled={restartStatus === 'restarting' || restartStatus === 'success'}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-amber-500 text-black hover:bg-amber-600 transition-colors disabled:opacity-50"
            >
              {restartStatus === 'restarting'
                ? 'Restarting...'
                : restartStatus === 'success'
                  ? 'Restart Sent'
                  : 'Firmware Restart'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
