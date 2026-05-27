"use client";

import { useCallback, useMemo, useRef } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import MessageRow from "@/components/conversation/MessageRow";
import type {
  ConversationVirtuosoListProps,
  VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import {
  buildConversationRows,
  type ConversationRow,
} from "@/features/session/conversation/conversation-rows";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useConversationNav } from "@/features/session/hooks/use-conversation-nav";
import { useSessionQuery } from "@/lib/sessions/queries";

interface WorkflowConversationViewerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  isLive: boolean;
  contextTitle: string;
  taskTitle: string;
  onClose: () => void;
}

const noop = () => {};
const noopAsync = async () => {};

export default function WorkflowConversationViewer({
  projectName,
  sessionName,
  conversationId,
  isLive,
  contextTitle,
  taskTitle,
  onClose,
}: WorkflowConversationViewerProps) {
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const worktreePath = sessionQuery.data?.worktreePath;

  const messages = messagesQuery.data ?? [];

  const rows = useMemo<ConversationRow[]>(
    () => buildConversationRows(messages, undefined),
    [messages],
  );

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const panelBodyRef = useRef<HTMLDivElement | null>(null);

  const nav = useConversationNav({
    rows,
    totalMessages: messages.length,
    virtuosoRef,
  });

  const renderMessageRow = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    ({ row }) => (
      <MessageRow
        msg={row.msg}
        messageIndex={row.messageIndex}
        isLast={row.messageIndex === messages.length - 1}
        selectedBackend="claude"
        worktreePath={worktreePath}
        onFork={noopAsync}
        lastMessageExtras={null}
      />
    ),
    [messages.length, worktreePath],
  );

  const renderCollabRow = useCallback<
    ConversationVirtuosoListProps["renderCollab"]
  >(() => null, []);

  const renderTypingIndicator = useCallback<
    ConversationVirtuosoListProps["renderFooter"]
  >(() => null, []);

  return (
    <div className="wb-transcript-viewer">
      <header className="wb-transcript-header">
        <button
          className="wb-transcript-close"
          onClick={onClose}
          type="button"
          aria-label="Close transcript"
        >
          ✕
        </button>
        <div className="wb-transcript-label">
          <span className="wb-transcript-context">{contextTitle}</span>
          <span className="wb-transcript-sep">/</span>
          <span className="wb-transcript-task">{taskTitle}</span>
        </div>
        {isLive && (
          <span className="wb-transcript-live">
            <span className="wb-transcript-live-dot" />
            Live
          </span>
        )}
      </header>
      <ConversationPanel
        conversations={false}
        activeConversation={undefined}
        sessionName={sessionName}
        canStop={false}
        onStop={noop}
        openMobileSidebar={noop}
        currentMessageIndex={nav.currentMessageIndex}
        totalMessages={messages.length}
        handleFirstMessage={nav.handleFirstMessage}
        handlePrevMessage={nav.handlePrevMessage}
        handleNextMessage={nav.handleNextMessage}
        handleLastMessage={nav.handleLastMessage}
        contextPercent={null}
        promptError={null}
        promptCancelled={false}
        dismissError={noop}
        dismissCancelled={noop}
        panelBodyRef={panelBodyRef}
        selectedBackend="claude"
        setCollabPinnedTopTarget={noop}
        isCollabPassageInView={false}
        messagesPending={messagesQuery.isLoading}
        rows={rows}
        virtuosoRef={virtuosoRef}
        conversationId={conversationId}
        followBottom={nav.followBottom}
        renderMessageRow={renderMessageRow}
        renderCollabRow={renderCollabRow}
        renderTypingIndicator={renderTypingIndicator}
        handleRangeChanged={nav.handleRangeChanged}
        handleAtBottomStateChange={nav.handleAtBottomStateChange}
        handleAtTopStateChange={nav.handleAtTopStateChange}
        showFocusConfirmation={false}
        focusConfirmLoading={false}
        handleConfirmFocus={noop}
        isReadOnly={true}
        promptInputSlot={null}
      />
    </div>
  );
}
