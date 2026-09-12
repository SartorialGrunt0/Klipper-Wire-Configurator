import { useCallback, useEffect, useState } from 'react';
import * as api from '../../services/api';
import type { AcknowledgementKind, AcknowledgementList } from '../../services/api';
import { useConfigStore } from '../../stores/configStore';

interface AcknowledgementsDialogProps {
  onClose: () => void;
}

interface Row {
  kind: AcknowledgementKind;
  key: string;
  label: string;
  detail: string;
}

const EMPTY: AcknowledgementList = {
  sections: [],
  duplicate_section_types: [],
  identities: [],
};

/** Human label + detail for one stored ack entry. */
function describeRow(kind: AcknowledgementKind, key: string): Row {
  if (kind === 'duplicate') {
    return { kind, key, label: `[${key}]`, detail: 'Duplicate-section warning ack (all files)' };
  }
  if (kind === 'identity') {
    // file|code|section|param|extra — show the parts a user recognizes.
    const [file, code, section, , extra] = key.split('|');
    const label = extra
      ? `${extra}`
      : section || code || key;
    const detailBits = [file, code, section].filter(Boolean).join(' · ');
    return { kind, key, label, detail: detailBits || 'Finding ack' };
  }
  // section snippet store — first line is the [header], rest is the snapshot.
  const lines = key.split('\n');
  const header = lines[0] ?? key;
  const rest = lines.length > 1 ? `${lines.length - 1} param${lines.length > 2 ? 's' : ''} snapshot` : '';
  return {
    kind,
    key,
    label: header.startsWith('[') ? header : `[${header}]`,
    detail: ['Unknown-section warning ack', rest].filter(Boolean).join(' · '),
  };
}

export default function AcknowledgementsDialog({ onClose }: AcknowledgementsDialogProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await api.listAcknowledgements();
      setRows([
        ...list.identities.map((key) => describeRow('identity', key)),
        ...list.duplicate_section_types.map((key) => describeRow('duplicate', key)),
        ...list.sections.map((key) => describeRow('section', key)),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load acknowledgements');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revalidateAfterChange = useCallback(() => {
    // Removing an ack re-arms the warning — refresh findings so the UI
    // (dots, save button, issue lists) agrees with the server immediately.
    void useConfigStore.getState().revalidateAll();
  }, []);

  const handleRemove = useCallback(async (row: Row) => {
    try {
      await api.removeAcknowledgement(row.kind, row.key);
      setRows((state) => state.filter((r) => !(r.kind === row.kind && r.key === row.key)));
      revalidateAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove acknowledgement');
      void refresh();
    }
  }, [refresh, revalidateAfterChange]);

  // Destructive + irreversible: require a second click to actually clear.
  const [confirmClear, setConfirmClear] = useState(false);
  const handleClearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    setConfirmClear(false);
    try {
      await api.clearAllAcknowledgements();
      setRows([]);
      revalidateAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear acknowledgements');
    }
  }, [confirmClear, revalidateAfterChange]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[560px] max-h-[70vh] flex flex-col border border-[var(--color-bg-tertiary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Acknowledgements</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Warnings you've acknowledged. Removing one makes its warning show again.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-bg-tertiary)]">
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {loading ? 'Loading…' : `${rows.length} acknowledged`}
          </span>
          <button
            onClick={handleClearAll}
            disabled={loading || rows.length === 0}
            className={`text-[11px] px-2.5 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              confirmClear
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
            }`}
          >
            {confirmClear ? 'Really clear all?' : 'Clear all'}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-[120px]">
          {!loading && rows.length === 0 && (
            <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
              Nothing acknowledged yet.
            </p>
          )}
          {rows.map((row) => (
            <div
              key={`${row.kind}:${row.key}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-bg-primary)] transition-colors group"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono text-[var(--color-text-primary)] truncate" title={row.key}>
                  {row.label}
                </p>
                <p className="text-[10px] text-[var(--color-text-secondary)] truncate">{row.detail}</p>
              </div>
              <button
                onClick={() => void handleRemove(row)}
                title="Remove acknowledgement"
                aria-label={`Remove acknowledgement ${row.label}`}
                className="p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2.5 4h11M5.5 4V2.5h5V4M6.5 7v4.5M9.5 7v4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3.75 4l.8 9.25a.75.75 0 00.75.7h5.4a.75.75 0 00.75-.7L12.25 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-[var(--color-bg-tertiary)]">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
