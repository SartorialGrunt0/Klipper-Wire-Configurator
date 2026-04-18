import { create } from 'zustand';
import type { ConfigFile, ConfigSection, ConfigParam, ValidationResult, SectionSchema } from '../types/config';

/** Debounced revalidation timer — shared across all mutation methods. */
let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;

async function _revalidateFile(
  filename: string,
  get: () => ConfigState,
  set: (partial: Partial<ConfigState> | ((s: ConfigState) => Partial<ConfigState>)) => void,
) {
  const cf = get().configFiles[filename];
  if (!cf) return;
  const api = await import('../services/api');
  try {
    const result = await api.validateConfig(cf);
    set((state) => ({
      validation: { ...state.validation, [filename]: result },
    }));
  } catch {
    // Validation API unavailable — skip silently
  }
}

async function _revalidateAll(get: () => ConfigState, set: (partial: Partial<ConfigState> | ((s: ConfigState) => Partial<ConfigState>)) => void) {
  const { configFiles } = get();
  for (const filename of Object.keys(configFiles)) {
    await _revalidateFile(filename, get, set);
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
  isDirty: boolean; // true when config has unsaved changes

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

  /* Dirty tracking */
  markClean: () => void;

  /* Helpers */
  getSection: (filename: string, fullHeader: string) => ConfigSection | undefined;
  getSectionErrors: (fullHeader: string) => string[];
  revalidateFile: (filename: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  configFiles: {},
  activeFile: 'printer.cfg',
  validation: {},
  schemas: {},
  selectedSection: null,
  originalTexts: {},
  isDirty: false,

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

  addSection: (filename, section) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: [...cf.sections, section],
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  removeSection: (filename, fullHeader) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections: cf.sections.filter((sec) => sec.full_header !== fullHeader),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  updateSectionParam: (filename, fullHeader, key, value) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      return {
        isDirty: true,
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
        isDirty: true,
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
        isDirty: true,
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
        isDirty: true,
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
      isDirty: false,
    }),

  loadConfigs: (configs) =>
    set({
      configFiles: configs,
      activeFile: Object.keys(configs)[0] || 'printer.cfg',
      isDirty: false,
    }),

  setOriginalText: (filename, text) =>
    set((s) => ({
      originalTexts: { ...s.originalTexts, [filename]: text },
    })),

  renameConfigFile: (oldName, newName) =>
    set((s) => {
      if (!s.configFiles[oldName] || oldName === newName) return s;
      if (s.configFiles[newName]) return s; // target already exists
      const isDirty = true;
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
        isDirty,
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
        isDirty: true,
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
      const includeHeader = `include ${includePath}`;
      // Check if a commented-out include section already exists for this path
      const existingIdx = cf.sections.findIndex(
        (sec) => sec.section_type === 'include' && sec.section_name === includePath,
      );
      let updatedSections = [...cf.sections];
      if (existingIdx !== -1) {
        // Uncomment the existing include section
        updatedSections = updatedSections.map((sec, i) =>
          i === existingIdx ? { ...sec, is_commented_out: false } : sec,
        );
      } else {
        // Add a new include section
        updatedSections = [
          ...updatedSections,
          {
            section_type: 'include',
            section_name: includePath,
            full_header: includeHeader,
            line_number: 0,
            params: [],
            header_comments: [],
            trailing_comments: [],
            is_commented_out: false,
          } as ConfigSection,
        ];
      }
      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            includes: [...cf.includes, includePath],
            sections: updatedSections,
          },
        },
      };
    }),

  removeInclude: (filename, includePath) =>
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      // Comment out the include section instead of removing it
      const updatedSections = cf.sections.map((sec) => {
        if (sec.section_type === 'include' && sec.section_name === includePath) {
          return { ...sec, is_commented_out: true };
        }
        return sec;
      });
      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            includes: cf.includes.filter((i) => i !== includePath),
            sections: updatedSections,
          },
        },
      };
    }),

  getSection: (filename, fullHeader) => {
    const cf = get().configFiles[filename];
    return cf?.sections.find((s) => s.full_header === fullHeader);
  },

  markClean: () => set({ isDirty: false }),

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

  revalidateFile: async (filename) => {
    await _revalidateFile(filename, get, set);
  },
}));
