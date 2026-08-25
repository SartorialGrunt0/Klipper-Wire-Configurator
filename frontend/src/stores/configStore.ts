import { create } from 'zustand';
import type { ConfigFile, ConfigSection, ConfigParam, ValidationResult, SectionSchema } from '../types/config';

/** Debounced revalidation timer — shared across all mutation methods. */
let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;

function matchesSectionIdentity(section: ConfigSection, fullHeader: string, lineNumber?: number): boolean {
  if (section.full_header !== fullHeader) return false;
  if (lineNumber == null || lineNumber === 0) return true;
  return section.line_number === lineNumber;
}

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
  const filenames = Object.keys(configFiles);
  if (filenames.length === 0) return;

  if (filenames.length === 1) {
    await _revalidateFile(filenames[0], get, set);
    return;
  }

  const api = await import('../services/api');
  try {
    const results = await api.validateProject(configFiles);
    set((state) => ({
      validation: { ...state.validation, ...results },
    }));
  } catch {
    for (const filename of filenames) {
      await _revalidateFile(filename, get, set);
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
  selectedSectionFile: string | null; // config file owning the selected section (duplicate-header safe)
  selectedSectionLine: number | null; // line number of the selected section (duplicate-header safe)
  originalTexts: Record<string, string>; // original exported text at import time
  isDirty: boolean; // true when config has unsaved changes
  textParseErrors: Record<string, string>; // per-file parse failures in the text view (last-good model is held)

  /* ── Actions ──────────────────────────────────────── */
  setConfigFile: (filename: string, config: ConfigFile) => void;
  /** Replace a file's config AND mark the project dirty + schedule revalidation.
   *  Use this for user-driven mutations (graph edits, duplicate, panel saves).
   *  Use setConfigFile for load paths, which manage dirty state explicitly. */
  updateConfigFile: (filename: string, config: ConfigFile) => void;
  removeConfigFile: (filename: string) => void;
  setActiveFile: (filename: string) => void;
  setValidation: (filename: string, result: ValidationResult) => void;
  setSchemas: (schemas: Record<string, SectionSchema>) => void;
  setSelectedSection: (header: string | null, configFile?: string | null, lineNumber?: number | null) => void;

  /* Section operations */
  addSection: (filename: string, section: ConfigSection) => void;
  upsertSection: (
    filename: string,
    section: ConfigSection,
    previousFullHeader?: string,
    previousLineNumber?: number,
  ) => void;
  removeSection: (filename: string, fullHeader: string, lineNumber?: number) => void;
  updateSectionParam: (
    filename: string,
    fullHeader: string,
    key: string,
    value: string,
    lineNumber?: number,
  ) => void;
  addParam: (
    filename: string,
    fullHeader: string,
    param: ConfigParam,
    lineNumber?: number,
  ) => void;
  removeParam: (filename: string, fullHeader: string, key: string, lineNumber?: number) => void;
  toggleParamCommented: (
    filename: string,
    fullHeader: string,
    key: string,
    lineNumber?: number,
  ) => void;

  /* Bulk */
  clearAll: () => void;
  loadConfigs: (configs: Record<string, ConfigFile>) => void;

  /* Original text tracking */
  setOriginalText: (filename: string, text: string) => void;
  removeOriginalTexts: (filenames: string[]) => void;

  /* File operations */
  renameConfigFile: (oldName: string, newName: string) => void;
  copyConfigFile: (sourceName: string, newName: string) => void;

  /* Include directives */
  addInclude: (filename: string, includePath: string) => void;
  removeInclude: (filename: string, includePath: string) => void;

  /* Dirty tracking */
  markDirty: () => void;
  markClean: () => void;
  setTextParseError: (filename: string, message: string | null) => void;

  /* Helpers */
  getSection: (filename: string, fullHeader: string, lineNumber?: number) => ConfigSection | undefined;
  getSectionErrors: (fullHeader: string) => string[];
  revalidateFile: (filename: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  configFiles: {},
  activeFile: 'printer.cfg',
  validation: {},
  schemas: {},
  selectedSection: null,
  selectedSectionFile: null,
  selectedSectionLine: null,
  originalTexts: {},
  isDirty: false,
  textParseErrors: {},

  setConfigFile: (filename, config) =>
    set((s) => ({
      configFiles: { ...s.configFiles, [filename]: config },
    })),

  updateConfigFile: (filename, config) => {
    set((s) => ({
      isDirty: true,
      configFiles: { ...s.configFiles, [filename]: config },
    }));
    scheduleRevalidation(get, set);
  },

  removeConfigFile: (filename) =>
    set((s) => {
      if (!s.configFiles[filename]) return s;
      const nextConfigFiles = { ...s.configFiles };
      delete nextConfigFiles[filename];

      const nextValidation = { ...s.validation };
      delete nextValidation[filename];

      const nextTextParseErrors = { ...s.textParseErrors };
      delete nextTextParseErrors[filename];

      const remainingFiles = Object.keys(nextConfigFiles);

      return {
        isDirty: true,
        configFiles: nextConfigFiles,
        validation: nextValidation,
        textParseErrors: nextTextParseErrors,
        activeFile: s.activeFile === filename ? remainingFiles[0] || 'printer.cfg' : s.activeFile,
        selectedSection: s.activeFile === filename || s.selectedSectionFile === filename ? null : s.selectedSection,
        selectedSectionFile: s.selectedSectionFile === filename ? null : s.selectedSectionFile,
        selectedSectionLine: s.selectedSectionFile === filename ? null : s.selectedSectionLine,
      };
    }),

  setActiveFile: (filename) => set({ activeFile: filename }),

  setValidation: (filename, result) =>
    set((s) => ({
      validation: { ...s.validation, [filename]: result },
    })),

  setSchemas: (schemas) => set({ schemas }),

  setSelectedSection: (header, configFile, lineNumber) =>
    set({
      selectedSection: header,
      selectedSectionFile: configFile ?? null,
      selectedSectionLine: lineNumber ?? null,
    }),

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

  upsertSection: (filename, section, previousFullHeader, previousLineNumber) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      const sections = [...cf.sections];
      const previousIndex = previousFullHeader
        ? sections.findIndex((candidate) => matchesSectionIdentity(candidate, previousFullHeader, previousLineNumber))
        : -1;
      const existingIndex = sections.findIndex((candidate) => matchesSectionIdentity(candidate, section.full_header, section.line_number));

      if (previousIndex !== -1) {
        sections[previousIndex] = section;
        if (existingIndex !== -1 && existingIndex !== previousIndex) {
          sections.splice(existingIndex, 1);
        }
      } else if (existingIndex !== -1) {
        sections[existingIndex] = section;
      } else {
        sections.push(section);
      }

      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections,
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  removeSection: (filename, fullHeader, lineNumber) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      // Prefer exact (header, line) identity; fall back to header-only when
      // the line number is stale (node data captured before later edits) so a
      // delete never silently no-ops and vanishes from the diff.
      let removeIndex = cf.sections.findIndex((sec) => matchesSectionIdentity(sec, fullHeader, lineNumber));
      if (removeIndex === -1 && lineNumber != null && lineNumber !== 0) {
        removeIndex = cf.sections.findIndex((sec) => sec.full_header === fullHeader);
      }
      if (removeIndex === -1) return s;
      const sections = [...cf.sections];
      sections.splice(removeIndex, 1);
      return {
        isDirty: true,
        configFiles: {
          ...s.configFiles,
          [filename]: {
            ...cf,
            sections,
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  updateSectionParam: (filename, fullHeader, key, value, lineNumber) => {
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
              if (!matchesSectionIdentity(sec, fullHeader, lineNumber)) return sec;
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

  addParam: (filename, fullHeader, param, lineNumber) => {
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
              if (!matchesSectionIdentity(sec, fullHeader, lineNumber)) return sec;
              return { ...sec, params: [...sec.params, param] };
            }),
          },
        },
      };
    });
    scheduleRevalidation(get, set);
  },

  removeParam: (filename, fullHeader, key, lineNumber) => {
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
              if (!matchesSectionIdentity(sec, fullHeader, lineNumber)) return sec;
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

  toggleParamCommented: (filename, fullHeader, key, lineNumber) => {
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
              if (!matchesSectionIdentity(sec, fullHeader, lineNumber)) return sec;
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
      selectedSectionFile: null,
      selectedSectionLine: null,
      originalTexts: {},
      isDirty: false,
      textParseErrors: {},
    }),

  loadConfigs: (configs) =>
    set({
      configFiles: configs,
      activeFile: Object.keys(configs)[0] || 'printer.cfg',
      isDirty: false,
      selectedSection: null,
      selectedSectionFile: null,
      selectedSectionLine: null,
      textParseErrors: {},
    }),

  setOriginalText: (filename, text) =>
    set((s) => ({
      originalTexts: { ...s.originalTexts, [filename]: text },
    })),

  removeOriginalTexts: (filenames) =>
    set((s) => {
      if (filenames.length === 0) return s;
      const next = { ...s.originalTexts };
      for (const fn of filenames) delete next[fn];
      return { originalTexts: next };
    }),

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
      const nextTextParseErrors = { ...s.textParseErrors };
      if (nextTextParseErrors[oldName]) {
        nextTextParseErrors[newName] = nextTextParseErrors[oldName];
        delete nextTextParseErrors[oldName];
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
        textParseErrors: nextTextParseErrors,
        selectedSection: s.selectedSection,
        selectedSectionFile: s.selectedSectionFile === oldName ? newName : s.selectedSectionFile,
        selectedSectionLine: s.selectedSectionLine,
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
            sections: source.sections.map((sec) => ({
              ...sec,
              params: sec.params.map((p) => ({ ...p })),
              header_comments: [...(sec.header_comments ?? [])],
              trailing_comments: sec.trailing_comments
                ? [...sec.trailing_comments]
                : undefined,
            })),
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

      let updatedSections: ConfigSection[];
      if (existingIdx !== -1) {
        // Re-activate the commented-out include in-place — don't move it
        updatedSections = cf.sections.map((sec, i) =>
          i === existingIdx ? { ...sec, is_commented_out: false } : sec,
        );
      } else {
        // New include: insert at the very top so it appears before all other sections
        const newIncludeSection: ConfigSection = {
          section_type: 'include',
          section_name: includePath,
          full_header: includeHeader,
          line_number: 0,
          params: [],
          header_comments: [],
          trailing_comments: [],
          is_commented_out: false,
        };
        updatedSections = [newIncludeSection, ...cf.sections];
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

  getSection: (filename, fullHeader, lineNumber) => {
    const cf = get().configFiles[filename];
    return cf?.sections.find((s) => matchesSectionIdentity(s, fullHeader, lineNumber));
  },

  markDirty: () =>
    set((s) => (s.isDirty ? s : { isDirty: true })),

  markClean: () => set({ isDirty: false }),

  setTextParseError: (filename, message) =>
    set((s) => {
      const next = { ...s.textParseErrors };
      if (message == null) {
        if (!(filename in next)) return s;
        delete next[filename];
      } else {
        if (next[filename] === message) return s;
        next[filename] = message;
      }
      return { textParseErrors: next };
    }),

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
    if (Object.keys(get().configFiles).length > 1) {
      await _revalidateAll(get, set);
      return;
    }
    await _revalidateFile(filename, get, set);
  },
}));
