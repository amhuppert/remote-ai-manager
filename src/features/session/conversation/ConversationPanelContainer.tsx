"use client";

import { useCallback, type ReactNode } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import TypingIndicator from "@/components/conversation/TypingIndicator";
import { useSessionPageConversation } from "@/features/session/hooks/use-session-page-conversation";
import { useConversationPanelProps } from "@/features/session/hooks/use-conversation-panel-props";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useCollabContext } from "@/features/session/hooks/use-collab-context";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

type StoreBundle = ReturnType<typeof useSessionPageStoreBundle>;
type LocalState = ReturnType<typeof useSessionPageLocalState>;
type CollabContext = ReturnType<typeof useCollabContext>;

export interface ConversationPanelContainerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;

  activeConversation: ConversationState | undefined;
  conversations: ConversationState[] | undefined;
  messages: readonly TranscriptMessage[];

  isBusy: boolean;
  isReadOnly: boolean;
  isInitConversation: boolean;
  hasActiveCollab: boolean;
  worktreePath: string | undefined;
  selectedBackend: AgentBackendId;
  contextPercent: number | null;
  messagesPending: boolean;

  focusConfirmLoading: boolean;
  handleConfirmFocus: () => void;

  handleDebugPrompt: (text: string) => Promise<void>;
  handleFork: (messageIndex: number) => Promise<void>;

  store: StoreBundle;
  local: LocalState;
  collab: CollabContext;

  canStop: boolean;
  onStop: () => void;

  promptInputSlot: ReactNode;
}

export default function ConversationPanelContainer({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  conversations,
  messages,
  isBusy,
  isReadOnly,
  isInitConversation,
  hasActiveCollab,
  worktreePath,
  selectedBackend,
  contextPercent,
  messagesPending,
  focusConfirmLoading,
  handleConfirmFocus,
  handleDebugPrompt,
  handleFork,
  store,
  local,
  collab,
  canStop,
  onStop,
  promptInputSlot,
}: ConversationPanelContainerProps): React.JSX.Element {
  const conversation = useSessionPageConversation({
    projectName,
    sessionName,
    conversationId,
    messages,
    activeConversation,
    worktreePath,
    isBusy,
    selectedBackend,
    handleDebugPrompt,
    handleFork,
    local,
    collab,
  });

  const typingIndicatorVisible =
    !hasActiveCollab &&
    (store.sending || activeConversation?.status === "running");
  const renderTypingIndicator = useCallback(
    () => (
      <TypingIndicator
        selectedBackend={selectedBackend}
        visible={typingIndicatorVisible}
      />
    ),
    [selectedBackend, typingIndicatorVisible],
  );

  const panelProps = useConversationPanelProps({
    conversations,
    activeConversation,
    sessionName,
    openMobileSidebar: local.openMobileSidebar,
    currentMessageIndex: conversation.nav.currentMessageIndex,
    totalMessages: conversation.displayMessages.length,
    handleFirstMessage: conversation.nav.handleFirstMessage,
    handlePrevMessage: conversation.nav.handlePrevMessage,
    handleNextMessage: conversation.nav.handleNextMessage,
    handleLastMessage: conversation.nav.handleLastMessage,
    contextPercent,
    promptError: store.promptError,
    promptCancelled: store.promptCancelled,
    dismissError: store.dismissError,
    dismissCancelled: store.dismissCancelled,
    panelBodyRef: local.panelBodyRef,
    selectedBackend,
    setCollabPinnedTopTarget: local.setCollabPinnedTopTarget,
    isCollabPassageInView: conversation.isCollabPassageInView,
    messagesPending,
    rows: conversation.rows,
    virtuosoRef: local.virtuosoRef,
    conversationId,
    followBottom: conversation.nav.followBottom,
    renderMessageRow: conversation.renderMessageRow,
    renderCollabRow: conversation.renderCollabRow,
    renderTypingIndicator,
    handleRangeChanged: conversation.nav.handleRangeChanged,
    handleAtBottomStateChange: conversation.nav.handleAtBottomStateChange,
    handleAtTopStateChange: conversation.nav.handleAtTopStateChange,
    showFocusConfirmation:
      isInitConversation &&
      !store.pendingQuestions &&
      (!isBusy || focusConfirmLoading) &&
      (activeConversation?.promptCount ?? 0) > 0,
    focusConfirmLoading,
    handleConfirmFocus,
    isReadOnly,
    canStop,
    onStop,
  });

  return (
    <ConversationPanel {...panelProps} promptInputSlot={promptInputSlot} />
  );
}
