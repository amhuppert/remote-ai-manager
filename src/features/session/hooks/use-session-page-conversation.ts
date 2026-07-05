"use client";

import { useMemo } from "react";
import { useDisplayMessages } from "@/features/session/hooks/use-display-messages";
import { useConversationNav } from "@/features/session/hooks/use-conversation-nav";
import { useCollabPassageVisibility } from "@/features/session/hooks/use-collab-passage-visibility";
import { useMessageRowRenderer } from "@/features/session/hooks/use-message-row-renderer";
import { useCollabRowRenderer } from "@/features/session/hooks/use-collab-row-renderer";
import { buildConversationRows } from "@/features/session/conversation/conversation-rows";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { useCollabContext } from "@/features/session/hooks/use-collab-context";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";

type CollabContext = ReturnType<typeof useCollabContext>;
type LocalState = ReturnType<typeof useSessionPageLocalState>;
type MessageRowArgs = Parameters<typeof useMessageRowRenderer>[0];

function computeLastVisibleMessageIndex(
  displayMessageCount: number,
  hiddenMessageIndex: number | null,
): number {
  for (let i = displayMessageCount - 1; i >= 0; i--) {
    if (i !== hiddenMessageIndex) return i;
  }
  return -1;
}

export interface UseSessionPageConversationArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  messages: readonly TranscriptMessage[];
  activeConversation: ConversationState | undefined;
  worktreePath: string | undefined;
  isBusy: boolean;
  selectedBackend: MessageRowArgs["selectedBackend"];
  handleDebugPrompt: MessageRowArgs["handleDebugPrompt"];
  handleFork: MessageRowArgs["handleFork"];
  thinkingExpansionCommand?: MessageRowArgs["thinkingExpansionCommand"];
  local: LocalState;
  collab: CollabContext;
}

export function useSessionPageConversation(
  args: UseSessionPageConversationArgs,
) {
  const {
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
    thinkingExpansionCommand,
    local,
    collab,
  } = args;

  const displayMessages = useDisplayMessages(
    messages,
    activeConversation?.pendingQueue,
  );
  const { hiddenMessageIndex } = collab;

  const rows = useMemo(
    () =>
      buildConversationRows(
        displayMessages,
        collab.collabEnvelopeForConversation,
        hiddenMessageIndex,
      ),
    [displayMessages, collab.collabEnvelopeForConversation, hiddenMessageIndex],
  );

  const lastMessageIndex = computeLastVisibleMessageIndex(
    displayMessages.length,
    hiddenMessageIndex,
  );

  const nav = useConversationNav({
    rows,
    totalMessages: displayMessages.length,
    virtuosoRef: local.virtuosoRef,
  });

  const isCollabPassageInView = useCollabPassageVisibility(
    local.collabRowEl,
    local.panelBodyRef,
  );

  const renderMessageRow = useMessageRowRenderer({
    lastMessageIndex,
    activeConversation,
    selectedBackend,
    worktreePath,
    thinkingExpansionCommand,
    handleDebugPrompt,
    handleFork,
    isBusy,
    projectName,
    sessionName,
  });

  const renderCollabRow = useCollabRowRenderer({
    collabPassageProps: collab.collabPassageProps,
    collabEnvelopeForConversation: collab.collabEnvelopeForConversation,
    isCollabRunning: collab.isCollabRunning,
    collabPinnedTopTarget: local.collabPinnedTopTarget,
    setCollabRowEl: local.setCollabRowEl,
    handleCollabStop: collab.handleCollabStop,
    handleCollabRefClick: collab.handleCollabRefClick,
    projectName,
    sessionName,
    conversationId,
    collabUserAnswerDrafts: collab.collabUserAnswerDrafts,
    setCollabUserAnswerDraft: collab.setCollabUserAnswerDraft,
    clearCollabUserAnswerDrafts: collab.clearCollabUserAnswerDrafts,
    collabResumeMutation: collab.collabResumeMutation,
  });

  return {
    displayMessages,
    rows,
    nav,
    isCollabPassageInView,
    renderMessageRow,
    renderCollabRow,
  };
}
