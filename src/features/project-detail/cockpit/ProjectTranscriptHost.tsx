"use client";

import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import MessageRow from "@/components/conversation/MessageRow";
import { ConversationVirtuosoItem } from "@/components/conversation/ConversationVirtuosoList";
import TypingIndicator from "@/components/conversation/TypingIndicator";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
import { stripProposalFencesFromContent } from "@/features/_root/spawn-card/derive-spawn-cards";
import {
  buildProjectTranscriptRows,
  projectRowKey,
  type ProjectTranscriptRow,
} from "./project-transcript-rows";
import {
  noopRenderSpawnCardRow,
  type RenderSpawnCardRow,
  type SpawnCardRowData,
} from "./spawn-card-slot";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";

// Matches the session transcript body inset (.panel-body) so per-message
// spacing comes from the shared ConversationVirtuosoItem; tightens to the
// mobile gutter at the ≤768px spine.
const TRANSCRIPT_CLASS = "flex-1 min-h-0 flex flex-col p-lg max-768:p-md";

export interface ProjectTranscriptHostProps {
  projectName: string;
  conversationId: string;
  selectedBackend: AgentBackendId;
  worktreePath?: string;
  /** Active turn status — drives the running typing indicator (Req 12.2). */
  status?: ConversationStatus;
  /** Supplied by chat-session-spawning; empty until spawning lands. */
  spawnCards?: SpawnCardRowData[];
  /** Supplied by chat-session-spawning; defaults to a no-op renderer. */
  renderSpawnCardRow?: RenderSpawnCardRow;
}

/**
 * Virtualized transcript for the active project conversation. It fetches the
 * conversation's messages, interleaves chat-session-spawning's inline cards via
 * `buildProjectTranscriptRows`, and renders through react-virtuoso (the same
 * primitive the session transcript uses) so messages are never rendered eagerly.
 * Message rows reuse the shared `MessageRow` (same layout, model/effort meta,
 * and copy action as the session transcript) wrapped in the shared
 * `ConversationVirtuosoItem` so spacing matches; Fork is omitted because project
 * conversations have no fork backend. The spawn-card slot defaults to a no-op
 * renderer so the cockpit ships before spawning lands.
 */
export default function ProjectTranscriptHost({
  projectName,
  conversationId,
  selectedBackend,
  worktreePath,
  status,
  spawnCards,
  renderSpawnCardRow = noopRenderSpawnCardRow,
}: ProjectTranscriptHostProps): React.JSX.Element {
  const messagesQuery = useProjectConversationMessagesQuery(
    projectName,
    conversationId,
  );
  const messages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );
  const cards = useMemo(() => spawnCards ?? [], [spawnCards]);

  const rows = useMemo<ProjectTranscriptRow[]>(
    () => buildProjectTranscriptRows(messages, cards),
    [messages, cards],
  );

  // Strip each message's raw `spawn-proposal` fence once — the inline spawn
  // card renders the proposal, so the JSON block must not show in the bubble. A
  // turn that was nothing but the proposal strips to empty and renders no row.
  const strippedByIndex = useMemo(() => {
    const map = new Map<
      number,
      ReturnType<typeof stripProposalFencesFromContent>
    >();
    messages.forEach((msg, index) =>
      map.set(index, stripProposalFencesFromContent(msg.content)),
    );
    return map;
  }, [messages]);
  const lastMessageIndex = messages.length - 1;

  const running = status === "running";

  // Reuse the session transcript's working indicator (animated dots) while a
  // turn runs; awaiting is conveyed by the pane-header status badge, not a
  // transcript footer — matching the session conversation page. The project
  // page does not use the session-detail optimistic store, so the override is
  // pinned to `false`.
  const Footer = running
    ? () => (
        <TypingIndicator
          selectedBackend={selectedBackend}
          visible
          hasAssistantOptimistic={false}
        />
      )
    : undefined;

  if (!messagesQuery.isPending && messages.length === 0 && cards.length === 0) {
    return (
      <div className={TRANSCRIPT_CLASS}>
        {running ? (
          <TypingIndicator
            selectedBackend={selectedBackend}
            visible
            hasAssistantOptimistic={false}
          />
        ) : (
          <EmptyState layoutClassName="grow">
            <EmptyStateTitle>No messages yet</EmptyStateTitle>
            <EmptyStateDesc>
              Send a prompt to start this conversation.
            </EmptyStateDesc>
          </EmptyState>
        )}
      </div>
    );
  }

  return (
    <div className={TRANSCRIPT_CLASS}>
      <Virtuoso
        key={conversationId}
        data={rows}
        initialTopMostItemIndex={{
          index: Math.max(0, rows.length - 1),
          align: "end",
        }}
        computeItemKey={(_i, row) => projectRowKey(row)}
        itemContent={(_i, row) => {
          if (row.kind !== "message") return renderSpawnCardRow(row);
          const content =
            strippedByIndex.get(row.messageIndex) ?? row.msg.content;
          if (content.length === 0) return null;
          return (
            <MessageRow
              msg={
                content === row.msg.content ? row.msg : { ...row.msg, content }
              }
              messageIndex={row.messageIndex}
              isLast={row.messageIndex === lastMessageIndex}
              selectedBackend={selectedBackend}
              worktreePath={worktreePath}
              lastMessageExtras={null}
            />
          );
        }}
        followOutput={() => "smooth"}
        components={{
          Item: ConversationVirtuosoItem,
          ...(Footer ? { Footer } : {}),
        }}
        style={{ height: "100%", flex: 1, minHeight: 0 }}
      />
    </div>
  );
}
