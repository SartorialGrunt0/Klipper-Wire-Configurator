import { beforeEach, describe, expect, it } from 'vitest';

import { useChatReferenceStore } from '@/stores/chatReferenceStore';
import type { ChatReference } from '@/utils/chatReferences';

const PINNED: ChatReference = { id: 'file:printer.cfg', kind: 'file', file: 'printer.cfg' };
const OTHER: ChatReference = { id: 'file:macros.cfg', kind: 'file', file: 'macros.cfg' };
const SECTION: ChatReference = {
  id: 'section:macros.cfg:gcode_macro CLEAN_NOZZLE',
  kind: 'section',
  file: 'macros.cfg',
  section: 'gcode_macro CLEAN_NOZZLE',
  line: 12,
};
const SELECTION_A: ChatReference = {
  id: 'lines:printer.cfg:120-138',
  kind: 'lines',
  file: 'printer.cfg',
  startLine: 120,
  endLine: 138,
  text: 'a: 1',
};
const SELECTION_B: ChatReference = {
  id: 'lines:printer.cfg:200-210',
  kind: 'lines',
  file: 'printer.cfg',
  startLine: 200,
  endLine: 210,
  text: 'b: 2',
};

beforeEach(() => {
  useChatReferenceStore.getState().clear();
});

describe('preview slot', () => {
  it('holds exactly one reference and replaces it on the next click', () => {
    const store = useChatReferenceStore.getState();
    store.setPreview(SECTION);
    expect(useChatReferenceStore.getState().preview).toEqual(SECTION);
    useChatReferenceStore.getState().setPreview(OTHER);
    expect(useChatReferenceStore.getState().preview).toEqual(OTHER);
  });

  it('never accumulates — the slot is a single value, not a list', () => {
    useChatReferenceStore.getState().setPreview(SECTION);
    useChatReferenceStore.getState().setPreview(OTHER);
    useChatReferenceStore.getState().setPreview(PINNED);
    expect(useChatReferenceStore.getState().preview?.id).toBe(PINNED.id);
  });

  it('is NOT sent with the message until it is pinned', () => {
    useChatReferenceStore.getState().setPreview(SECTION);
    expect(useChatReferenceStore.getState().attachedReferences()).toEqual([]);
  });

  it('clears on null', () => {
    useChatReferenceStore.getState().setPreview(SECTION);
    useChatReferenceStore.getState().setPreview(null);
    expect(useChatReferenceStore.getState().preview).toBeNull();
  });
});

describe('promotePreview', () => {
  it('moves the preview into pinned and frees the slot', () => {
    useChatReferenceStore.getState().setPreview(SECTION);
    const promoted = useChatReferenceStore.getState().promotePreview();
    expect(promoted?.id).toBe(SECTION.id);
    expect(useChatReferenceStore.getState().preview).toBeNull();
    expect(useChatReferenceStore.getState().pinned.map((r) => r.id)).toEqual([SECTION.id]);
  });

  it('is a no-op when the slot is empty', () => {
    expect(useChatReferenceStore.getState().promotePreview()).toBeNull();
    expect(useChatReferenceStore.getState().pinned).toEqual([]);
  });

  it('keeps the pinned chip after the preview moves on', () => {
    useChatReferenceStore.getState().setPreview(SECTION);
    useChatReferenceStore.getState().promotePreview();
    useChatReferenceStore.getState().setPreview(OTHER);
    expect(useChatReferenceStore.getState().pinned.map((r) => r.id)).toEqual([SECTION.id]);
    expect(useChatReferenceStore.getState().preview?.id).toBe(OTHER.id);
  });
});

describe('pinned slot', () => {
  it('adds and de-duplicates by id', () => {
    useChatReferenceStore.getState().addPinned(PINNED);
    useChatReferenceStore.getState().addPinned({ ...PINNED });
    expect(useChatReferenceStore.getState().pinned).toHaveLength(1);
  });

  it('removes by id', () => {
    useChatReferenceStore.getState().addPinned(PINNED);
    useChatReferenceStore.getState().addPinned(OTHER);
    useChatReferenceStore.getState().removePinned(PINNED.id);
    expect(useChatReferenceStore.getState().pinned.map((r) => r.id)).toEqual([OTHER.id]);
  });

  it('ignores a removal for an id that is not pinned', () => {
    useChatReferenceStore.getState().addPinned(PINNED);
    useChatReferenceStore.getState().removePinned('nope');
    expect(useChatReferenceStore.getState().pinned).toHaveLength(1);
  });
});

