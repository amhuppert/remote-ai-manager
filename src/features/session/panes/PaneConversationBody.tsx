"use client";

import { useCallback, useMemo, useState } from "react";
import ConversationTranscript from "@/components/conversation/ConversationTranscript";
import MessageRow from "@/components/conversation/MessageRow";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";
import { useCollabContext } from "@/features/session/hooks/use-collab-context";
import { useCollabRowRenderer } from "@/features/session/hooks/use-collab-row-renderer";
import { useThinkingBlockExpansionHotkeys } from "@/hooks/use-thinking-block-expansion-hotkeys";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useForkConversationMutation } from "@/lib/conversations/mutations";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useCollaborationListQuery } from "@/lib/workflows/queries";
import { useConversationBackgroundActivity } from "@/lib/active-conversations/queries";
import { useFailPrompt, useOpenDocById } from "@/stores/session-detail.store";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { createPaneForkHandler } from "./pane-fork-handler";

export interface PaneConversationBodyProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  selectedBackend: AgentBackendId;
  /** This conversation's own status — drives the running typing indicator. */
  status: SessionActiveConversation["status"];
  /**
   * Whether this pane is the active conversation — the one the shared pinned
   * composer targets. Only the active pane binds the thinking-block expansion
   * hotkeys (one global binding at a time); in-flight state is keyed per
   * conversation, so every pane merges its own optimistic echo regardless.
   */
  isActive: boolean;
  /** Open a conversation in the working set (fork lands in a new pane). */
  onOpenConversation: (conversationId: string) => void;
}

/**
 * The full transcript for one pane — the shared `ConversationTranscript` with
 * the pane capability set: collab passage, fork (opens in the working set),
 * per-message compaction, queued-message rows, and the conversation's keyed
 * in-flight banners. The trailing debug card stays owned by the active
 * conversation's pinned composer (`lastMessageExtras` null). The queries are
 * enabled by mount — a pane only exists inside the panes grid, so leaving
 * panes unmounts it (perf 8.5).
 */
export default function PaneConversationBody({
  projectName,
  sessionName,
  conversationId,
  selectedBackend,
  status,
  isActive,
  onOpenConversation,
}: PaneConversationBodyProps): React.JSX.Element {
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationState = sessionQuery.data?.conversations.find(
    (c) => c.id === conversationId,
  );
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );
  const collaborationListQuery = useCollaborationListQuery(
    projectName,
    sessionName,
    { includeAll: true },
  );
  const openDocById = useOpenDocById();
  const failPrompt = useFailPrompt();
  const thinkingExpansionCommand = useThinkingBlockExpansionHotkeys(isActive);
  const backgroundActivity = useConversationBackgroundActivity(conversationId);

  const collab = useCollabContext({
    projectName,
    sessionName,
    conversationId,
    collaborationListQuery,
    activeConversation: conversationState,
    rawMessages: messagesQuery.data ?? [],
    openDocById,
  });
  // The pane has no sticky pinned-top region; the passage renders inline only.
  const [, setCollabRowEl] = useState<HTMLDivElement | null>(null);
  const renderCollabRow = useCollabRowRenderer({
    collabPassageProps: collab.collabPassageProps,
    collabEnvelopeForConversation: collab.collabEnvelopeForConversation,
    isCollabRunning: collab.isCollabRunning,
    collabPinnedTopTarget: null,
    setCollabRowEl,
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

  const forkMutation = useForkConversationMutation(projectName, sessionName);
  const { mutateAsync: forkConversation } = forkMutation;
  const handleFork = useMemo(
    () =>
      createPaneForkHandler({
        conversationId,
        forkConversation,
        openInWorkingSet: onOpenConversation,
        failPrompt,
      }),
    [conversationId, forkConversation, onOpenConversation, failPrompt],
  );

  const compactionTarget = useMemo<ContextArtifactTarget>(
    () => ({ scope: "session", projectName, sessionName, conversationId }),
    [projectName, sessionName, conversationId],
  );
  const conversationName = conversationState?.name ?? undefined;
  const renderMessageRow = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    ({ row, isLast }) => (
      <MessageRow
        msg={row.msg}
        queuedMetadata={row.msg.queued ? row.msg.queued.metadata : undefined}
        messageIndex={row.messageIndex}
        isLast={isLast}
        selectedBackend={selectedBackend}
        worktreePath={sessionQuery.data?.worktreePath}
        thinkingExpansionCommand={thinkingExpansionCommand}
        onFork={handleFork}
        forkProjectName={projectName}
        compactionTarget={compactionTarget}
        conversationName={conversationName}
        lastMessageExtras={null}
      />
    ),
    [
      selectedBackend,
      sessionQuery.data?.worktreePath,
      thinkingExpansionCommand,
      handleFork,
      projectName,
      compactionTarget,
      conversationName,
    ],
  );

  return (
    // `pane__body` is kept as a rule-less anchor: conversation-panes.css applies
    // a pane-context density override to the shared `.conversation` thread via
    // `.pane__body > .conversation`. The body's own box is utility-owned.
    <div className="pane__body flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
      <ConversationTranscript
        scope={{ kind: "session", projectName, sessionName, conversationId }}
        backend={selectedBackend}
        status={status}
        pendingQueue={conversationState?.pendingQueue}
        backgroundActivity={backgroundActivity}
        worktreePath={sessionQuery.data?.worktreePath}
        thinkingExpansionCommand={thinkingExpansionCommand}
        renderMessageRow={renderMessageRow}
        collab={{
          envelope: collab.collabEnvelopeForConversation,
          hiddenMessageIndex: collab.hiddenMessageIndex,
          renderRow: renderCollabRow,
          suppressIndicator: collab.hasActiveCollab,
        }}
        showInFlightBanners
      />
    </div>
  );
}
