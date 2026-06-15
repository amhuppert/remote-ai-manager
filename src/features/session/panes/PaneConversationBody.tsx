"use client";

import { useMemo, useRef } from "react";
import ConversationVirtuosoList, {
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import MessageRow from "@/components/conversation/MessageRow";
import { buildConversationRows } from "@/features/session/conversation/conversation-rows";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useDisplayMessages } from "@/features/session/hooks/use-display-messages";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface PaneConversationBodyProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  selectedBackend: AgentBackendId;
}

const noop = (): void => {};

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
}: PaneConversationBodyProps): React.JSX.Element {
  const { data, isLoading, isError } = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );

  const displayMessages = useDisplayMessages(data ?? []);
  const rows = useMemo(
    () => buildConversationRows(displayMessages, undefined, null),
    [displayMessages],
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  if (isLoading) {
    return <div className="pane__body-status">Loading…</div>;
  }
  if (isError) {
    return <div className="pane__body-status">Could not load messages</div>;
  }
  if (rows.length === 0) {
    return <div className="pane__body-status">No messages yet</div>;
  }

  return (
    <div className="pane__body">
      <div className="conversation" data-backend={selectedBackend}>
        <ConversationVirtuosoList
          rows={rows}
          virtuosoRef={virtuosoRef}
          conversationId={conversationId}
          followBottom
          renderMessage={({ row, isLast }) => (
            <MessageRow
              msg={row.msg}
              messageIndex={row.messageIndex}
              isLast={isLast}
              selectedBackend={selectedBackend}
              worktreePath={undefined}
              lastMessageExtras={null}
            />
          )}
          renderCollab={() => null}
          renderFooter={() => null}
          onRangeChanged={noop}
          onAtBottomStateChange={noop}
          onAtTopStateChange={noop}
        />
      </div>
    </div>
  );
}
