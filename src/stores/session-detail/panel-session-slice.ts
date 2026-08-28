import {
  type PanelSessionSlice,
  type PanelSessionSnapshot,
  type SessionDetailSliceCreator,
  initialState,
} from "./types";

/**
 * Per-session side-panel memory. The right pane (Diff/Docs/Alignment/Specs/
 * Artifact) belongs to the session, not to one conversation: switching
 * conversations within a session must not disturb it (resetConversationState
 * preserves these fields), while switching sessions stashes the outgoing
 * session's panel and restores what the user last had open in the incoming one.
 * In-memory only by design — a reload starts every session at the default tab.
 */
export const createPanelSessionSlice: SessionDetailSliceCreator<
  PanelSessionSlice
> = (set) => ({
  panelSessionKey: initialState.panelSessionKey,
  panelSessionMemory: initialState.panelSessionMemory,

  activatePanelSession: (key) =>
    set((state) => {
      if (state.panelSessionKey === key) return;

      if (state.panelSessionKey !== null) {
        const snapshot: PanelSessionSnapshot = {
          rightPaneTab: state.rightPaneTab,
          openDocuments: state.openDocuments.map((d) => ({ ...d })),
          activeDocPath: state.activeDocPath,
          specBrowserSelection: state.specBrowserSelection
            ? { ...state.specBrowserSelection }
            : null,
          pendingTrayExpanded: state.pendingTrayExpanded,
          openNotepadId: state.openNotepadId,
          notepadSort: state.notepadSort,
          notepadViewMode: state.notepadViewMode,
        };
        state.panelSessionMemory[state.panelSessionKey] = snapshot;
      }

      const saved = state.panelSessionMemory[key];
      state.rightPaneTab = saved?.rightPaneTab ?? initialState.rightPaneTab;
      state.openDocuments = saved
        ? saved.openDocuments.map((d) => ({ ...d }))
        : [];
      state.activeDocPath = saved?.activeDocPath ?? null;
      state.specBrowserSelection = saved?.specBrowserSelection
        ? { ...saved.specBrowserSelection }
        : null;
      state.pendingTrayExpanded = saved?.pendingTrayExpanded ?? false;
      state.openNotepadId = saved?.openNotepadId ?? initialState.openNotepadId;
      state.notepadSort = saved?.notepadSort ?? initialState.notepadSort;
      state.notepadViewMode =
        saved?.notepadViewMode ?? initialState.notepadViewMode;
      // Re-presenting a restored document counts as an activation: the bump
      // breaks DocsPanel's browse latch (its browseAtNonce no longer matches)
      // and flashes the viewer body, exactly as re-opening the document would.
      if (state.activeDocPath !== null) {
        state.docActivationNonce += 1;
      }
      state.panelSessionKey = key;
    }),
});
