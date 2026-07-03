"use client";

import { useMemo, useRef } from "react";
import ConversationVirtuosoList, {
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import MessageRow from "@/components/conversation/MessageRow";
import TypingIndicator from "@/components/conversation/TypingIndicator";
import { buildConversationRows } from "@/features/session/conversation/conversation-rows";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useDisplayMessages } from "@/features/session/hooks/use-display-messages";
import { useSending } from "@/stores/session-detail.store";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface PaneConversationBodyProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  selectedBackend: AgentBackendId;
  /** This conversation's own status — drives the running typing indicator. */
  status: SessionActiveConversation["status"];
  /**
   * Whether this pane is the active conversation — the one the shared pinned
   * composer targets. Only the active pane merges the page-level in-flight
   * optimistic state; non-active panes show their server transcript alone so a
   * pending submit doesn't echo into every pane (the optimistic store is not
   * keyed per conversation).
   */
  isActive: boolean;
}

const noop = (): void => {};

const bodyStatusClass = "text-text-tertiary font-mono text-[0.7rem]";

/**
 * The full, scrollable transcript for one pane — the same message-rendering
 * section as the primary conversation panel (`MessageRow` inside the shared
 * `ConversationVirtuosoList`), just without the interactive affordances. Panes
 * are read-only: forking and the trailing debug card are owned by the active
 * conversation's pinned composer, so message rows render with `onFork` omitted
 * and `lastMessageExtras` null. The query is enabled by mount — a pane only
 * exists inside the panes grid, so leaving panes unmounts it (perf 8.5).
 */
export default function PaneConversationBody({
  projectName,
  sessionName,
  conversationId,
  selectedBackend,
  status,
  isActive,
}: PaneConversationBodyProps): React.JSX.Element {
  const { data, isLoading, isError } = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );

  const displayMessages = useDisplayMessages(data ?? [], undefined, {
    includeOptimistic: isActive,
  });
  const rows = useMemo(
    () => buildConversationRows(displayMessages, undefined, null),
    [displayMessages],
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // The agent is responding when this conversation is running. The active pane
  // additionally honours the shared composer's `sending` flag to bridge the
  // submit→running gap (the page-level optimistic store targets the active
  // conversation only), matching the single-conversation panel's gate.
  const sending = useSending();
  const responding = isActive
    ? sending || status === "running"
    : status === "running";
  // The active pane shares the active conversation's optimistic state, so let
  // the indicator read it (streaming variant when a partial reply exists).
  // Non-active panes must not — the store would leak the active conversation's
  // optimistic state into the wrong pane.
  const hasAssistantOptimistic = isActive ? undefined : false;

  if (isLoading) {
    return <div className={bodyStatusClass}>Loading…</div>;
  }
  if (isError) {
    return <div className={bodyStatusClass}>Could not load messages</div>;
  }
  if (rows.length === 0) {
    if (!responding) {
      return <div className={bodyStatusClass}>No messages yet</div>;
    }
    // A running conversation with no transcript yet still shows the agent is
    // working (e.g. the first turn before any message lands), rather than the
    // misleading "No messages yet" placeholder.
    return (
      <div className="pane__body flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
        <div className="conversation" data-backend={selectedBackend}>
          <TypingIndicator
            selectedBackend={selectedBackend}
            visible
            hasAssistantOptimistic={hasAssistantOptimistic}
          />
        </div>
      </div>
    );
  }

  return (
    // `pane__body` is kept as a rule-less anchor: conversation-panes.css applies
    // a pane-context density override to the not-yet-migrated shared
    // `.conversation` thread via `.pane__body > .conversation`. The body's own
    // box is utility-owned.
    <div className="pane__body flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
      <div className="conversation" data-backend={selectedBackend}>
        <ConversationVirtuosoList
          rows={rows}
          virtuosoRef={virtuosoRef}
          conversationId={conversationId}
          followBottom
          renderMessage={({ row, isLast }) => (
            <MessageRow
              msg={row.msg}
              queuedMetadata={
                row.msg.queued ? row.msg.queued.metadata : undefined
              }
              messageIndex={row.messageIndex}
              isLast={isLast}
              selectedBackend={selectedBackend}
              worktreePath={undefined}
              lastMessageExtras={null}
            />
          )}
          renderCollab={() => null}
          renderFooter={() => (
            <TypingIndicator
              selectedBackend={selectedBackend}
              visible={responding}
              hasAssistantOptimistic={hasAssistantOptimistic}
            />
          )}
          onRangeChanged={noop}
          onAtBottomStateChange={noop}
          onAtTopStateChange={noop}
        />
      </div>
    </div>
  );
}
