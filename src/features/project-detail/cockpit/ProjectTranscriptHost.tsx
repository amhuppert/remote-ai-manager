"use client";

import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import MessageContent from "@/components/MessageContent";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationStatus,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
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
import "./styles/cockpit.css";

export interface ProjectTranscriptHostProps {
  projectName: string;
  conversationId: string;
  selectedBackend: AgentBackendId;
  worktreePath?: string;
  /** Active turn status — drives the running/awaiting indicator (Req 12.2). */
  status?: ConversationStatus;
  /** Supplied by chat-session-spawning; empty until spawning lands. */
  spawnCards?: SpawnCardRowData[];
  /** Supplied by chat-session-spawning; defaults to a no-op renderer. */
  renderSpawnCardRow?: RenderSpawnCardRow;
}

function awaitingLabel(status: ConversationStatus | undefined): string | null {
  if (status === "running") return "Working…";
  if (status === "awaiting" || status === "waiting_for_input") {
    return "Awaiting your input";
  }
  return null;
}

function ProjectMessageRow({
  msg,
  selectedBackend,
  worktreePath,
}: {
  msg: TranscriptMessage;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
}): React.JSX.Element {
  const isUser = msg.role === "user";
  return (
    <div className={`message ${msg.role}`}>
      <div className="message-role">
        {isUser ? "You" : selectedBackend === "codex" ? "Codex" : "Claude"}
        {!isUser && (msg.model || msg.effort) && (
          <span className="message-meta">
            {msg.model && (
              <span className="message-meta-model">{msg.model}</span>
            )}
            {msg.effort && (
              <span
                className={`message-meta-effort${msg.effort === "max" || msg.effort === "xhigh" ? " cc-rainbow-text" : ""}`}
              >
                {msg.effort}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="message-content">
        <MessageContent content={msg.content} worktreePath={worktreePath} />
      </div>
    </div>
  );
}

/**
 * Virtualized transcript for the active project conversation. It fetches the
 * conversation's messages, interleaves chat-session-spawning's inline cards via
 * `buildProjectTranscriptRows`, and renders through react-virtuoso (the same
 * primitive the session transcript uses) so messages are never rendered eagerly.
 * The spawn-card slot defaults to a no-op renderer so the cockpit ships before
 * spawning lands.
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

  const awaiting = awaitingLabel(status);
  const running = status === "running";

  const StatusFooter = awaiting
    ? () => (
        <div
          className="plc-transcript-status"
          data-status={status}
          role="status"
        >
          {running && <span className="status-dot cyan" aria-hidden />}
          {awaiting}
        </div>
      )
    : undefined;

  if (!messagesQuery.isPending && messages.length === 0 && cards.length === 0) {
    return (
      <div className="plc-transcript">
        {awaiting ? (
          <div className="plc-transcript-empty">
            <div
              className="plc-transcript-status"
              data-status={status}
              role="status"
            >
              {running && <span className="status-dot cyan" aria-hidden />}
              {awaiting}
            </div>
          </div>
        ) : (
          <div className="plc-transcript-empty empty-state">
            <div className="empty-state-title">No messages yet</div>
            <div className="empty-state-desc">
              Send a prompt to start this conversation.
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="plc-transcript">
      <Virtuoso
        key={conversationId}
        data={rows}
        initialTopMostItemIndex={{
          index: Math.max(0, rows.length - 1),
          align: "end",
        }}
        computeItemKey={(_i, row) => projectRowKey(row)}
        itemContent={(_i, row) =>
          row.kind === "message" ? (
            <ProjectMessageRow
              msg={row.msg}
              selectedBackend={selectedBackend}
              worktreePath={worktreePath}
            />
          ) : (
            renderSpawnCardRow(row)
          )
        }
        followOutput={() => "smooth"}
        {...(StatusFooter ? { components: { Footer: StatusFooter } } : {})}
        style={{ height: "100%", flex: 1, minHeight: 0 }}
      />
    </div>
  );
}
