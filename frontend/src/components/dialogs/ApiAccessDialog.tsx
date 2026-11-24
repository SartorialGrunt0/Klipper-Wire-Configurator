import { useCallback, useEffect, useState } from 'react';
import Modal from '../Modal';
import { useNativeStore } from '../../stores/nativeStore';
import { copyText } from '../../utils/clipboard';
import { EXPIRY_PRESETS, expiryFromPreset, type ExpiryPreset } from '../../utils/keyExpiry';

interface ApiAccessDialogProps {
  onClose: () => void;
}

/**
 * Server-side API access settings, split into Moonraker / KWC tabs (the
 * folder-tab styling matches the Flash dialog's Klipper/Katapult tabs.
 *
 * Moonraker tab: the outbound token KWC sends to Moonraker (decision D2).
 * Stored on the server and NEVER served back — the server reports only
 * whether one is set (same masking law as the AI provider key).
 *
 * KWC tab: MCP API keys gating ONLY the /api/mcp HTTP surface (decision
 * D1). With no keys the endpoint behaves as it always has; with one or
 * more keys, external MCP clients must send `Authorization: Bearer ***
 * (the MCP-spec header). The KWC app itself never authenticates — the
 * chat's tool loop calls MCP in-process. A key's value is shown EXACTLY
 * ONCE, at creation or rotation (PR #48 D-2): lost a key? Replace
 * rotates it in place and shows the fresh value once.
 */

/** Shared control heights: bordered inputs/selects and borderless buttons
 * align exactly (the borderless ones carry a transparent border). */
const CONTROL = 'h-8 text-xs';
const BUTTON_BORDER_FIX = 'border border-transparent';

/** Small circled "i": reveals its note on hover, or on click (touch). */
function InfoDot({ children, label }: { children: React.ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex group align-middle">
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="w-4 h-4 rounded-full border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] text-[10px] italic font-serif leading-none flex items-center justify-center hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
      >
        i
      </button>
      <span
        className={`absolute left-5 top-0 z-10 w-[340px] p-2.5 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-xl text-[10px] font-normal normal-case tracking-normal text-[var(--color-text-secondary)] ${
          open ? 'block' : 'hidden group-hover:block'
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/** Folder tab — same design as the Flash dialog's Klipper/Katapult tabs. */
function FolderTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t-xl border px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-[var(--color-bg-tertiary)] border-b-[var(--color-bg-secondary)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]'
          : 'border-transparent bg-[var(--color-bg-primary)]/60 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}

export default function ApiAccessDialog({ onClose }: ApiAccessDialogProps) {
  const [tab, setTab] = useState<'moonraker' | 'kwc'>('moonraker');

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
  const [keyExpiry, setKeyExpiry] = useState<ExpiryPreset>('never');
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshKeyState();
    void refreshKeys();
  }, [refreshKeyState, refreshKeys]);

  const addKey = useCallback(async () => {
    const value = await createKey(keyName.trim(), expiryFromPreset(keyExpiry));
    if (value) {
      setFreshKey(value);
      setCopiedId(null);
      setKeyName('');
      setKeyExpiry('never');
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
      <div className="flex items-center justify-between p-4 pb-0">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">API Access</h2>
        <button
          aria-label="Close"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
        >
          ✕
        </button>
      </div>

      {/* Folder tabs — same design as the Flash dialog's target tabs. */}
      <div className="flex gap-2 px-4 mt-3 border-b border-[var(--color-bg-tertiary)]">
        <FolderTab active={tab === 'moonraker'} onClick={() => setTab('moonraker')}>Moonraker</FolderTab>
        <FolderTab active={tab === 'kwc'} onClick={() => setTab('kwc')}>KWC</FolderTab>
      </div>

      <div className="p-4 space-y-3 overflow-y-auto">
        {tab === 'moonraker' ? (
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
              Moonraker API Token
              {!moonrakerKeySet && <span className="font-normal lowercase"> (optional)</span>}
              <InfoDot label="About the Moonraker token">
                Needed only if your Moonraker enables [authorization] and does not trust this
                host. Copy it from <code className="font-mono">~/.moonraker_api_key</code> on the
                printer. Stored on the server, never shown again; leaving the field empty keeps
                what is stored.
              </InfoDot>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                className={`flex-1 min-w-0 px-3 rounded-lg font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors ${CONTROL}`}
                value={token}
                onChange={(e) => { setToken(e.target.value); setSaved(false); }}
                placeholder={moonrakerKeySet ? 'Stored — leave empty to keep' : 'moonraker_api_key'}
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                className={`px-3 rounded-lg font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 disabled:opacity-50 whitespace-nowrap transition-opacity ${CONTROL} ${BUTTON_BORDER_FIX}`}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {moonrakerKeySet && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  // Standard delete styling: solid red, same as the Flash
                  // dialog's Delete artifact and Chat history's Delete All.
                  className={`px-3 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors ${CONTROL} ${BUTTON_BORDER_FIX}`}
                >
                  Remove stored token
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
              MCP API Keys
              <InfoDot label="How MCP clients authenticate">
                <div className="mb-1">
                  With one or more keys, external MCP clients must send{' '}
                  <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> to{' '}
                  <code className="font-mono">/api/mcp</code>. With none, the endpoint stays open
                  to this network. The KWC app itself is unaffected.
                </div>
                <pre className="p-2 rounded bg-[var(--color-bg-primary)] font-mono whitespace-pre-wrap break-all">{`"url": "http://<printer-ip>:8099/api/mcp",
"headers": { "Authorization": "Bearer <key>" }`}</pre>
              </InfoDot>
            </label>

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
                  className="h-6 px-2 rounded text-[10px] font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] transition-colors"
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
                  className="h-6 px-2 rounded text-[10px] font-medium border border-transparent bg-red-600 text-white hover:bg-red-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}

            {freshKey && (
              <div className="mt-2 p-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg-primary)]">
                <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">
                  Copy it now — this value is shown once and cannot be re-displayed.
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-[var(--color-text-primary)] break-all">{freshKey}</code>
                  <button
                    type="button"
                    onClick={() => copy(freshKey, 'new')}
                    className={`px-3 rounded-lg font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 whitespace-nowrap transition-opacity ${CONTROL} ${BUTTON_BORDER_FIX}`}
                  >
                    {copiedId === 'new' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor="new-key-name"
                    className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1"
                  >
                    Name
                  </label>
                  <input
                    id="new-key-name"
                    className={`w-full min-w-0 px-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors ${CONTROL}`}
                    placeholder="e.g. Claude Desktop"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor="new-key-expiry"
                    className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1"
                  >
                    Expiration
                  </label>
                  <select
                    id="new-key-expiry"
                    className={`px-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors ${CONTROL}`}
                    value={keyExpiry}
                    onChange={(e) => setKeyExpiry(e.target.value as ExpiryPreset)}
                  >
                    {EXPIRY_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="block mb-1" aria-hidden />
                  <button
                    type="button"
                    onClick={() => void addKey()}
                    className={`px-3 rounded-lg font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 whitespace-nowrap transition-opacity ${CONTROL} ${BUTTON_BORDER_FIX}`}
                  >
                    Create key
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-[var(--color-error)]">{error}</p>
        )}
        {saved && !error && (
          <p className="text-xs text-[var(--color-success, var(--color-accent))]">Saved.</p>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className={`px-3 rounded-lg text-xs font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] transition-colors ${CONTROL}`}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
