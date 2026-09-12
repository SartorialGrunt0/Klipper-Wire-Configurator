import { useMemo } from 'react';
import { create } from 'zustand';
import type { SeverityVisibility } from '../utils/validationVisibility';

/** User-controlled visibility for config-validation findings.
 *
 *  Persisted in localStorage (machine-global, like the backend ack stores).
 *  Purely a UI concern: the backend keeps validating everything, so the MCP
 *  tools and the AI draft pipeline keep full findings regardless of these
 *  settings. When `enabled` is false the frontend also skips its own
 *  validation API calls (the Pi CPU saving was the point of the toggle).
 */

export interface ValidationSettingsState {
  /** Master switch — when off, every validation surface is hidden and the
   *  frontend stops calling the validation endpoints. */
  enabled: boolean;
  showError: boolean;
  showWarning: boolean;
  showInfo: boolean;

  setEnabled: (enabled: boolean) => void;
  setShowError: (v: boolean) => void;
  setShowWarning: (v: boolean) => void;
  setShowInfo: (v: boolean) => void;
}

const STORAGE_KEY = 'kwc.validation.settings';

interface PersistedSettings {
  enabled: boolean;
  showError: boolean;
  showWarning: boolean;
  showInfo: boolean;
}

function defaultSettings(): PersistedSettings {
  return { enabled: true, showError: true, showWarning: true, showInfo: true };
}

function loadSettings(): PersistedSettings {
  if (typeof window === 'undefined') return defaultSettings();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      enabled: parsed.enabled !== false,
      showError: parsed.showError !== false,
      showWarning: parsed.showWarning !== false,
      showInfo: parsed.showInfo !== false,
    };
  } catch {
    return defaultSettings();
  }
}

function persist(settings: PersistedSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: settings.enabled,
      showError: settings.showError,
      showWarning: settings.showWarning,
      showInfo: settings.showInfo,
    }));
  } catch {
    // Storage unavailable (private mode, quota) — settings stay session-only.
  }
}

export const useValidationSettingsStore = create<ValidationSettingsState>((set, get) => ({
  ...loadSettings(),

  setEnabled: (enabled) => {
    set({ enabled });
    persist(get());
    // Toggle off: drop cached findings so nothing leaks back when a surface
    // re-renders. Toggle on: revalidate the open project so dots/findings
    // repopulate immediately.
    void (async () => {
      const { useConfigStore } = await import('./configStore');
      if (!enabled) {
        useConfigStore.getState().clearValidationState();
      } else {
        await useConfigStore.getState().revalidateAll();
      }
    })();
  },

  setShowError: (showError) => { set({ showError }); persist(get()); },
  setShowWarning: (showWarning) => { set({ showWarning }); persist(get()); },
  setShowInfo: (showInfo) => { set({ showInfo }); persist(get()); },
}));

/** Reactive SeverityVisibility snapshot for the display-layer filtering —
 *  subscribes to the four primitives individually (v5-safe: no fresh
 *  object identity out of the selector) and re-renders on any change. */
export function useVisibility(): SeverityVisibility {
  const enabled = useValidationSettingsStore((s) => s.enabled);
  const showError = useValidationSettingsStore((s) => s.showError);
  const showWarning = useValidationSettingsStore((s) => s.showWarning);
  const showInfo = useValidationSettingsStore((s) => s.showInfo);
  return useMemo(
    () => ({ enabled, showError, showWarning, showInfo }),
    [enabled, showError, showWarning, showInfo],
  );
}
