"use client";

import { useMemo, type ReactNode, type RefObject } from "react";
import type ConversationPanel from "@/components/conversation/ConversationPanel";
import type {
  ConversationVirtuosoListProps,
  VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import type { ConversationRow } from "@/features/session/conversation/conversation-rows";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

type ConversationPanelProps = React.ComponentProps<typeof ConversationPanel>;
type Bundle = Omit<ConversationPanelProps, "promptInputSlot">;

export interface UseConversationPanelPropsArgs {
  conversations: unknown;
  activeConversation: ConversationState | undefined;
  sessionName: string;
  openMobileSidebar: () => void;
  currentMessageIndex: number;
  totalMessages: number;
  handleFirstMessage: () => void;
  handlePrevMessage: () => void;
  handleNextMessage: () => void;
  handleLastMessage: () => void;
  contextPercent: number | null;
  promptError: string | null;
  promptCancelled: boolean;
  dismissError: () => void;
  dismissCancelled: () => void;
  panelBodyRef: RefObject<HTMLDivElement | null>;
  selectedBackend: AgentBackendId;
  setCollabPinnedTopTarget: (el: HTMLDivElement | null) => void;
  isCollabPassageInView: boolean;
  messagesPending: boolean;
  rows: ConversationRow[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  conversationId: string;
  followBottom: boolean;
  renderMessageRow: ConversationVirtuosoListProps["renderMessage"];
  renderCollabRow: ConversationVirtuosoListProps["renderCollab"];
  renderTypingIndicator: ConversationVirtuosoListProps["renderFooter"];
  handleRangeChanged: ConversationVirtuosoListProps["onRangeChanged"];
  handleAtBottomStateChange: ConversationVirtuosoListProps["onAtBottomStateChange"];
  handleAtTopStateChange: ConversationVirtuosoListProps["onAtTopStateChange"];
  alignmentGateSlot: ReactNode;
  canStop: boolean;
  onStop: () => void;
  buildMarkdown?: () => string | null;
}

export function useConversationPanelProps(
  args: UseConversationPanelPropsArgs,
): Bundle {
  const {
    conversations,
    activeConversation,
    sessionName,
    openMobileSidebar,
    currentMessageIndex,
    totalMessages,
    handleFirstMessage,
    handlePrevMessage,
    handleNextMessage,
    handleLastMessage,
    contextPercent,
    promptError,
    promptCancelled,
    dismissError,
    dismissCancelled,
    panelBodyRef,
    selectedBackend,
    setCollabPinnedTopTarget,
    isCollabPassageInView,
    messagesPending,
    rows,
    virtuosoRef,
    conversationId,
    followBottom,
    renderMessageRow,
    renderCollabRow,
    renderTypingIndicator,
    handleRangeChanged,
    handleAtBottomStateChange,
    handleAtTopStateChange,
    alignmentGateSlot,
    canStop,
    onStop,
    buildMarkdown,
  } = args;
  return useMemo<Bundle>(
    () => ({
      conversations: Boolean(conversations),
      activeConversation,
      sessionName,
      openMobileSidebar,
      currentMessageIndex,
      totalMessages,
      handleFirstMessage,
      handlePrevMessage,
      handleNextMessage,
      handleLastMessage,
      contextPercent,
      promptError,
      promptCancelled,
      dismissError,
      dismissCancelled,
      panelBodyRef,
      selectedBackend,
      setCollabPinnedTopTarget,
      isCollabPassageInView,
      messagesPending,
      rows,
      virtuosoRef,
      conversationId,
      followBottom,
      renderMessageRow,
      renderCollabRow,
      renderTypingIndicator,
      handleRangeChanged,
      handleAtBottomStateChange,
      handleAtTopStateChange,
      alignmentGateSlot,
      canStop,
      onStop,
      buildMarkdown,
    }),
    [
      conversations,
      activeConversation,
      sessionName,
      openMobileSidebar,
      currentMessageIndex,
      totalMessages,
      handleFirstMessage,
      handlePrevMessage,
      handleNextMessage,
      handleLastMessage,
      contextPercent,
      promptError,
      promptCancelled,
      dismissError,
      dismissCancelled,
      panelBodyRef,
      selectedBackend,
      setCollabPinnedTopTarget,
      isCollabPassageInView,
      messagesPending,
      rows,
      virtuosoRef,
      conversationId,
      followBottom,
      renderMessageRow,
      renderCollabRow,
      renderTypingIndicator,
      handleRangeChanged,
      handleAtBottomStateChange,
      handleAtTopStateChange,
      alignmentGateSlot,
      canStop,
      onStop,
      buildMarkdown,
    ],
  );
}
