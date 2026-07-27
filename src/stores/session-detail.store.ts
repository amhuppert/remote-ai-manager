import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createDocumentViewerSlice } from "./session-detail/document-viewer-slice";
import { createInFlightSlice } from "./session-detail/in-flight-slice";
import { createLayoutSlice } from "./session-detail/layout-slice";
import { createPanelSessionSlice } from "./session-detail/panel-session-slice";
import { createResetSlice } from "./session-detail/reset-slice";
import { createSessionUiSlice } from "./session-detail/session-ui-slice";
import { createSidebarSlice } from "./session-detail/sidebar-slice";
import { EMPTY_IN_FLIGHT } from "./session-detail/types";
import type { SessionDetailStore } from "./session-detail/types";

export type {
  ConversationInFlight,
  OptimisticAgentSettings,
  SessionDetailState,
} from "./session-detail/types";
export {
  EMPTY_IN_FLIGHT,
  selectInFlightFor,
  panelSessionKeyFor,
} from "./session-detail/types";

/**
 * The session-detail workspace store, composed from concern-scoped slices under
 * `./session-detail/`. Every slice's `set`/`get` sees the whole store, so
 * cross-concern writes stay expressible (the document-viewer slice routing the
 * layout, the reset slice restoring all fields) while each slice owns one
 * concern's state and actions.
 */
export const useSessionDetailStore = create<SessionDetailStore>()(
  immer((...args) => ({
    ...createLayoutSlice(...args),
    ...createInFlightSlice(...args),
    ...createSidebarSlice(...args),
    ...createDocumentViewerSlice(...args),
    ...createSessionUiSlice(...args),
    ...createPanelSessionSlice(...args),
    ...createResetSlice(...args),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useLayout = () => useSessionDetailStore((s) => s.layout);
export const useMobilePanel = () => useSessionDetailStore((s) => s.mobilePanel);
export const usePromptPlaceholder = () =>
  useSessionDetailStore((s) => s.promptPlaceholder);

// Keyed in-flight selectors: each returns one conversation's slice with a
// stable default for conversations that were never in flight (focused
// accessors per PERFORMANCE.md — subscribe to one field, not the whole map).
export const useSendingFor = (conversationId: string) =>
  useSessionDetailStore((s) => s.inFlight[conversationId]?.sending ?? false);
export const usePromptErrorFor = (conversationId: string) =>
  useSessionDetailStore((s) => s.inFlight[conversationId]?.promptError ?? null);
export const usePromptCancelledFor = (conversationId: string) =>
  useSessionDetailStore(
    (s) => s.inFlight[conversationId]?.promptCancelled ?? false,
  );
export const useOptimisticMessagesFor = (conversationId: string) =>
  useSessionDetailStore(
    (s) =>
      s.inFlight[conversationId]?.optimisticMessages ??
      EMPTY_IN_FLIGHT.optimisticMessages,
  );
export const useOptimisticQueueFor = (conversationId: string) =>
  useSessionDetailStore(
    (s) =>
      s.inFlight[conversationId]?.optimisticQueue ??
      EMPTY_IN_FLIGHT.optimisticQueue,
  );
export const useMessageCountBeforeSubmitFor = (conversationId: string) =>
  useSessionDetailStore(
    (s) => s.inFlight[conversationId]?.messageCountBeforeSubmit ?? 0,
  );
export const useShowDeleteConfirm = () =>
  useSessionDetailStore((s) => s.showDeleteConfirm);
export const useSidebarCollapsed = () =>
  useSessionDetailStore((s) => s.sidebarCollapsed);
export const useMobileSidebarOpen = () =>
  useSessionDetailStore((s) => s.mobileSidebarOpen);
export const useSidebarFilter = () =>
  useSessionDetailStore((s) => s.sidebarFilter);
export const useSidebarSessionFilter = () =>
  useSessionDetailStore((s) => s.sidebarSessionFilter);
export const useComposerFocused = () =>
  useSessionDetailStore((s) => s.composerFocused);
export const useRightPaneTab = () =>
  useSessionDetailStore((s) => s.rightPaneTab);
export const useSpecBrowserSelection = () =>
  useSessionDetailStore((s) => s.specBrowserSelection);
export const useSelectedDocId = () =>
  useSessionDetailStore((s) => s.selectedDocId);
export const useOpenDocuments = () =>
  useSessionDetailStore((s) => s.openDocuments);
export const useActiveDocPath = () =>
  useSessionDetailStore((s) => s.activeDocPath);
export const useDocActivationNonce = () =>
  useSessionDetailStore((s) => s.docActivationNonce);
export const useMessageNavRequest = () =>
  useSessionDetailStore((s) => s.messageNavRequest);
export const usePendingTrayExpanded = () =>
  useSessionDetailStore((s) => s.pendingTrayExpanded);
export const useFeedbackTarget = () =>
  useSessionDetailStore((s) => s.feedbackTarget);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useSwitchLayout = () =>
  useSessionDetailStore((s) => s.switchLayout);
export const useHydrateLayout = () =>
  useSessionDetailStore((s) => s.hydrateLayout);
export const useSwitchMobilePanel = () =>
  useSessionDetailStore((s) => s.switchMobilePanel);
export const useSwitchRightPaneTab = () =>
  useSessionDetailStore((s) => s.switchRightPaneTab);
export const useOpenContextArtifactPanel = () =>
  useSessionDetailStore((s) => s.openContextArtifactPanel);
export const useRequestMessageNav = () =>
  useSessionDetailStore((s) => s.requestMessageNav);
export const useClearMessageNavRequest = () =>
  useSessionDetailStore((s) => s.clearMessageNavRequest);
export const useSubmitPrompt = () =>
  useSessionDetailStore((s) => s.submitPrompt);
export const useReceiveStreamContent = () =>
  useSessionDetailStore((s) => s.receiveStreamContent);
export const useCompletePrompt = () =>
  useSessionDetailStore((s) => s.completePrompt);
export const useFailPrompt = () => useSessionDetailStore((s) => s.failPrompt);
export const useSetQueueError = () =>
  useSessionDetailStore((s) => s.setQueueError);
export const useQueueMessage = () =>
  useSessionDetailStore((s) => s.queueMessage);
export const useAddOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.addOptimisticQueueEntry);
export const useAcceptOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.acceptOptimisticQueueEntry);
export const useFailOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.failOptimisticQueueEntry);
export const useResolveOptimisticQueueEntries = () =>
  useSessionDetailStore((s) => s.resolveOptimisticQueueEntries);
export const useCancelOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.cancelOptimisticQueueEntry);
export const useSettleOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.settleOptimisticQueueEntry);
export const useRollbackOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.rollbackOptimisticQueueEntry);
export const useDismissError = () =>
  useSessionDetailStore((s) => s.dismissError);
