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
      const result = await api.validateConfig({
        filename,
        sections: cf.sections.map((s) => ({
          full_header: s.full_header,
          section_type: s.section_type,
          section_name: s.section_name,
          params: s.params.map((p) => ({
            key: p.key,
            value: p.value,
            is_commented_out: p.is_commented_out,
          })),
        })),
        includes: cf.includes,
      });
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
    }),

  loadConfigs: (configs) =>
    set({
      configFiles: configs,
      activeFile: Object.keys(configs)[0] || 'printer.cfg',
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
