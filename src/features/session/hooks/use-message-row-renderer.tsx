"use client";

import { useCallback } from "react";
import MessageRow from "@/components/conversation/MessageRow";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface UseMessageRowRendererArgs {
  lastMessageIndex: number;
  activeConversation: ConversationState | undefined;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
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
  handleDebugPrompt,
  handleFork,
  isBusy,
  projectName,
  sessionName,
}: UseMessageRowRendererArgs): ConversationVirtuosoListProps["renderMessage"] {
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
          messageIndex={messageIndex}
          isLast={isLast}
          selectedBackend={selectedBackend}
          worktreePath={worktreePath}
          onFork={handleFork}
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
      worktreePath,
      sessionName,
    ],
  );
}
