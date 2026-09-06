"use client";
import { useForkAvailability } from "@/lib/conversations/use-fork-availability";

import { useCallback, useMemo } from "react";
import MessageRow from "@/components/conversation/MessageRow";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

export interface UseMessageRowRendererArgs {
  activeConversation: ConversationState | undefined;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
  thinkingExpansionCommand?: ThinkingBlockExpansionCommand;
  handleDirectPrompt: (text: string) => Promise<void>;
  handleFork: (
    messageIndex: number,
    profile?: AgentProfileRef,
  ) => Promise<void>;
  isBusy: boolean;
  projectName: string;
  sessionName: string;
}

export function useMessageRowRenderer({
  activeConversation,
  selectedBackend,
  worktreePath,
  thinkingExpansionCommand,
  handleDirectPrompt,
  handleFork,
  isBusy,
  projectName,
  sessionName,
}: UseMessageRowRendererArgs): ConversationVirtuosoListProps["renderMessage"] {
  // Stable identity for the per-message Compact action (MessageRow is
  // memoized; a fresh object per render would defeat it).
  const forkRefusal = useForkAvailability(activeConversation, selectedBackend);
  const conversationId = activeConversation?.id;
  const compactionTarget = useMemo<ContextArtifactTarget | undefined>(
    () =>
      conversationId !== undefined
        ? { scope: "session", projectName, sessionName, conversationId }
        : undefined,
    [projectName, sessionName, conversationId],
  );
  return useCallback<ConversationVirtuosoListProps["renderMessage"]>(
    // `isLast` is message-based, supplied by ConversationTranscript (a
    // trailing collab row does not shift it).
    ({ row, isLast }) => {
      const { messageIndex, msg } = row;
      const extras =
        isLast && msg.role !== "user" && activeConversation
          ? {
              projectName,
              sessionName,
              conversation: activeConversation,
              onSendPrompt: handleDirectPrompt,
              isBusy,
            }
          : null;
      return (
        <MessageRow
          msg={msg}
          queuedMetadata={msg.queued ? msg.queued.metadata : undefined}
          queuedStatus={msg.queued?.status}
          provisional={msg.provisional}
          messageIndex={messageIndex}
          part={row.part}
          isLast={isLast}
          selectedBackend={selectedBackend}
          worktreePath={worktreePath}
          thinkingExpansionCommand={thinkingExpansionCommand}
          onFork={handleFork}
          forkProjectName={projectName}
          forkRefusal={forkRefusal}
          compactionTarget={compactionTarget}
          conversationName={activeConversation?.name ?? undefined}
          lastMessageExtras={extras}
        />
      );
    },
    [
      activeConversation,
      handleDirectPrompt,
      handleFork,
      isBusy,
      projectName,
      selectedBackend,
      forkRefusal,
      thinkingExpansionCommand,
      worktreePath,
      sessionName,
      compactionTarget,
    ],
  );
}
