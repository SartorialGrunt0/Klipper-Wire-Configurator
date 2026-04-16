import { create } from 'zustand';
import type { ConfigFile, ConfigSection, ConfigParam, ValidationResult, SectionSchema } from '../types/config';

/** Debounced revalidation timer — shared across all mutation methods. */
let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;

async function _revalidateAll(get: () => ConfigState, set: (partial: Partial<ConfigState> | ((s: ConfigState) => Partial<ConfigState>)) => void) {
  const { configFiles } = get();
  // Dynamically import api to avoid circular deps
  const api = await import('../services/api');
  for (const [filename, cf] of Object.entries(configFiles)) {
    try {
      const result = await api.validateConfig(cf);
      set((state) => ({
        validation: { ...state.validation, [filename]: result },
      }));
    } catch {
      // Validation API unavailable — skip silently
    }
  }
}

function scheduleRevalidation(get: () => ConfigState, set: (partial: Partial<ConfigState> | ((s: ConfigState) => Partial<ConfigState>)) => void) {
  if (_revalidateTimer) clearTimeout(_revalidateTimer);
  _revalidateTimer = setTimeout(() => _revalidateAll(get, set), 500);
}

interface ConfigState {
  /* ── Data ─────────────────────────────────────────── */
  configFiles: Record<string, ConfigFile>;
  activeFile: string;
  validation: Record<string, ValidationResult>;
  schemas: Record<string, SectionSchema>;
  selectedSection: string | null; // full_header of selected section
  originalTexts: Record<string, string>; // original exported text at import time

  /* ── Actions ──────────────────────────────────────── */
  setConfigFile: (filename: string, config: ConfigFile) => void;
  removeConfigFile: (filename: string) => void;
  setActiveFile: (filename: string) => void;
  setValidation: (filename: string, result: ValidationResult) => void;
  setSchemas: (schemas: Record<string, SectionSchema>) => void;
  setSelectedSection: (header: string | null) => void;

  /* Section operations */
  addSection: (filename: string, section: ConfigSection) => void;
  removeSection: (filename: string, fullHeader: string) => void;
  updateSectionParam: (
    filename: string,
    fullHeader: string,
    key: string,
    value: string,
  ) => void;
  addParam: (
    filename: string,
    fullHeader: string,
    param: ConfigParam,
  ) => void;
  removeParam: (filename: string, fullHeader: string, key: string) => void;
  toggleParamCommented: (
    filename: string,
    fullHeader: string,
    key: string,
  ) => void;

  /* Bulk */
  clearAll: () => void;
  loadConfigs: (configs: Record<string, ConfigFile>) => void;

  /* Original text tracking */
  setOriginalText: (filename: string, text: string) => void;

  /* File operations */
  renameConfigFile: (oldName: string, newName: string) => void;
  copyConfigFile: (sourceName: string, newName: string) => void;

  /* Include directives */
  addInclude: (filename: string, includePath: string) => void;
  removeInclude: (filename: string, includePath: string) => void;

  /* Helpers */
  getSection: (filename: string, fullHeader: string) => ConfigSection | undefined;
  getSectionErrors: (fullHeader: string) => string[];
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  configFiles: {},
  activeFile: 'printer.cfg',
  validation: {},
  schemas: {},
  selectedSection: null,
  originalTexts: {},

  setConfigFile: (filename, config) =>
    set((s) => ({
      configFiles: { ...s.configFiles, [filename]: config },
    })),

  removeConfigFile: (filename) =>
    set((s) => {
      const next = { ...s.configFiles };
      delete next[filename];
      return { configFiles: next };
    }),

  setActiveFile: (filename) => set({ activeFile: filename }),

  setValidation: (filename, result) =>
    set((s) => ({
      validation: { ...s.validation, [filename]: result },
    })),

  setSchemas: (schemas) => set({ schemas }),

  setSelectedSection: (header) => set({ selectedSection: header }),

