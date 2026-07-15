import {
  type DocumentViewerSlice,
  type SessionDetailSliceCreator,
  initialState,
} from "./types";

export const createDocumentViewerSlice: SessionDetailSliceCreator<
  DocumentViewerSlice
> = (set) => ({
  specBrowserSelection: initialState.specBrowserSelection,
  selectedDocId: initialState.selectedDocId,
  openDocuments: initialState.openDocuments,
  activeDocPath: initialState.activeDocPath,
  docActivationNonce: initialState.docActivationNonce,
  pendingTrayExpanded: initialState.pendingTrayExpanded,
  feedbackTarget: initialState.feedbackTarget,

  // -- Spec Browser --

  selectSpecCategory: (category) =>
    set((state) => {
      state.specBrowserSelection = { category, file: null };
    }),

  selectSpecFile: (category, file) =>
    set((state) => {
      state.specBrowserSelection = { category, file };
    }),

  clearSpecSelection: () =>
    set((state) => {
      state.specBrowserSelection = null;
    }),

  // -- Docs Panel --

  openDocById: (docId) =>
    set((state) => {
      state.selectedDocId = docId;
      state.rightPaneTab = "docs";
      state.mobilePanel = "docs";
    }),

  selectDocId: (docId) =>
    set((state) => {
      state.selectedDocId = docId;
    }),

  // -- Document viewer (multi-doc shell) --

  // Open a document by its canonical `docPath`: add a tab if not already open
  // (dedup by `docPath`, refreshing the title), make it active, route the right
  // pane / mobile panel to Docs, and bump the activation nonce so the body
  // flashes (reqs 1.1, 1.2, 1.5).
  openDocument: (ref) =>
    set((state) => {
      const existing = state.openDocuments.find(
        (d) => d.docPath === ref.docPath,
      );
      if (existing) {
        existing.title = ref.title;
      } else {
        state.openDocuments.push(ref);
      }
      state.activeDocPath = ref.docPath;
      state.docActivationNonce += 1;
      state.rightPaneTab = "docs";
      state.mobilePanel = "docs";
      // The viewer lives in the right pane, but two layouts give that pane no
      // column to occupy: panes replaces the content area with a full-width
      // conversation grid, and conversation-only is a single full-width column.
      // A markdown file card clicked in either would otherwise mutate this
      // state but never reveal the viewer, so opening switches to a layout that
      // shows it — panes drops to default, conversation-only opens the split
      // 50/50 view (req 4.3). This intentionally does not persist over the
      // user's saved layout preference (openDocuments is itself not persisted);
      // a reload restores it.
      if (state.layout === "panes") {
        state.layout = "default";
      } else if (state.layout === "conversation") {
        state.layout = "split";
      }
    }),

  // Activate an already-open tab (req 1.3). Bumps the nonce so the body flashes
  // (req 1.5); a no-op for an unknown path so a stale tab click cannot blank
  // the viewer.
  activateDocument: (docPath) =>
    set((state) => {
      if (!state.openDocuments.some((d) => d.docPath === docPath)) return;
      state.activeDocPath = docPath;
      state.docActivationNonce += 1;
    }),

  // Close a tab. When the active tab closes, fall through to the tab that takes
  // its slot (or the previous one when the last tab closed), or null when no
  // documents remain.
  closeDocument: (docPath) =>
    set((state) => {
      const idx = state.openDocuments.findIndex((d) => d.docPath === docPath);
      if (idx === -1) return;
      state.openDocuments.splice(idx, 1);
      if (state.activeDocPath !== docPath) return;
      const next =
        state.openDocuments[idx] ?? state.openDocuments[idx - 1] ?? null;
      state.activeDocPath = next?.docPath ?? null;
      if (next) state.docActivationNonce += 1;
    }),

  setPendingTrayExpanded: (expanded) =>
    set((state) => {
      state.pendingTrayExpanded = expanded;
    }),

  togglePendingTray: () =>
    set((state) => {
      state.pendingTrayExpanded = !state.pendingTrayExpanded;
    }),

  setFeedbackTarget: (target) =>
    set((state) => {
      state.feedbackTarget = target;
    }),
});
