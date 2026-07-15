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
  resetConversationState: () =>
    set((state) => ({
      ...initialState,
      sidebarCollapsed: state.sidebarCollapsed,
      mobileSidebarOpen: state.mobileSidebarOpen,
      sidebarFilter: state.sidebarFilter,
      sidebarSessionFilter: state.sidebarSessionFilter,
      layout: state.layout,
      inFlight: state.inFlight,
    })),

  resetStore: () => {
    clearAllCancelledTimers();
    set(() => ({ ...initialState, inFlight: {} }));
  },
});
