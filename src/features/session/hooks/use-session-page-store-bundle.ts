"use client";

import { useCallback } from "react";
import {
  useLayout,
  useMobilePanel,
  useSending,
  usePromptPlaceholder,
  usePromptError,
  usePromptCancelled,
  useSwitchLayout,
  useHydrateLayout,
  useSwitchMobilePanel,
  useDismissError,
  useDismissCancelled,
  useShowPlaceholderAction,
  useClearPlaceholder,
  useRequestCommit,
  useRequestMerge,
  useRequestDeleteSession,
  useCancelDeleteSessionDetail,
  useResetSessionDetailStore,
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

export function useSessionPageStoreBundle() {
  const layout = useLayout();
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useToggleSidebar();
  const mobilePanel = useMobilePanel();
  const sending = useSending();
  const promptPlaceholder = usePromptPlaceholder();
  const promptError = usePromptError();
  const promptCancelled = usePromptCancelled();

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

  const dismissError = useDismissError();
  const dismissCancelled = useDismissCancelled();
  const showPlaceholder = useShowPlaceholderAction();
  const clearPlaceholder = useClearPlaceholder();
  const requestCommit = useRequestCommit();
  const requestMerge = useRequestMerge();
  const requestDelete = useRequestDeleteSession();
  const cancelDelete = useCancelDeleteSessionDetail();
  const resetStore = useResetSessionDetailStore();
  const clearConversationMessages = useClearConversationMessages();
  const pendingQuestions = usePendingQuestions();
  const pendingQuestionId = usePendingQuestionId();
  const currentQuestionIndex = useCurrentQuestionIndex();
  const showQuestions = useShowQuestions();
  const navigateQuestion = useNavigateQuestion();
  const clearQuestions = useClearQuestions();
  const failPrompt = useFailPrompt();
  const openDocById = useOpenDocById();

  const dsOpen = useDevServerDrawerOpen();
  const dsToggle = useToggleDevServerDrawer();
  const dsClose = useCloseDevServerDrawer();

  return {
    layout,
    sidebarCollapsed,
    toggleSidebar,
    mobilePanel,
    sending,
    promptPlaceholder,
    promptError,
    promptCancelled,
    switchLayout,
    hydrateLayout,
    switchMobilePanel,
    dismissError,
    dismissCancelled,
    showPlaceholder,
    clearPlaceholder,
    requestCommit,
    requestMerge,
    requestDelete,
    cancelDelete,
    resetStore,
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