  addSection: (filename, section) =>
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: [...cf.sections, section],
          },
        },
      };
    }),

  removeSection: (filename, fullHeader) =>
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.filter((sec) => sec.full_header !== fullHeader),
          },
        },
      };
    }),

  updateSectionParam: (filename, fullHeader, key, value) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.map((sec) => {
              if (sec.full_header !== fullHeader) return sec;
              return {
                ...sec,
                params: sec.params.map((p) =>
                  p.key === key && !p.is_commented_out ? { ...p, value } : p,
                ),
              };
            }),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  addParam: (filename, fullHeader, param) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.map((sec) => {
              if (sec.full_header !== fullHeader) return sec;
              return { ...sec, params: [...sec.params, param] };
            }),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  removeParam: (filename, fullHeader, key) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.map((sec) => {
              if (sec.full_header !== fullHeader) return sec;
              return {
                ...sec,
                params: sec.params.filter((p) => p.key !== key),
              };
            }),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  toggleParamCommented: (filename, fullHeader, key) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.map((sec) => {
              if (sec.full_header !== fullHeader) return sec;
              return {
                ...sec,
                params: sec.params.map((p) =>
                  p.key === key
                    ? { ...p, is_commented_out: !p.is_commented_out }
                    : p,
                ),
              };
            }),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  clearAll: () =>
    set({
      configFiles: {},
      activeFile: 'printer.cfg',
      validation: {},
      selectedSection: null,
      originalTexts: {},
    }),

  loadConfigs: (configs) =>
    set({
      configFiles: configs,
      activeFile: Object.keys(configs)[0] || 'printer.cfg',
    }),

  setOriginalText: (filename, text) =>
    set((s) => ({
      originalTexts: { ...s.originalTexts, [filename]: text },
    })),

  renameConfigFile: (oldName, newName) =>
    set((s) => {
      if (!s.configFiles[oldName] || oldName === newName) return s;
      if (s.configFiles[newName]) return s; // target already exists
      const next = { ...s.configFiles };
      next[newName] = { ...next[oldName], filename: newName };
      delete next[oldName];
      const nextValidation = { ...s.validation };
      if (nextValidation[oldName]) {
        nextValidation[newName] = nextValidation[oldName];
        delete nextValidation[oldName];
      }
      const nextOriginals = { ...s.originalTexts };
      if (nextOriginals[oldName]) {
        nextOriginals[newName] = nextOriginals[oldName];
        delete nextOriginals[oldName];
      }
      // Update include directives in other files that reference the old name
      for (const [fn, cf] of Object.entries(next)) {
        if (cf.includes.includes(oldName)) {
          next[fn] = { ...cf, includes: cf.includes.map((i) => i === oldName ? newName : i) };
        }
      }
      return {
        configFiles: next,
        activeFile: s.activeFile === oldName ? newName : s.activeFile,
        validation: nextValidation,
        originalTexts: nextOriginals,
      };
    }),

  copyConfigFile: (sourceName, newName) =>
    set((s) => {
      const source = s.configFiles[sourceName];
      if (!source || s.configFiles[newName]) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [newName]: {
            ...source,
            filename: newName,
            sections: source.sections.map((sec) => ({ ...sec })),
            includes: [...source.includes],
            header_comments: [...source.header_comments],
          },
        },
      };
    }),

  addInclude: (filename, includePath) =>
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      if (cf.includes.includes(includePath)) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: { ...cf, includes: [...cf.includes, includePath] },
        },
      };
    }),

  removeInclude: (filename, includePath) =>
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            includes: cf.includes.filter((i) => i !== includePath),
          },
        },
      };
    }),

  getSection: (filename, fullHeader) => {
    const cf = get().configFiles[filename];
    return cf?.sections.find((s) => s.full_header === fullHeader);
  },

  getSectionErrors: (fullHeader) => {
    const state = get();
    const errors: string[] = [];
    for (const v of Object.values(state.validation)) {
      for (const e of v.errors) {
        if (e.section === fullHeader && e.severity === 'error') {
          errors.push(e.message);
        }
      }
    }
    return errors;
  },
}));
