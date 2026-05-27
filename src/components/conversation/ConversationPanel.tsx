"use client";

import type { ReactNode, RefObject } from "react";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import ConversationNav from "@/components/ConversationNav";
import FocusConfirmationBar from "@/components/FocusConfirmationBar";
import SyntheticForkBadge from "@/features/session/conversation/SyntheticForkBadge";
import ConversationVirtuosoList, {
  type ConversationVirtuosoListProps,
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import type { ConversationRow } from "@/features/session/conversation/conversation-rows";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface ConversationPanelProps {
  conversations: boolean;
  activeConversation: ConversationState | undefined;

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

  showFocusConfirmation: boolean;
  focusConfirmLoading: boolean;
  handleConfirmFocus: () => void;
  isReadOnly: boolean;

  promptInputSlot: ReactNode;
}

export default function ConversationPanel({
  conversations,
  activeConversation,
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
  showFocusConfirmation,
  focusConfirmLoading,
  handleConfirmFocus,
  isReadOnly,
  promptInputSlot,
}: ConversationPanelProps): React.JSX.Element {
  return (
    <div className="prompt-panel">
      <div className="panel-header">
        {conversations && (
          <button
            className="convo-sidebar-mobile-toggle"
            onClick={openMobileSidebar}
            title="Show conversations"
          >
            &#9776; Conversations
          </button>
        )}
        <span className="panel-title">Conversation</span>
        {activeConversation?.forkedFrom?.forkMode === "synthetic" && (
          <SyntheticForkBadge />
        )}
        <ConversationNav
          currentIndex={currentMessageIndex}
          totalCount={totalMessages}
          onFirst={handleFirstMessage}
          onPrevious={handlePrevMessage}
          onNext={handleNextMessage}
          onLast={handleLastMessage}
        />
      </div>
      {contextPercent != null && (
        <div className="mobile-context-fill">
          <ContextFillIndicator percentage={contextPercent} />
        </div>
      )}
      {promptError && (
        <div className="prompt-error">
          <span>{promptError}</span>
          <button onClick={dismissError}>&times;</button>
        </div>
      )}
      {promptCancelled && (
        <div className="prompt-cancelled">
          <span>Prompt cancelled</span>
          <button onClick={dismissCancelled}>&times;</button>
        </div>
      )}
      <div
        className="panel-body"
        ref={panelBodyRef}
        {...(activeConversation?.debugMode?.active
          ? { "data-debug-mode": "" }
          : {})}
      >
        <div className="conversation" data-backend={selectedBackend}>
          <div
            ref={setCollabPinnedTopTarget}
            className="collab-pinned-top-target"
            data-visible={isCollabPassageInView ? "true" : "false"}
          />
          {messagesPending ? (
            <div
              className="empty-state"
              style={{ padding: "var(--space-xl) 0" }}
            >
              <div className="empty-state-title">Loading conversation...</div>
            </div>
          ) : rows.length > 0 ? (
            <ConversationVirtuosoList
              rows={rows}
              virtuosoRef={virtuosoRef}
              conversationId={conversationId}
              followBottom={followBottom}
              renderMessage={renderMessageRow}
              renderCollab={renderCollabRow}
              renderFooter={renderTypingIndicator}
              onRangeChanged={handleRangeChanged}
              onAtBottomStateChange={handleAtBottomStateChange}
              onAtTopStateChange={handleAtTopStateChange}
            />
          ) : (
            <div
              className="empty-state"
              style={{ padding: "var(--space-xl) 0" }}
            >
              <div className="empty-state-title">No messages yet</div>
              <div className="empty-state-desc">
                Send a prompt to start the conversation.
              </div>
            </div>
          )}
        </div>
      </div>

      {showFocusConfirmation && (
        <FocusConfirmationBar
          onConfirm={handleConfirmFocus}
          disabled={isReadOnly}
          loading={focusConfirmLoading}
        />
      )}

      {promptInputSlot}
    </div>
  );
}
