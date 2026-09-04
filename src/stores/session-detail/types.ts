import type { StateCreator } from "zustand";
import type {
  TranscriptMessage,
  MessageContentBlock,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type {
  DocumentRef,
  DocumentFeedbackTarget,
} from "@/lib/document-comments/schemas";
import type { LayoutMode } from "@/lib/sessions/schemas";
import type { NotepadSort } from "@/lib/notepads/schemas";
import type { NotepadExternalWrite } from "@/lib/notepads/sse-reactions";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

export type MobilePanel =
  | "chat"
  | "diff"
  | "docs"
  | "notepad"
  | "specs"
  | "info";
export type RightPaneTab =
  | "diff"
  | "docs"
  | "specs"
  | "alignment"
  | "artifact"
  | "notepad"
  | "memory";

/**
 * How an open notepad divides its pane: the editor alone, both halves, the
 * rendered preview alone, or the review surface — the saved text with its
 * comment highlights and threads, which is a reading mode over the PERSISTED
 * revision rather than over the editor's draft.
 */
export type NotepadViewMode = "write" | "split" | "read" | "review";

/**
 * A one-shot "scroll the transcript to this message" request, set by surfaces
 * that live outside the conversation panel (e.g. the context-artifact panel's
 * source-ref chips) and consumed — then cleared — by the conversation nav hook
 * whose conversation matches.
 */
export interface MessageNavRequest {
  conversationId: string;
  messageIndex: number;
}

export interface SidebarSessionFilter {
  projectName: string;
  sessionName: string;
}

export interface SpecBrowserSelection {
  /** "steering" or a feature name like "browser-notifications" */
  category: string;
  /** Selected filename like "design.md", or null if only category selected */
  file: string | null;
}

/**
 * The agent settings the in-flight turn runs with, stamped onto the optimistic
 * user + streaming assistant rows so they match the durable transcript.
 */
export interface OptimisticAgentSettings {
  modelSelection?: BackendModelSelection;
}

export function agentSettingsStamp(
  settings: OptimisticAgentSettings | undefined,
): Pick<TranscriptMessage, "modelSelection"> {
  return settings?.modelSelection === undefined
    ? {}
    : { modelSelection: settings.modelSelection };
}

export type OptimisticQueueStatus = "pending" | "accepted" | "failed";

export interface OptimisticQueueEntry {
  /** Client-generated id, stable from optimistic add through rollback. */
  tempId: string;
  /** Server-assigned queue id, set once the enqueue is accepted. */
  queueId: string | null;
  content: MessageContentBlock[];
  status: OptimisticQueueStatus;
}

/**
 * The in-flight prompt state for one conversation. Keyed per conversation so
 * every surface rendering a transcript (main panel, split-screen pane, sidebar
 * peek, project cockpit) reads its own conversation's state — a turn streaming
 * in one conversation never leaks its indicator, optimistic rows, or errors
 * into another conversation's view.
 */
export interface ConversationInFlight {
  sending: boolean;
  promptError: string | null;
  promptCancelled: boolean;
  optimisticMessages: TranscriptMessage[];
  optimisticQueue: OptimisticQueueEntry[];
  /**
   * Durable queue ids the server has already reported terminal while an enqueue
   * of this client's was still awaiting its id. In-turn delivery marks a row
   * delivered before the enqueue response is written, so the terminal event
   * routinely arrives first; remembering the id is what lets the entry that
   * adopts it settle immediately instead of standing as pending forever beside
   * the message it already became.
   */
  settledQueueIds: string[];
  messageCountBeforeSubmit: number;
}

export interface LayoutSlice {
  layout: LayoutMode;
  mobilePanel: MobilePanel;
  rightPaneTab: RightPaneTab;
  switchLayout: (mode: LayoutMode, storageKey: string) => void;
  hydrateLayout: (storageKey: string) => void;
  switchMobilePanel: (panel: MobilePanel) => void;
  switchRightPaneTab: (tab: RightPaneTab) => void;
  openContextArtifactPanel: () => void;
}

export interface InFlightSlice {
  /** Per-conversation in-flight prompt state, keyed by conversation id. */
  inFlight: Record<string, ConversationInFlight>;
  submitPrompt: (
    conversationId: string,
    userContent: MessageContentBlock[],
    currentMessageCount: number,
    agentSettings?: OptimisticAgentSettings,
  ) => void;
  receiveStreamContent: (
    conversationId: string,
    userContent: MessageContentBlock[],
    allBlocks: MessageContentBlock[],
    agentSettings?: OptimisticAgentSettings,
  ) => void;
  completePrompt: (conversationId: string) => void;
  failPrompt: (conversationId: string, error: string) => void;
  setQueueError: (conversationId: string, error: string) => void;
  queueMessage: (
    conversationId: string,
    userContent: MessageContentBlock[],
  ) => void;
  addOptimisticQueueEntry(
    conversationId: string,
    tempId: string,
    content: MessageContentBlock[],
  ): void;
  acceptOptimisticQueueEntry(
    conversationId: string,
    tempId: string,
    queueId: string,
  ): void;
  failOptimisticQueueEntry(conversationId: string, tempId: string): void;
  /**
   * Remove accepted optimistic entries whose durable representation has been
   * observed (their durable queue row, or the transcript row a delivery
   * stamped with the queue id). Without this reconcile an accepted entry
   * outlives its server-side prune and re-renders the message as a duplicate.
   */
  resolveOptimisticQueueEntries(
    conversationId: string,
    queueIds: readonly string[],
  ): void;
  cancelOptimisticQueueEntry(conversationId: string, idOrTempId: string): void;
  /**
   * Retire this client's pending row for a durable queue id the server has
   * reported terminal — delivered, cancelled, or failed. A delivered message
   * renders as its transcript row and a cancelled or failed one renders as
   * nothing, so in either case the optimistic stand-in has nothing left to show.
   */
  settleOptimisticQueueEntry(conversationId: string, queueId: string): void;
  rollbackOptimisticQueueEntry(conversationId: string, tempId: string): void;
  dismissError: (conversationId: string) => void;
  markCancelled: (conversationId: string) => void;
  dismissCancelled: (conversationId: string) => void;
  reconcileMessages: (conversationId: string, serverCount: number) => void;
  clearConversationMessages: (conversationId: string) => void;
  /**
   * Move a turn's in-flight state to another key, leaving nothing under the old
   * one. A create-and-send turn starts under a provisional key and adopts into
   * the conversation the server names for it, so the optimistic prompt and the
   * streamed reply already produced surface on that conversation's transcript
   * and no state stays reachable under the key it came from.
   */
  reassignInFlight: (
    fromConversationId: string,
    toConversationId: string,
  ) => void;
  /**
   * Drop a key's in-flight state entirely. Distinct from
   * `clearConversationMessages`, which empties a surviving entry: this removes
   * the entry, so a released key is not reachable at all.
   */
  discardInFlight: (conversationId: string) => void;
}

export interface SidebarSlice {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  sidebarFilter: string;
  sidebarSessionFilter: SidebarSessionFilter | null;
  composerFocused: boolean;
  toggleSidebar: () => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  hydrateSidebar: () => void;
  setSidebarFilter: (value: string) => void;
  setSidebarSessionFilter: (value: SidebarSessionFilter | null) => void;
  setComposerFocused: (focused: boolean) => void;
}

export interface DocumentViewerSlice {
  specBrowserSelection: SpecBrowserSelection | null;
  selectedDocId: string | null;
  // -- Document viewer (multi-doc shell) --
  /** Open documents shown as switchable tabs in the viewer (req 1.2). */
  openDocuments: DocumentRef[];
  /** The active document's normalized `docPath`, or null when none is open. */
  activeDocPath: string | null;
  /**
   * Monotonically increments on every open/activate so the viewer can flash the
   * body on activation (req 1.5) even when the same document is re-opened.
   */
  docActivationNonce: number;
  /** Whether the pending-comments tray's per-comment list is expanded (req 7). */
  pendingTrayExpanded: boolean;
  /** The chosen feedback send destination, retained across sends (req 9.4). */
  feedbackTarget: DocumentFeedbackTarget | null;
  selectSpecCategory: (category: string) => void;
  selectSpecFile: (category: string, file: string) => void;
  clearSpecSelection: () => void;
  openDocById: (docId: string) => void;
  selectDocId: (docId: string | null) => void;
  openDocument: (ref: DocumentRef) => void;
  activateDocument: (docPath: string) => void;
  closeDocument: (docPath: string) => void;
  setPendingTrayExpanded: (expanded: boolean) => void;
  togglePendingTray: () => void;
  setFeedbackTarget: (target: DocumentFeedbackTarget) => void;
}

export interface NotepadPanelSlice {
  /** The notepad open in the right-pane Notepad tab, or null when browsing. */
  openNotepadId: string | null;
  /** The browse list's sort preference. */
  notepadSort: NotepadSort;
  /** The open view's editor/preview split preference. */
  notepadViewMode: NotepadViewMode;
  /**
   * The latest externally written notepad head, recorded by the SSE reaction
   * so an open editor can attribute the update (clean-adopt strip vs dirty
   * collision banner). Transient signal state — never stashed per session.
   */
  notepadExternalWrite: NotepadExternalWrite | null;
  openNotepad: (notepadId: string) => void;
  /**
   * Open a notepad AND route the UI to it: right pane on the Notepad tab,
   * revealed via the split layout when the current layout has no right-pane
   * column. What a clip toast's Open action invokes from outside the panel.
   */
  openNotepadPanel: (notepadId: string) => void;
  closeNotepad: () => void;
  setNotepadSort: (sort: NotepadSort) => void;
  setNotepadViewMode: (mode: NotepadViewMode) => void;
  recordNotepadExternalWrite: (write: NotepadExternalWrite) => void;
}

export interface SessionUiSlice {
  isVoiceRecording: boolean;
  promptPlaceholder: string | null;
  showDeleteConfirm: boolean;
  pendingQuestions: AskQuestionItem[] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  /** Pending transcript-scroll request, or null when none is in flight. */
  messageNavRequest: MessageNavRequest | null;
  startRecording: () => void;
  stopRecording: () => void;
  showPlaceholder: (text: string) => void;
  clearPlaceholder: () => void;
  requestDeleteSession: () => void;
  cancelDeleteSession: () => void;
  showQuestions: (questionId: string, questions: AskQuestionItem[]) => void;
  navigateQuestion: (index: number) => void;
  clearQuestions: () => void;
  requestMessageNav: (conversationId: string, messageIndex: number) => void;
  clearMessageNavRequest: () => void;
}

/**
 * The side-panel configuration saved per session so switching sessions can
 * restore what the user was looking at (tab, open documents, spec selection).
 * Browser-side only — nothing here is persisted across reloads.
 */
export interface PanelSessionSnapshot {
  rightPaneTab: RightPaneTab;
  openDocuments: DocumentRef[];
  activeDocPath: string | null;
  specBrowserSelection: SpecBrowserSelection | null;
  pendingTrayExpanded: boolean;
  openNotepadId: string | null;
  notepadSort: NotepadSort;
  notepadViewMode: NotepadViewMode;
}

export interface PanelSessionSlice {
  /** Key of the session whose side-panel state the store currently holds. */
  panelSessionKey: string | null;
  /** Saved side-panel snapshots for previously visited sessions. */
  panelSessionMemory: Record<string, PanelSessionSnapshot>;
  activatePanelSession: (key: string) => void;
}

/**
 * Composite session identity for panel memory. NUL cannot appear in directory
 * names, so the join is unambiguous for any project/session pair.
 */
export function panelSessionKeyFor(
  projectName: string,
  sessionName: string,
): string {
  return `${projectName}\u0000${sessionName}`;
}

export interface ResetSlice {
  resetConversationState: () => void;
  resetStore: () => void;
}

export type SessionDetailStore = LayoutSlice &
  InFlightSlice &
  SidebarSlice &
  DocumentViewerSlice &
  NotepadPanelSlice &
  SessionUiSlice &
  PanelSessionSlice &
  ResetSlice;

/** The state-only projection: every field slices contribute, no actions. */
export type SessionDetailState = Pick<
  SessionDetailStore,
  | "layout"
  | "mobilePanel"
  | "rightPaneTab"
  | "inFlight"
  | "sidebarCollapsed"
  | "mobileSidebarOpen"
  | "sidebarFilter"
  | "sidebarSessionFilter"
  | "composerFocused"
  | "specBrowserSelection"
  | "selectedDocId"
  | "openDocuments"
  | "activeDocPath"
  | "docActivationNonce"
  | "pendingTrayExpanded"
  | "feedbackTarget"
  | "openNotepadId"
  | "notepadSort"
  | "notepadViewMode"
  | "notepadExternalWrite"
  | "panelSessionKey"
  | "panelSessionMemory"
  | "isVoiceRecording"
  | "promptPlaceholder"
  | "showDeleteConfirm"
  | "pendingQuestions"
  | "pendingQuestionId"
  | "currentQuestionIndex"
  | "messageNavRequest"
>;

/**
 * Slice creator bound to the immer middleware over the full composed store, so
 * every slice's `set`/`get` sees sibling slices — the document-viewer slice can
 * route the layout, the reset slice can restore all fields.
 */
export type SessionDetailSliceCreator<TSlice> = StateCreator<
  SessionDetailStore,
  [["zustand/immer", never]],
  [],
  TSlice
>;

/**
 * Shared default returned for conversations with no in-flight state. A single
 * frozen instance so keyed selectors keep referential stability for missing
 * entries (no per-render churn).
 */
export const EMPTY_IN_FLIGHT: ConversationInFlight = Object.freeze({
  sending: false,
  promptError: null,
  promptCancelled: false,
  optimisticMessages: [],
  optimisticQueue: [],
  settledQueueIds: [],
  messageCountBeforeSubmit: 0,
});

export function selectInFlightFor(
  state: Pick<SessionDetailState, "inFlight">,
  conversationId: string,
): ConversationInFlight {
  return state.inFlight[conversationId] ?? EMPTY_IN_FLIGHT;
}

/**
 * Get-or-create the in-flight entry for a conversation inside a producer.
 * Write actions that begin a turn use this; actions that only clear or adjust
 * existing state read the entry directly and no-op when absent, so they never
 * materialize entries for conversations that were never in flight.
 */
export function ensureInFlight(
  state: Pick<SessionDetailState, "inFlight">,
  conversationId: string,
): ConversationInFlight {
  const existing = state.inFlight[conversationId];
  if (existing) return existing;
  const created: ConversationInFlight = {
    sending: false,
    promptError: null,
    promptCancelled: false,
    optimisticMessages: [],
    optimisticQueue: [],
    settledQueueIds: [],
    messageCountBeforeSubmit: 0,
  };
  state.inFlight[conversationId] = created;
  return created;
}

export const SIDEBAR_STORAGE_KEY = "cc-sidebar-collapsed";

export const validLayouts: LayoutMode[] = [
  "conversation",
  "split",
  "panes",
  "diff",
];

export const initialState: SessionDetailState = {
  layout: "conversation",
  mobilePanel: "chat",
  // Alignment is the default: the diff tab is expensive to render and rarely
  // the first thing needed, so it must never be the tab a session opens on.
  rightPaneTab: "alignment",
  isVoiceRecording: false,
  promptPlaceholder: null,
  inFlight: {},
  showDeleteConfirm: false,
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  sidebarFilter: "",
  sidebarSessionFilter: null,
  pendingQuestions: null,
  pendingQuestionId: null,
  currentQuestionIndex: 0,
  specBrowserSelection: null,
  selectedDocId: null,
  composerFocused: false,
  openDocuments: [],
  activeDocPath: null,
  docActivationNonce: 0,
  pendingTrayExpanded: false,
  feedbackTarget: null,
  openNotepadId: null,
  notepadSort: "recency",
  notepadViewMode: "split",
  notepadExternalWrite: null,
  messageNavRequest: null,
  panelSessionKey: null,
  panelSessionMemory: {},
};
