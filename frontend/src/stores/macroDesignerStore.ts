import { create } from 'zustand';
import type {
  DockPosition,
  MacroDesignerPersistedState,
  MacroDraft,
  NoGoZone,
} from '../types/macroDesigner';

const STORAGE_KEY = 'kwc.macroDesigner';

function loadPersistedState(): MacroDesignerPersistedState {
  if (typeof window === 'undefined') {
    return {
      drafts: [],
      noGoZones: [],
      dockPosition: null,
      rotation: 0,
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        drafts: [],
        noGoZones: [],
        dockPosition: null,
        rotation: 0,
      };
    }
    const parsed = JSON.parse(raw) as Partial<MacroDesignerPersistedState>;
    return {
      drafts: [],
      noGoZones: [],
      dockPosition: null,
      rotation: parsed.rotation === 90 || parsed.rotation === 180 || parsed.rotation === 270
        ? parsed.rotation
        : 0,
    };
  } catch {
    return {
      drafts: [],
      noGoZones: [],
      dockPosition: null,
      rotation: 0,
    };
  }
}

function persistState(state: MacroDesignerPersistedState) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function now() {
  return Date.now();
}

export function createDefaultDraft(name = 'NEW_MACRO'): MacroDraft {
  const stamp = now();
  return {
    id: `draft-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: name,
    renameExisting: '',
    description: '',
    variables: '',
    gcode: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

interface MacroDesignerState extends MacroDesignerPersistedState {
  hydratePersistedState: (state: Partial<MacroDesignerPersistedState>) => void;
  exportPersistedState: () => MacroDesignerPersistedState;
  createDraft: (name?: string, seed?: Partial<MacroDraft>) => MacroDraft;
  upsertDraftForSourceKey: (
    sourceKey: string,
    seed: Pick<MacroDraft, 'title' | 'renameExisting' | 'description' | 'variables' | 'gcode'>,
  ) => MacroDraft;
  updateDraft: (id: string, updates: Partial<Omit<MacroDraft, 'id' | 'createdAt'>>) => void;
  duplicateDraft: (id: string) => MacroDraft | null;
  deleteDraft: (id: string) => void;
  clearPersistedState: () => void;
  setRotation: (rotation: 0 | 90 | 180 | 270) => void;
  addNoGoZone: (zone?: Partial<NoGoZone>) => NoGoZone;
  updateNoGoZone: (id: string, updates: Partial<NoGoZone>) => void;
  deleteNoGoZone: (id: string) => void;
  setDockPosition: (position: DockPosition | null) => void;
}

const initialState = loadPersistedState();

export const useMacroDesignerStore = create<MacroDesignerState>((set, get) => ({
  ...initialState,

  hydratePersistedState: (state) => {
    const next: MacroDesignerPersistedState = {
      drafts: Array.isArray(state.drafts) ? state.drafts : get().drafts,
      noGoZones: Array.isArray(state.noGoZones) ? state.noGoZones : get().noGoZones,
      dockPosition: state.dockPosition === undefined ? get().dockPosition : state.dockPosition,
      rotation: state.rotation === 90 || state.rotation === 180 || state.rotation === 270
        ? state.rotation
        : (state.rotation === 0 ? 0 : get().rotation),
    };
    persistState(next);
    set(next);
  },

  exportPersistedState: () => ({
    drafts: get().drafts,
    noGoZones: get().noGoZones,
    dockPosition: get().dockPosition,
    rotation: get().rotation,
  }),

  createDraft: (name, seed) => {
    const base = createDefaultDraft(name);
    const draft = {
      ...base,
      ...seed,
      id: base.id,
      createdAt: base.createdAt,
      updatedAt: now(),
    };
    set((state) => {
      const next = { ...state, drafts: [...state.drafts, draft] };
      persistState({
        drafts: next.drafts,
        noGoZones: next.noGoZones,
        dockPosition: next.dockPosition,
        rotation: next.rotation,
      });
      return { drafts: next.drafts };
    });
    return draft;
  },

  upsertDraftForSourceKey: (sourceKey, seed) => {
    const stamp = now();
    let nextDraft: MacroDraft | null = null;

    set((state) => {
      const existingIndex = state.drafts.findIndex((draft) => draft.sourceKey === sourceKey);
      let drafts: MacroDraft[];

      if (existingIndex !== -1) {
        drafts = [...state.drafts];
        const existing = drafts[existingIndex];
        nextDraft = {
          ...existing,
          ...seed,
          sourceKey,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: stamp,
        };
        drafts[existingIndex] = nextDraft;
      } else {
        const base = createDefaultDraft(seed.title);
        nextDraft = {
          ...base,
          ...seed,
          sourceKey,
          id: base.id,
          createdAt: base.createdAt,
          updatedAt: stamp,
        };
        drafts = [...state.drafts, nextDraft];
      }

      persistState({
        drafts,
        noGoZones: state.noGoZones,
        dockPosition: state.dockPosition,
        rotation: state.rotation,
      });
      return { drafts };
    });

    return nextDraft!;
  },

  updateDraft: (id, updates) => set((state) => {
    const drafts = state.drafts.map((draft) => (
      draft.id === id
        ? { ...draft, ...updates, updatedAt: now() }
        : draft
    ));
    persistState({
      drafts,
      noGoZones: state.noGoZones,
      dockPosition: state.dockPosition,
      rotation: state.rotation,
    });
    return { drafts };
  }),

  duplicateDraft: (id) => {
    const source = get().drafts.find((draft) => draft.id === id);
    if (!source) return null;
    return get().createDraft(`${source.title}_COPY`, {
      renameExisting: source.renameExisting,
      description: source.description,
      variables: source.variables,
      gcode: source.gcode,
      sourceKey: undefined,
    });
  },

  deleteDraft: (id) => set((state) => {
    const drafts = state.drafts.filter((draft) => draft.id !== id);
    persistState({
      drafts,
      noGoZones: state.noGoZones,
      dockPosition: state.dockPosition,
      rotation: state.rotation,
    });
    return { drafts };
  }),

  clearPersistedState: () => set(() => {
    const next: MacroDesignerPersistedState = {
      drafts: [],
      noGoZones: [],
      dockPosition: null,
      rotation: 0,
    };
    persistState(next);
    return next;
  }),

  setRotation: (rotation) => set((state) => {
    persistState({
      drafts: state.drafts,
      noGoZones: state.noGoZones,
      dockPosition: state.dockPosition,
      rotation,
    });
    return { rotation };
  }),

  addNoGoZone: (zone) => {
    const nextZone: NoGoZone = {
      id: `zone-${now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: zone?.name || `Zone ${get().noGoZones.length + 1}`,
      x: typeof zone?.x === 'number' ? zone.x : 0,
      y: typeof zone?.y === 'number' ? zone.y : 0,
      width: typeof zone?.width === 'number' ? zone.width : 20,
      height: typeof zone?.height === 'number' ? zone.height : 20,
    };
    set((state) => {
      const noGoZones = [...state.noGoZones, nextZone];
      persistState({
        drafts: state.drafts,
        noGoZones,
        dockPosition: state.dockPosition,
        rotation: state.rotation,
      });
      return { noGoZones };
    });
    return nextZone;
  },

  updateNoGoZone: (id, updates) => set((state) => {
    const noGoZones = state.noGoZones.map((zone) => (
      zone.id === id ? { ...zone, ...updates } as NoGoZone : zone
    ));
    persistState({
      drafts: state.drafts,
      noGoZones,
      dockPosition: state.dockPosition,
      rotation: state.rotation,
    });
    return { noGoZones };
  }),

  deleteNoGoZone: (id) => set((state) => {
    const noGoZones = state.noGoZones.filter((zone) => zone.id !== id);
    persistState({
      drafts: state.drafts,
      noGoZones,
      dockPosition: state.dockPosition,
      rotation: state.rotation,
    });
    return { noGoZones };
  }),

  setDockPosition: (dockPosition) => set((state) => {
    persistState({
      drafts: state.drafts,
      noGoZones: state.noGoZones,
      dockPosition,
      rotation: state.rotation,
    });
    return { dockPosition };
  }),
}));