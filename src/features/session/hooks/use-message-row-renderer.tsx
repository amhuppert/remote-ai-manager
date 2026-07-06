"use client";

import { useCallback, useMemo } from "react";
import MessageRow from "@/components/conversation/MessageRow";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface UseMessageRowRendererArgs {
  lastMessageIndex: number;
  activeConversation: ConversationState | undefined;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
  thinkingExpansionCommand?: ThinkingBlockExpansionCommand;
  handleDebugPrompt: (text: string) => Promise<void>;
  handleFork: (messageIndex: number) => Promise<void>;
  isBusy: boolean;
  projectName: string;
  sessionName: string;
}

export function useMessageRowRenderer({
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
}: UseMessageRowRendererArgs): ConversationVirtuosoListProps["renderMessage"] {
  // Stable identity for the per-message Compact action (MessageRow is
  // memoized; a fresh object per render would defeat it).
  const conversationId = activeConversation?.id;
  const compactionTarget = useMemo<ContextArtifactTarget | undefined>(
    () =>
      conversationId !== undefined
        ? { scope: "session", projectName, sessionName, conversationId }
        : undefined,
    [projectName, sessionName, conversationId],
  );
  return useCallback<ConversationVirtuosoListProps["renderMessage"]>(
    ({ row }) => {
      const { messageIndex, msg } = row;
      const isLast = messageIndex === lastMessageIndex;
      const extras =
        isLast && msg.role !== "user" && activeConversation
          ? {
              projectName,
              sessionName,
              conversation: activeConversation,
              onSendPrompt: handleDebugPrompt,
              isBusy,
            }
          : null;
      return (
        <MessageRow
          msg={msg}
          queuedMetadata={msg.queued ? msg.queued.metadata : undefined}
          messageIndex={messageIndex}
          isLast={isLast}
          selectedBackend={selectedBackend}
          worktreePath={worktreePath}
          thinkingExpansionCommand={thinkingExpansionCommand}
          onFork={handleFork}
          compactionTarget={compactionTarget}
          lastMessageExtras={extras}
        />
      );
    },
    [
      activeConversation,
      lastMessageIndex,
      handleDebugPrompt,
      handleFork,
      isBusy,
      projectName,
      selectedBackend,
      thinkingExpansionCommand,
      worktreePath,
      sessionName,
      compactionTarget,
    ],
  );
}
