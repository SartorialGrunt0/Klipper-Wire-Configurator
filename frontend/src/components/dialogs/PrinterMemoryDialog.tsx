/**
 * Printer Memory Dialog
 *
 * Displays and allows editing of the printer hardware memory.
 * User can view current values, edit fields, and save changes.
 * Also shows a preview when the AI proposes printer memory updates.
 */
import React, { useState, useEffect } from 'react';
import { usePrinterMemoryStore, type PrinterMemory, isPrinterMemoryBlank } from '../../stores/printerMemoryStore';

// ── Props ───────────────────────────────────────────────────────────

interface PrinterMemoryDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, shows a preview of AI-proposed printer memory for review. */
  proposedMemory?: PrinterMemory | null;
  /** Called when user accepts the proposed memory. */
  onAcceptProposal?: (memory: PrinterMemory) => void;
}

// ── Field Config ────────────────────────────────────────────────────

interface FieldConfig {
  key: keyof PrinterMemory;
  label: string;
  placeholder: string;
}

const FIELDS: FieldConfig[] = [
  { key: 'mainboard', label: 'Mainboard', placeholder: 'e.g. BTT Octopus Pro v1.1' },
  { key: 'toolheadBoard', label: 'Toolhead Board', placeholder: 'e.g. BTT EBB36 v1.2' },
  { key: 'expanderBoards', label: 'Expander Boards', placeholder: 'e.g. BTT Manta M5P' },
  { key: 'printerName', label: 'Printer Name', placeholder: 'e.g. Voron 2.4 350mm' },
  { key: 'kinematics', label: 'Kinematics', placeholder: 'e.g. CoreXY, Cartesian, Delta' },
  { key: 'probe', label: 'Probe', placeholder: 'e.g. BLTouch, Klicky, Omron' },
  { key: 'additionalNotes', label: 'Additional Notes', placeholder: 'Any other printer details...' },
];

// ── Component ───────────────────────────────────────────────────────

const PrinterMemoryDialog: React.FC<PrinterMemoryDialogProps> = ({
  open,
  onClose,
  proposedMemory,
  onAcceptProposal,
}) => {
  const { memory, save, load, loading, error } = usePrinterMemoryStore();
  // Initialize from proposal (if any) so AI-suggested values populate the fields.
  // Fall back to current saved memory for manual editing.
  const [editValues, setEditValues] = useState<PrinterMemory>(() => ({
    ...(proposedMemory || memory),
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // When the component first mounts, load saved memory from backend (async).
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  // Only update editValues when the proposal itself changes.
  // IMPORTANT: do NOT sync from store memory — that would overwrite the proposal.
  useEffect(() => {
    if (proposedMemory) {
      setEditValues((prev) => {
        const prevStr = JSON.stringify(prev);
        const nextStr = JSON.stringify(proposedMemory);
        return prevStr === nextStr ? prev : { ...proposedMemory };
      });
    }
  }, [proposedMemory]);

  // When no proposal is active (manual edit mode), sync edits from the loaded
  // store memory. Without this the form shows blanks on first open, because
  // load() completes asynchronously AFTER mount and nothing ever copies the
  // fetched values into the form. While a proposal is active, skip syncing so
  // the AI-proposed values stay the source of truth.
  useEffect(() => {
    if (!proposedMemory) {
      setEditValues((prev) => {
        const prevStr = JSON.stringify(prev);
        const nextStr = JSON.stringify(memory);
        return prevStr === nextStr ? prev : { ...memory };
      });
    }
  }, [memory, proposedMemory]);

  // Reset success message after a delay
  useEffect(() => {
    if (saveSuccess) {
      const timer = setTimeout(() => setSaveSuccess(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveSuccess]);

  const handleFieldChange = (key: keyof PrinterMemory, value: string) => {
    setEditValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await save(editValues);
      setSaveSuccess(true);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleAcceptProposal = () => {
    // Save whatever the user is currently seeing (the proposed values,
    // possibly with user edits applied on top).
    if (onAcceptProposal) {
      onAcceptProposal(editValues);
    }
  };

  if (!open) return null;

  const blank = isPrinterMemoryBlank(memory);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[520px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-[var(--color-text-secondary)]">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
              <circle cx="9" cy="9" r="1.5" fill="currentColor" />
              <circle cx="15" cy="9" r="1.5" fill="currentColor" />
              <circle cx="9" cy="15" r="1.5" fill="currentColor" />
              <circle cx="15" cy="15" r="1.5" fill="currentColor" />
            </svg>
            <h2 className="text-sm font-semibold">
              {proposedMemory ? 'Review Printer Memory' : 'Printer Memory'}
            </h2>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          {/* AI proposal banner */}
          {proposedMemory && (
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-[var(--color-text-secondary)]">
              The AI has proposed the following printer details. Review and edit them below, then click "Accept Proposal" to save.
            </div>
          )}

          {/* Empty state */}
          {blank && !proposedMemory && (
            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)]">
              No printer details have been saved yet. The AI will try to determine your printer details from your config files and ask you to confirm.
            </div>
          )}

          {/* Error */}
          {(error || saveError) && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              {error || saveError}
            </div>
          )}

          {/* Success */}
          {saveSuccess && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-400">
              Printer memory saved successfully!
            </div>
          )}

          {/* Fields */}
          {FIELDS.map((field) => {
            const currentVal = editValues[field.key] || '';
            const storedVal = memory[field.key] || '';
            const proposedVal = proposedMemory?.[field.key] || '';
            // Show a change indicator if the proposal differs from what's saved
            const isChanged = proposedMemory && proposedVal !== storedVal;

            return (
              <div key={field.key}>
                <label className="block text-[11px] font-medium text-[var(--color-text-secondary)] mb-1">
                  {field.label}
                  {isChanged && (
                    <span className="ml-1.5 text-[10px] text-blue-400 font-normal">
                      (was: {storedVal || <span className="italic opacity-50">blank</span>})
                    </span>
                  )}
                </label>
                {field.key === 'additionalNotes' ? (
                  <textarea
                    value={currentVal}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    rows={3}
                    className={`w-full px-2.5 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border ${isChanged ? 'border-blue-500/40' : 'border-[var(--color-bg-tertiary)]'} text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)]/40 focus:outline-none focus:border-blue-500/50 resize-none`}
                  />
                ) : (
                  <input
                    type="text"
                    value={currentVal}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className={`w-full px-2.5 py-1.5 rounded text-xs bg-[var(--color-bg-primary)] border ${isChanged ? 'border-blue-500/40' : 'border-[var(--color-bg-tertiary)]'} text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)]/40 focus:outline-none focus:border-blue-500/50`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Cancel
          </button>
          {proposedMemory ? (
            <button
              onClick={handleAcceptProposal}
              disabled={loading || saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Accept Proposal'}
            </button>
          ) : (
            <button
              onClick={handleSave}
              disabled={loading || saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PrinterMemoryDialog;
