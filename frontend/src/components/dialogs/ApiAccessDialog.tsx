import { useCallback, useEffect, useState } from 'react';
import Modal from '../Modal';
import { useNativeStore } from '../../stores/nativeStore';
import { copyText } from '../../utils/clipboard';

interface ApiAccessDialogProps {
  onClose: () => void;
}

/**
 * Server-side API access settings. The Moonraker token is stored on the
 * printer host and NEVER served back — the server reports only whether
 * one is set (same masking law as the AI provider key). Leaving the field
 * empty keeps the stored token; "Remove stored token" clears it.
 *
 * The MCP API Keys section gates ONLY the /api/mcp HTTP surface
 * (decision D1): with no keys the endpoint behaves as it always has;
 * with one or more keys, external MCP clients must authenticate with
 * `Authorization: Bearer <key>` (the MCP-spec header — spec clients
 * work with zero custom configuration).
 * The KWC app itself never authenticates — the chat's tool loop calls
 * MCP in-process. A key's value is shown EXACTLY ONCE, at creation or
 * rotation: no route serves an existing value anymore (PR #48 D-2 —
 * reveal was removed for exactly that reason). Lost a key? Rotate it
 * with Replace and copy the fresh value.
 */
export default function ApiAccessDialog({ onClose }: ApiAccessDialogProps) {
  const moonrakerKeySet = useNativeStore((s) => s.moonrakerKeySet);
  const refreshKeyState = useNativeStore((s) => s.refreshKeyState);
  const setMoonrakerApiKey = useNativeStore((s) => s.setMoonrakerApiKey);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiKeys = useNativeStore((s) => s.apiKeys);
  const refreshKeys = useNativeStore((s) => s.refreshKeys);
  const createKey = useNativeStore((s) => s.createKey);
  const replaceKey = useNativeStore((s) => s.replaceKey);
  const removeKey = useNativeStore((s) => s.removeKey);
  const [keyName, setKeyName] = useState('');
  const [keyExpiry, setKeyExpiry] = useState('');
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshKeyState();
    void refreshKeys();
  }, [refreshKeyState, refreshKeys]);

  const addKey = useCallback(async () => {
    const value = await createKey(keyName.trim(), keyExpiry || null);
    if (value) {
      setFreshKey(value);
      setCopiedId(null);
      setKeyName('');
      setKeyExpiry('');
    } else {
      setError('Could not create the key — see the backend log.');
    }
  }, [createKey, keyName, keyExpiry]);

  const rotate = useCallback(async (id: string) => {
    const value = await replaceKey(id);
    if (value) {
      setFreshKey(value);
      setCopiedId(null);
    } else {
      setError('Could not rotate the key — see the backend log.');
    }
  }, [replaceKey]);

  const copy = useCallback((text: string, id: string) => {
    // copyText() has the non-secure-context fallback; navigator.clipboard
    // does NOT exist on the plain-HTTP LAN origin (the printer-host case)
    // and calling it directly dies silently there. 'Copied' only after the
    // promise resolves true — no lying feedback.
    void copyText(text).then((ok) => {
      if (!ok) {
        setError('Copy failed — select the key text below and copy it manually.');
        return;
      }
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    });
  }, []);

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

        {/* ── MCP API keys ─────────────────────────────────────── */}
        <div className="pt-1 border-t border-[var(--color-bg-tertiary)]">
          <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
            MCP API Keys
          </label>
          <p className="text-[10px] text-[var(--color-text-secondary)] mb-2">
            {apiKeys.length === 0
              ? 'No keys yet — the MCP endpoint stays open to this network, exactly as before.'
              : `${apiKeys.length} key${apiKeys.length > 1 ? 's' : ''} active — external MCP clients must send "Authorization: Bearer <key>". The KWC app is unaffected.`}
          </p>
          {apiKeys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 py-1.5 border-b border-[var(--color-bg-tertiary)] last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--color-text-primary)] truncate">
                  {k.name || <span className="italic text-[var(--color-text-secondary)]">(unnamed)</span>}
                  {k.expired && <span className="ml-2 text-[10px] text-[var(--color-error)]">expired</span>}
                </div>
                <div className="text-[10px] font-mono text-[var(--color-text-secondary)] truncate">
                  {k.key_prefix}
                  {k.expires_at && !k.expired && (
                    <span className="font-sans"> · until {k.expires_at.slice(0, 10)}</span>
                  )}
                  {k.last_used_at && (
                    <span className="font-sans"> · last used {k.last_used_at.slice(0, 10)}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Replace key ${k.name || k.id}`}
                title="Rotate the value in place (the new value is shown once)"
                onClick={() => void rotate(k.id)}
                className="px-2 py-1 rounded text-[10px] font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                Replace
              </button>
              <button
                type="button"
                aria-label={`Delete key ${k.name || k.id}`}
                onClick={() => {
                  // A deleted value is dead — the copy-once banner must
                  // not outlive the row it belongs to (round-2).
                  setFreshKey(null);
                  setCopiedId(null);
                  void removeKey(k.id);
                }}
                className="px-2 py-1 rounded text-[10px] font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-error)] hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                Delete
              </button>
            </div>
          ))}
          {freshKey && (
            <div className="mt-2 p-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg-primary)]">
              <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">
                Copy it now — this value is shown once and cannot be re-displayed.
                Paste it into your MCP client's headers. Lost it? Replace rotates it in place.
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono text-[var(--color-text-primary)] break-all">{freshKey}</code>
                <button
                  type="button"
                  onClick={() => copy(freshKey, 'new')}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 whitespace-nowrap transition-opacity"
                >
                  {copiedId === 'new' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <input
              className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
              placeholder="Name (e.g. Claude Desktop)"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <input
              type="date"
              title="Expires (optional — never expires by default)"
              className="px-2 py-1.5 rounded-lg text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
              value={keyExpiry}
              onChange={(e) => setKeyExpiry(e.target.value)}
            />
            <button
              type="button"
              onClick={() => void addKey()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 whitespace-nowrap transition-opacity"
            >
              Create key
            </button>
          </div>
          <details className="mt-2">
            <summary className="text-[10px] cursor-pointer text-[var(--color-text-secondary)]">
              Client configuration hint
            </summary>
            <pre className="mt-1 p-2 rounded bg-[var(--color-bg-primary)] text-[10px] font-mono text-[var(--color-text-secondary)] overflow-x-auto">{`// any MCP client with a bearer-token field (or custom headers)
"url": "http://<printer-ip>:8099/api/mcp",
"headers": { "Authorization": "Bearer <key from here>" }`}</pre>
          </details>
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
