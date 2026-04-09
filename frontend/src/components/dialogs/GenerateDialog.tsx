import { useState, useEffect, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import type { ExampleConfig, ConfigFile } from '../../types/config';
import { buildGraphFromConfig } from '../../utils/graphBuilder';

interface GenerateDialogProps {
  onClose: () => void;
}

const KINEMATICS_OPTIONS = [
  { value: 'cartesian', label: 'Cartesian', desc: 'Standard XYZ (Ender 3, Prusa, etc.)' },
  { value: 'corexy', label: 'CoreXY', desc: 'Voron, RatRig, etc.' },
  { value: 'corexz', label: 'CoreXZ', desc: 'CoreXZ kinematics' },
  { value: 'delta', label: 'Delta', desc: 'Delta printers' },
  { value: 'deltesian', label: 'Deltesian', desc: 'Deltesian kinematics' },
  { value: 'polar', label: 'Polar', desc: 'Polar kinematics' },
  { value: 'rotary_delta', label: 'Rotary Delta', desc: 'Rotary delta kinematics' },
  { value: 'winch', label: 'Winch', desc: 'Cable-driven' },
  { value: 'hybrid_corexy', label: 'Hybrid CoreXY', desc: 'Hybrid CoreXY with independent Z' },
  { value: 'hybrid_corexz', label: 'Hybrid CoreXZ', desc: 'Hybrid CoreXZ with independent Z' },
];

type GenerateMode = 'blank' | 'example';

export default function GenerateDialog({ onClose }: GenerateDialogProps) {
  const [mode, setMode] = useState<GenerateMode>('blank');
  const [kinematics, setKinematics] = useState('cartesian');
  const [searchQuery, setSearchQuery] = useState('');
  const [examples, setExamples] = useState<ExampleConfig[]>([]);
  const [selectedExample, setSelectedExample] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const { setConfigFile, setValidation } = useConfigStore();
  const { clearGraph } = useGraphStore();

  // Load examples on mount
  useEffect(() => {
    api.listExamples().then((res) => setExamples(res.examples)).catch(() => {});
  }, []);

  // Search examples
  useEffect(() => {
    if (!searchQuery.trim()) {
      api.listExamples().then((res) => setExamples(res.examples)).catch(() => {});
      return;
    }
    const timer = setTimeout(() => {
      api.searchExamples(searchQuery).then((res) => setExamples(res.results)).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleGenerate = useCallback(async () => {
    setStatus('loading');
    try {
      clearGraph();

      const opts = mode === 'blank'
        ? { kinematics }
        : { template: selectedExample! };

      const result = await api.generateConfig(opts);
      setConfigFile(result.config.filename, result.config);
      setValidation(result.config.filename, result.validation);

      // Build full graph from parsed sections
      const graphStore = useGraphStore.getState();
      buildGraphFromConfig(result.config, graphStore, useConfigStore.getState().schemas);

      setStatus('idle');
      onClose();
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Generation failed');
    }
  }, [mode, kinematics, selectedExample, clearGraph, setConfigFile, setValidation, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[560px] max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">Generate Configuration</h2>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        {/* Mode toggle */}
        <div className="flex border-b border-[var(--color-bg-tertiary)]">
          <button
            onClick={() => setMode('blank')}
            className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${
              mode === 'blank'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-secondary)]'
            }`}
          >
            New Blank Config
          </button>
          <button
            onClick={() => setMode('example')}
            className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${
              mode === 'example'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-secondary)]'
            }`}
          >
            From Example Config
          </button>
        </div>

        <div className="overflow-y-auto max-h-[calc(80vh-160px)] p-4">
          {mode === 'blank' ? (
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] mb-2 block">
                Select kinematics type:
              </label>
              <div className="grid grid-cols-2 gap-2">
                {KINEMATICS_OPTIONS.map((k) => (
                  <button
                    key={k.value}
                    onClick={() => setKinematics(k.value)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      kinematics === k.value
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">{k.label}</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">{k.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              {/* Search */}
              <input
                type="text"
                placeholder="Search examples (e.g., SKR, Octopus, Voron)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] mb-3"
              />

              {/* Example list */}
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {examples.map((ex) => (
                  <button
                    key={ex.filename}
                    onClick={() => setSelectedExample(ex.filename)}
                    className={`flex items-center justify-between w-full p-2.5 rounded-lg text-left transition-all ${
                      selectedExample === ex.filename
                        ? 'border border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border border-transparent hover:bg-[var(--color-bg-primary)]'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-medium text-[var(--color-text-primary)]">{ex.name}</div>
                      <div className="flex gap-1 mt-0.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          ex.category === 'generic'
                            ? 'bg-blue-500/20 text-blue-400'
                            : ex.category === 'example'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}>
                          {ex.category}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
                {examples.length === 0 && (
                  <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">
                    No examples found
                  </p>
                )}
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="mt-3 p-2 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
              {message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={status === 'loading' || (mode === 'example' && !selectedExample)}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'loading' ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}
