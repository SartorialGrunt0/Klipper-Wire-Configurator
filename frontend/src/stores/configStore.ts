import { create } from 'zustand';
import type { ConfigFile, ConfigSection, ConfigParam, ValidationResult, SectionSchema } from '../types/config';

/** Debounced revalidation timer — shared across all mutation methods. */
let _revalidateTimer: ReturnType<typeof setTimeout> | null = null;

const UNKNOWN_PARAM_WARNING_RE = /^Unknown parameter '([^']+)' for section \[([^\]]+)\]\.?$/;

function matchesSectionIdentity(section: ConfigSection, fullHeader: string, lineNumber?: number): boolean {
  if (section.full_header !== fullHeader) return false;
  if (lineNumber == null || lineNumber === 0) return true;
  return section.line_number === lineNumber;
}

function sanitizeValidationResult(
  result: ValidationResult,
  schemas: Record<string, SectionSchema>,
): ValidationResult {
  if (result.errors.length === 0 || Object.keys(schemas).length === 0) {
    return result;
  }

  const filteredErrors = result.errors.filter((error) => {
    if (error.severity !== 'warning') return true;

    const match = UNKNOWN_PARAM_WARNING_RE.exec(error.message);
    if (!match) return true;

    const [, paramName, sectionType] = match;
    const schema = schemas[sectionType];
    if (!schema) return true;

    return !schema.params.some((param) => param.name === paramName);
  });

  if (filteredErrors.length === result.errors.length) {
    return result;
  }

  return {
    has_errors: filteredErrors.some((error) => error.severity === 'error'),
    has_warnings: filteredErrors.some((error) => error.severity === 'warning'),
    errors: filteredErrors,
  };
}

function sanitizeValidationMap(
  results: Record<string, ValidationResult>,
  schemas: Record<string, SectionSchema>,
): Record<string, ValidationResult> {
  return Object.fromEntries(
    Object.entries(results).map(([filename, result]) => [filename, sanitizeValidationResult(result, schemas)]),
  );
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
    const sanitized = sanitizeValidationResult(result, get().schemas);
    set((state) => ({
      validation: { ...state.validation, [filename]: sanitized },
    }));
  } catch {
    // Validation API unavailable — skip silently
  }
}

async function _revalidateAll(get: () => ConfigState, set: (partial: Partial<ConfigState> | ((s: ConfigState) => Partial<ConfigState>)) => void) {
  const { configFiles, schemas } = get();
  const filenames = Object.keys(configFiles);
  if (filenames.length === 0) return;

  if (filenames.length === 1) {
    await _revalidateFile(filenames[0], get, set);
    return;
  }

  const api = await import('../services/api');
  try {
    const results = await api.validateProject(configFiles);
    const sanitized = sanitizeValidationMap(results, schemas);
    set((state) => ({
      validation: { ...state.validation, ...sanitized },
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
  originalTexts: Record<string, string>; // original exported text at import time
  isDirty: boolean; // true when config has unsaved changes
  textEditorDirty: boolean; // true when the text editor has unapplied draft changes
  textDraftFile: string | null;
  textDraftText: string;

  /* ── Actions ──────────────────────────────────────── */
  setConfigFile: (filename: string, config: ConfigFile) => void;
  removeConfigFile: (filename: string) => void;
  setActiveFile: (filename: string) => void;
  setValidation: (filename: string, result: ValidationResult) => void;
  setSchemas: (schemas: Record<string, SectionSchema>) => void;
  setSelectedSection: (header: string | null) => void;

  /* Section operations */
  addSection: (filename: string, section: ConfigSection) => void;
  upsertSection: (filename: string, section: ConfigSection, previousFullHeader?: string) => void;
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

  /* File operations */
  renameConfigFile: (oldName: string, newName: string) => void;
  copyConfigFile: (sourceName: string, newName: string) => void;

  /* Include directives */
  addInclude: (filename: string, includePath: string) => void;
  removeInclude: (filename: string, includePath: string) => void;

  /* Dirty tracking */
  markDirty: () => void;
  markClean: () => void;
  setTextEditorDirty: (dirty: boolean) => void;
  setTextDraft: (filename: string, text: string) => void;
  clearTextDraft: () => void;

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
  originalTexts: {},
  isDirty: false,
  textEditorDirty: false,
  textDraftFile: null,
  textDraftText: '',

  setConfigFile: (filename, config) =>
    set((s) => ({
      configFiles: { ...s.configFiles, [filename]: config },
    })),

  removeConfigFile: (filename) =>
    set((s) => {
      if (!s.configFiles[filename]) return s;
      const nextConfigFiles = { ...s.configFiles };
      delete nextConfigFiles[filename];

      const nextValidation = { ...s.validation };
      delete nextValidation[filename];

      const remainingFiles = Object.keys(nextConfigFiles);

      return {
        isDirty: true,
        configFiles: nextConfigFiles,
        validation: nextValidation,
        activeFile: s.activeFile === filename ? remainingFiles[0] || 'printer.cfg' : s.activeFile,
        selectedSection: s.activeFile === filename ? null : s.selectedSection,
        textDraftFile: s.textDraftFile === filename ? null : s.textDraftFile,
        textDraftText: s.textDraftFile === filename ? '' : s.textDraftText,
      };
    }),

  setActiveFile: (filename) => set({ activeFile: filename }),

  setValidation: (filename, result) =>
    set((s) => ({
      validation: { ...s.validation, [filename]: sanitizeValidationResult(result, s.schemas) },
    })),

  setSchemas: (schemas) =>
    set((s) => ({
      schemas,
      validation: Object.fromEntries(
        Object.entries(s.validation).map(([filename, result]) => [filename, sanitizeValidationResult(result, schemas)]),
      ),
    })),

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

  upsertSection: (filename, section, previousFullHeader) => {
    set((s) => {
      const cf = s.configFiles[filename];
      if (!cf) return s;
      const sections = [...cf.sections];
      const previousIndex = previousFullHeader
        ? sections.findIndex((candidate) => candidate.full_header === previousFullHeader)
        : -1;
      const existingIndex = sections.findIndex((candidate) => candidate.full_header === section.full_header);

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
      const removeIndex = cf.sections.findIndex((sec) => matchesSectionIdentity(sec, fullHeader, lineNumber));
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
      originalTexts: {},
      isDirty: false,
      textEditorDirty: false,
      textDraftFile: null,
      textDraftText: '',
    }),

  loadConfigs: (configs) =>
    set({
      configFiles: configs,
      activeFile: Object.keys(configs)[0] || 'printer.cfg',
      isDirty: false,
      textEditorDirty: false,
      textDraftFile: null,
      textDraftText: '',
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
        textDraftFile: s.textDraftFile === oldName ? newName : s.textDraftFile,
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

  markClean: () => set({
    isDirty: false,
    textEditorDirty: false,
    textDraftFile: null,
    textDraftText: '',
  }),

  setTextEditorDirty: (dirty) =>
    set((s) => (s.textEditorDirty === dirty ? s : { textEditorDirty: dirty })),

  setTextDraft: (filename, text) =>
    set((s) => {
      if (s.textDraftFile === filename && s.textDraftText === text) {
        return s;
      }
      return {
        textDraftFile: filename,
        textDraftText: text,
      };
    }),

  clearTextDraft: () =>
    set((s) => {
      if (s.textDraftFile == null && s.textDraftText === '') {
        return s;
      }
      return {
        textDraftFile: null,
        textDraftText: '',
      };
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
