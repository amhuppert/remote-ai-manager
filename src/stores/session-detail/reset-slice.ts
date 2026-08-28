import { clearAllCancelledTimers } from "./in-flight-slice";
import {
  type ResetSlice,
  type SessionDetailSliceCreator,
  initialState,
} from "./types";

export const createResetSlice: SessionDetailSliceCreator<ResetSlice> = (
  set,
) => ({
  // Reset everything scoped to a single conversation workspace. Rail-owned
  // state (collapse, mobile drawer, filters) belongs to the host shell, which
  // stays mounted while workspaces swap, so it must survive this reset. The
  // page-level layout is host-shell state too — it is hydrated once at the
  // page and not re-read per conversation, so it must also survive the reset,
  // otherwise activating another conversation silently reverts the rendered
  // layout to the default (req 3.5, 5.2). In-flight prompt state is keyed per
  // conversation — it belongs to each conversation, not to the workspace that
  // happens to display it — so a workspace swap must not clear another
  // conversation's streaming turn out from under the panes/peek surfaces.
  // The side panel (active tab, open documents, spec selection) is session-
  // scoped: it survives conversation switches and is stashed/restored per
  // session by the panel-session slice, not cleared here.
  resetConversationState: () =>
    set((state) => ({
      ...initialState,
      sidebarCollapsed: state.sidebarCollapsed,
      mobileSidebarOpen: state.mobileSidebarOpen,
      sidebarFilter: state.sidebarFilter,
      sidebarSessionFilter: state.sidebarSessionFilter,
      layout: state.layout,
      inFlight: state.inFlight,
      rightPaneTab: state.rightPaneTab,
      openDocuments: state.openDocuments,
      activeDocPath: state.activeDocPath,
      docActivationNonce: state.docActivationNonce,
      specBrowserSelection: state.specBrowserSelection,
      pendingTrayExpanded: state.pendingTrayExpanded,
      openNotepadId: state.openNotepadId,
      notepadSort: state.notepadSort,
      notepadViewMode: state.notepadViewMode,
      panelSessionKey: state.panelSessionKey,
      panelSessionMemory: state.panelSessionMemory,
    })),

  resetStore: () => {
    clearAllCancelledTimers();
    set(() => ({ ...initialState, inFlight: {} }));
  },
});
