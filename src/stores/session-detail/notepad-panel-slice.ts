import {
  type NotepadPanelSlice,
  type SessionDetailSliceCreator,
  initialState,
} from "./types";

/**
 * Right-pane Notepad tab state. Session-scoped like the rest of the side
 * panel: the open notepad and sort preference survive conversation switches
 * (reset-slice preserves them) and are stashed/restored per session by the
 * panel-session slice.
 */
export const createNotepadPanelSlice: SessionDetailSliceCreator<
  NotepadPanelSlice
> = (set) => ({
  openNotepadId: initialState.openNotepadId,
  notepadSort: initialState.notepadSort,
  notepadExternalWrite: initialState.notepadExternalWrite,

  openNotepad: (notepadId) =>
    set((state) => {
      state.openNotepadId = notepadId;
    }),

  closeNotepad: () =>
    set((state) => {
      state.openNotepadId = null;
    }),

  setNotepadSort: (sort) =>
    set((state) => {
      state.notepadSort = sort;
    }),

  recordNotepadExternalWrite: (write) =>
    set((state) => {
      state.notepadExternalWrite = write;
    }),
});
