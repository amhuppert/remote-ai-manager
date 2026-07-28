"use client";

import { useCallback, useMemo } from "react";
import MessageRow from "@/components/conversation/MessageRow";
import ConversationTranscript, {
  type TranscriptExtensions,
} from "@/components/conversation/ConversationTranscript";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";
import type { TranscriptExtensionRowData } from "@/components/conversation/conversation-rows";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { useThinkingBlockExpansionHotkeys } from "@/hooks/use-thinking-block-expansion-hotkeys";
import { useConversationBackgroundActivity } from "@/lib/active-conversations/queries";
import { stripProposalFencesFromContent } from "@/features/project-detail/spawn-card/derive-spawn-cards";
import {
  noopRenderSpawnCardRow,
  type RenderSpawnCardRow,
  type SpawnCardRowData,
} from "./spawn-card-slot";

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
  /**
   * Durable queued follow-ups, rendered as pending rows after the transcript so
   * a message waiting on the running turn is visible rather than silently held.
   */
  pendingQueue?: readonly PendingQueuedMessage[];
}

/** Spawn card adapted onto the transcript's extension-row contract. */
interface SpawnExtensionRow extends TranscriptExtensionRowData {
  card: SpawnCardRowData;
}

/**
 * Transcript for the active project conversation: the shared
 * `ConversationTranscript` with the cockpit capability set — project-scoped
 * messages, chat-session-spawning's inline cards through the extension-row
 * seam, and proposal fences stripped from message bubbles (the card renders
 * the proposal, so the raw JSON block must not show; a turn that was nothing
 * but the proposal strips to empty and renders no row). Fork/compaction stay
 * off — project conversations have no fork backend. The spawn-card slot
 * defaults to a no-op renderer so the cockpit ships before spawning lands.
 */
export default function ProjectTranscriptHost({
  projectName,
  conversationId,
  selectedBackend,
  worktreePath,
  status,
  spawnCards,
  renderSpawnCardRow = noopRenderSpawnCardRow,
  pendingQueue,
}: ProjectTranscriptHostProps): React.JSX.Element {
  const thinkingExpansionCommand = useThinkingBlockExpansionHotkeys();
  const backgroundActivity = useConversationBackgroundActivity(conversationId);
  const extensionRows = useMemo<SpawnExtensionRow[]>(
    () =>
      (spawnCards ?? []).map((card) => ({
        key: `spawn:${card.proposalId}`,
        anchorMessageIndex: card.anchorMessageIndex,
        card,
      })),
    [spawnCards],
  );
  const extensions = useMemo<TranscriptExtensions>(
    () => ({
      rows: extensionRows,
      render(row: SpawnExtensionRow) {
        return renderSpawnCardRow(row.card);
      },
    }),
    [extensionRows, renderSpawnCardRow],
  );

  const renderMessageRow = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    ({ row, isLast }) => {
      const content = stripProposalFencesFromContent(row.msg.content);
      if (content.length === 0) return null;
      return (
        <MessageRow
          msg={content === row.msg.content ? row.msg : { ...row.msg, content }}
          queuedMetadata={row.msg.queued ? row.msg.queued.metadata : undefined}
          messageIndex={row.messageIndex}
          isLast={isLast}
          selectedBackend={selectedBackend}
          worktreePath={worktreePath}
          thinkingExpansionCommand={thinkingExpansionCommand}
          lastMessageExtras={null}
        />
      );
    },
    [selectedBackend, thinkingExpansionCommand, worktreePath],
  );

  return (
    <div className={TRANSCRIPT_CLASS}>
      <ConversationTranscript
        scope={{ kind: "project", projectName, conversationId }}
        backend={selectedBackend}
        status={status}
        pendingQueue={pendingQueue}
        backgroundActivity={backgroundActivity}
        worktreePath={worktreePath}
        renderMessageRow={renderMessageRow}
        extensions={extensions}
      />
    </div>
  );
}
