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
  notepadViewMode: initialState.notepadViewMode,
  notepadExternalWrite: initialState.notepadExternalWrite,

  openNotepad: (notepadId) =>
    set((state) => {
      state.openNotepadId = notepadId;
    }),

  // Mirrors openContextArtifactPanel's reveal rule: panes and conversation-only
  // give the right pane no column, so opening switches to the split layout
  // (without persisting over the user's saved layout preference).
  openNotepadPanel: (notepadId) =>
    set((state) => {
      state.openNotepadId = notepadId;
      state.rightPaneTab = "notepad";
      if (state.layout === "panes" || state.layout === "conversation") {
        state.layout = "split";
      }
    }),

  closeNotepad: () =>
    set((state) => {
      state.openNotepadId = null;
    }),

  setNotepadSort: (sort) =>
    set((state) => {
      state.notepadSort = sort;
    }),

  setNotepadViewMode: (mode) =>
    set((state) => {
      state.notepadViewMode = mode;
    }),

  recordNotepadExternalWrite: (write) =>
    set((state) => {
      state.notepadExternalWrite = write;
    }),
});