export const useMarkCancelled = () =>
  useSessionDetailStore((s) => s.markCancelled);
export const useDismissCancelled = () =>
  useSessionDetailStore((s) => s.dismissCancelled);
export const useReconcileMessages = () =>
  useSessionDetailStore((s) => s.reconcileMessages);
export const useStartRecording = () =>
  useSessionDetailStore((s) => s.startRecording);
export const useStopRecording = () =>
  useSessionDetailStore((s) => s.stopRecording);
export const useShowPlaceholderAction = () =>
  useSessionDetailStore((s) => s.showPlaceholder);
export const useClearPlaceholder = () =>
  useSessionDetailStore((s) => s.clearPlaceholder);
export const useRequestDeleteSession = () =>
  useSessionDetailStore((s) => s.requestDeleteSession);
export const useCancelDeleteSessionDetail = () =>
  useSessionDetailStore((s) => s.cancelDeleteSession);
export const useToggleSidebar = () =>
  useSessionDetailStore((s) => s.toggleSidebar);
export const useOpenMobileSidebar = () =>
  useSessionDetailStore((s) => s.openMobileSidebar);
export const useCloseMobileSidebar = () =>
  useSessionDetailStore((s) => s.closeMobileSidebar);
export const useHydrateSidebar = () =>
  useSessionDetailStore((s) => s.hydrateSidebar);
export const useSetSidebarFilter = () =>
  useSessionDetailStore((s) => s.setSidebarFilter);
export const useSetSidebarSessionFilter = () =>
  useSessionDetailStore((s) => s.setSidebarSessionFilter);
export const useSetComposerFocused = () =>
  useSessionDetailStore((s) => s.setComposerFocused);
export const useShowQuestions = () =>
  useSessionDetailStore((s) => s.showQuestions);
export const useNavigateQuestion = () =>
  useSessionDetailStore((s) => s.navigateQuestion);
export const useClearQuestions = () =>
  useSessionDetailStore((s) => s.clearQuestions);
export const usePendingQuestions = () =>
  useSessionDetailStore((s) => s.pendingQuestions);
export const usePendingQuestionId = () =>
  useSessionDetailStore((s) => s.pendingQuestionId);
export const useCurrentQuestionIndex = () =>
  useSessionDetailStore((s) => s.currentQuestionIndex);
export const useSelectSpecCategory = () =>
  useSessionDetailStore((s) => s.selectSpecCategory);
export const useSelectSpecFile = () =>
  useSessionDetailStore((s) => s.selectSpecFile);
export const useOpenDocById = () => useSessionDetailStore((s) => s.openDocById);
export const useSelectDocId = () => useSessionDetailStore((s) => s.selectDocId);
export const useOpenDocument = () =>
  useSessionDetailStore((s) => s.openDocument);
export const useActivateDocument = () =>
  useSessionDetailStore((s) => s.activateDocument);
export const useCloseDocument = () =>
  useSessionDetailStore((s) => s.closeDocument);
export const useSetPendingTrayExpanded = () =>
  useSessionDetailStore((s) => s.setPendingTrayExpanded);
export const useTogglePendingTray = () =>
  useSessionDetailStore((s) => s.togglePendingTray);
export const useSetFeedbackTarget = () =>
  useSessionDetailStore((s) => s.setFeedbackTarget);
export const useActivatePanelSession = () =>
  useSessionDetailStore((s) => s.activatePanelSession);
export const useClearConversationMessages = () =>
  useSessionDetailStore((s) => s.clearConversationMessages);
export const useReassignInFlight = () =>
  useSessionDetailStore((s) => s.reassignInFlight);
export const useDiscardInFlight = () =>
  useSessionDetailStore((s) => s.discardInFlight);
export const useResetConversationState = () =>
  useSessionDetailStore((s) => s.resetConversationState);
export const useResetSessionDetailStore = () =>
  useSessionDetailStore((s) => s.resetStore);