describe('selection slot', () => {
  it('attaches the highlight automatically', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    expect(useChatReferenceStore.getState().attachedReferences().map((r) => r.id))
      .toEqual([SELECTION_A.id]);
  });

  it('replaces the previous selection', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    useChatReferenceStore.getState().setSelection(SELECTION_B);
    expect(useChatReferenceStore.getState().selection?.id).toBe(SELECTION_B.id);
  });

  it('clears when the selection collapses', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    useChatReferenceStore.getState().setSelection(null);
    expect(useChatReferenceStore.getState().selection).toBeNull();
    expect(useChatReferenceStore.getState().attachedReferences()).toEqual([]);
  });

  it('dismissal suppresses that exact range while it stays selected', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    useChatReferenceStore.getState().dismissSelection();
    expect(useChatReferenceStore.getState().selection).toBeNull();
    // The editor keeps reporting the same highlight — it stays dismissed.
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    expect(useChatReferenceStore.getState().selection).toBeNull();
  });

  it('a different range raises the chip again after a dismissal', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    useChatReferenceStore.getState().dismissSelection();
    useChatReferenceStore.getState().setSelection(SELECTION_B);
    expect(useChatReferenceStore.getState().selection?.id).toBe(SELECTION_B.id);
  });

  it('collapsing the selection forgets the dismissal', () => {
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    useChatReferenceStore.getState().dismissSelection();
    useChatReferenceStore.getState().setSelection(null);
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    expect(useChatReferenceStore.getState().selection?.id).toBe(SELECTION_A.id);
  });

  // The editor publishes on every click and keystroke. A redundant publish
  // must not allocate a new state object, or every caret move re-renders
  // every subscriber of this store.
  it('is a no-op when nothing would change', () => {
    const before = useChatReferenceStore.getState();
    before.setSelection(null);
    expect(useChatReferenceStore.getState()).toBe(before);

    useChatReferenceStore.getState().setSelection(SELECTION_A);
    const after = useChatReferenceStore.getState();
    after.setSelection({ ...SELECTION_A });
    expect(useChatReferenceStore.getState()).toBe(after);
  });
});

describe('attachedReferences', () => {
  it('is pinned then selection', () => {
    useChatReferenceStore.getState().addPinned(PINNED);
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    expect(useChatReferenceStore.getState().attachedReferences().map((r) => r.id))
      .toEqual([PINNED.id, SELECTION_A.id]);
  });

  it('collapses a pinned section already covered by the selection range', () => {
    useChatReferenceStore.getState().addPinned({
      id: 'section:printer.cfg:stepper_x',
      kind: 'section',
      file: 'printer.cfg',
      section: 'stepper_x',
      line: 130,
    });
    useChatReferenceStore.getState().setSelection(SELECTION_A);
    expect(useChatReferenceStore.getState().attachedReferences().map((r) => r.id))
      .toEqual([SELECTION_A.id]);
  });

  it('is empty on a fresh store', () => {
    expect(useChatReferenceStore.getState().attachedReferences()).toEqual([]);
  });
});

describe('clear', () => {
  it('drops every slot — what a send and a New Chat both do', () => {
    const store = useChatReferenceStore.getState();
    store.addPinned(PINNED);
    store.setPreview(SECTION);
    store.setSelection(SELECTION_A);
    useChatReferenceStore.getState().clear();
    const after = useChatReferenceStore.getState();
    expect(after.pinned).toEqual([]);
    expect(after.preview).toBeNull();
    expect(after.selection).toBeNull();
    expect(after.dismissedSelectionId).toBeNull();
  });
});

describe('takeAttachedReferences', () => {
  // Regression: the first live build read the store and cleared it as two
  // separate statements, in the wrong order, and sent an empty list.
  it('returns what was attached AND empties every slot in one step', () => {
    const store = useChatReferenceStore.getState();
    store.addPinned(PINNED);
    store.setPreview(SECTION);
    store.setSelection(SELECTION_A);

    const taken = useChatReferenceStore.getState().takeAttachedReferences();
    expect(taken.map((r) => r.id)).toEqual([PINNED.id, SELECTION_A.id]);

    const after = useChatReferenceStore.getState();
    expect(after.pinned).toEqual([]);
    expect(after.preview).toBeNull();
    expect(after.selection).toBeNull();
    expect(after.dismissedSelectionId).toBeNull();
    expect(after.attachedReferences()).toEqual([]);
  });

  it('returns an empty list when nothing was attached', () => {
    expect(useChatReferenceStore.getState().takeAttachedReferences()).toEqual([]);
  });
});
