import { useCallback, useEffect, useState } from 'react';
import Modal from '../Modal';
import { useNativeStore } from '../../stores/nativeStore';

interface ApiAccessDialogProps {
  onClose: () => void;
}

/**
 * Server-side API access settings. The Moonraker token is stored on the
 * printer host and NEVER served back — the server reports only whether
 * one is set (same masking law as the AI provider key). Leaving the field
 * empty keeps the stored token; "Remove stored token" clears it.
 *
 * (Phase 3 of feature/security-work adds the MCP API Keys section here.)
 */
export default function ApiAccessDialog({ onClose }: ApiAccessDialogProps) {
  const moonrakerKeySet = useNativeStore((s) => s.moonrakerKeySet);
  const refreshKeyState = useNativeStore((s) => s.refreshKeyState);
  const setMoonrakerApiKey = useNativeStore((s) => s.setMoonrakerApiKey);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshKeyState();
  }, [refreshKeyState]);

  const save = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      // Empty field = keep, not clear. Closing is how you keep it.
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setMoonrakerApiKey(trimmed);
      setToken('');
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [token, setMoonrakerApiKey, onClose]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setMoonrakerApiKey('');
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [setMoonrakerApiKey]);

  return (
    <Modal
      onClose={onClose}
      label="API Access"
      backdropClassName="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      panelClassName="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[520px] max-h-[70vh] flex flex-col border border-[var(--color-bg-tertiary)]"
    >
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">API Access</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            Tokens are stored on the server and never sent back to the browser.
          </p>
        </div>
        <button
          aria-label="Close"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
            Moonraker API Token
            {!moonrakerKeySet && <span className="font-normal lowercase"> (optional)</span>}
          </label>
          <input
            type="password"
            className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
            value={token}
            onChange={(e) => { setToken(e.target.value); setSaved(false); }}
            placeholder={moonrakerKeySet ? 'Stored — leave empty to keep' : 'moonraker_api_key'}
          />
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
            {moonrakerKeySet
              ? 'A token is stored on this host (the value is not readable from here). Used for the print-state query when Moonraker has [authorization] enabled.'
              : 'Needed only if your Moonraker enables [authorization] and does not trust this host. Copy it from ~/.moonraker_api_key on the printer.'}
          </p>
        </div>

        {error && (
          <p className="text-xs text-[var(--color-error)]">{error}</p>
        )}
        {saved && !error && (
          <p className="text-xs text-[var(--color-success, var(--color-accent))]">Saved.</p>
        )}

        <div className="flex items-center justify-between">
          {moonrakerKeySet ? (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] disabled:opacity-50 transition-colors"
            >
              Remove stored token
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
