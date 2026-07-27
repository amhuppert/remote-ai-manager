"use client";

import { useCallback } from "react";
import {
  useLayout,
  useMobilePanel,
  useRightPaneTab,
  useSendingFor,
  usePromptPlaceholder,
  usePromptErrorFor,
  usePromptCancelledFor,
  useSwitchLayout,
  useHydrateLayout,
  useSwitchMobilePanel,
  useDismissError,
  useDismissCancelled,
  useShowPlaceholderAction,
  useClearPlaceholder,
  useRequestDeleteSession,
  useCancelDeleteSessionDetail,
  useResetConversationState,
  useClearConversationMessages,
  usePendingQuestions,
  usePendingQuestionId,
  useCurrentQuestionIndex,
  useShowQuestions,
  useNavigateQuestion,
  useClearQuestions,
  useFailPrompt,
  useSwitchRightPaneTab,
  useSidebarCollapsed,
  useToggleSidebar,
  useOpenDocById,
} from "@/stores/session-detail.store";
import {
  useDevServerDrawerOpen,
  useToggleDevServerDrawer,
  useCloseDevServerDrawer,
} from "@/stores/dev-server-drawer.store";

type MobilePanel = "chat" | "diff" | "docs" | "specs" | "info";

export function useSessionPageStoreBundle(conversationId: string) {
  const layout = useLayout();
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useToggleSidebar();
  const mobilePanel = useMobilePanel();
  const rightPaneTab = useRightPaneTab();
  const sending = useSendingFor(conversationId);
  const promptPlaceholder = usePromptPlaceholder();
  const promptError = usePromptErrorFor(conversationId);
  const promptCancelled = usePromptCancelledFor(conversationId);

  const switchLayout = useSwitchLayout();
  const hydrateLayout = useHydrateLayout();
  const switchMobilePanelRaw = useSwitchMobilePanel();
  const switchRightPaneTab = useSwitchRightPaneTab();
  const switchMobilePanel = useCallback(
    (panel: MobilePanel) => {
      switchMobilePanelRaw(panel);
      if (panel === "docs") switchRightPaneTab("docs");
      if (panel === "diff") switchRightPaneTab("diff");
      if (panel === "specs") switchRightPaneTab("specs");
    },
    [switchMobilePanelRaw, switchRightPaneTab],
  );

  // In-flight actions are keyed per conversation; bind them to this
  // workspace's conversation so consumers keep their arg-less signatures.
  const dismissErrorAction = useDismissError();
  const dismissError = useCallback(
    () => dismissErrorAction(conversationId),
    [dismissErrorAction, conversationId],
  );
  const dismissCancelledAction = useDismissCancelled();
  const dismissCancelled = useCallback(
    () => dismissCancelledAction(conversationId),
    [dismissCancelledAction, conversationId],
  );
  const showPlaceholder = useShowPlaceholderAction();
  const clearPlaceholder = useClearPlaceholder();
  const requestDelete = useRequestDeleteSession();
  const cancelDelete = useCancelDeleteSessionDetail();
  const resetConversationState = useResetConversationState();
  const clearConversationMessagesAction = useClearConversationMessages();
  const clearConversationMessages = useCallback(
    () => clearConversationMessagesAction(conversationId),
    [clearConversationMessagesAction, conversationId],
  );
  const pendingQuestions = usePendingQuestions();
  const pendingQuestionId = usePendingQuestionId();
  const currentQuestionIndex = useCurrentQuestionIndex();
  const showQuestions = useShowQuestions();
  const navigateQuestion = useNavigateQuestion();
  const clearQuestions = useClearQuestions();
  const failPromptAction = useFailPrompt();
  const failPrompt = useCallback(
    (error: string) => failPromptAction(conversationId, error),
    [failPromptAction, conversationId],
  );
  const openDocById = useOpenDocById();

  const dsOpen = useDevServerDrawerOpen();
  const dsToggle = useToggleDevServerDrawer();
  const dsClose = useCloseDevServerDrawer();

  return {
    layout,
    sidebarCollapsed,
    toggleSidebar,
    mobilePanel,
    rightPaneTab,
    sending,
    promptPlaceholder,
    promptError,
    promptCancelled,
    switchLayout,
    hydrateLayout,
    switchMobilePanel,
    switchRightPaneTab,
    dismissError,
    dismissCancelled,
    showPlaceholder,
    clearPlaceholder,
    requestDelete,
    cancelDelete,
    resetConversationState,
    clearConversationMessages,
    pendingQuestions,
    pendingQuestionId,
    currentQuestionIndex,
    showQuestions,
    navigateQuestion,
    clearQuestions,
    failPrompt,
    openDocById,
    dsOpen,
    dsToggle,
    dsClose,
  };
}
