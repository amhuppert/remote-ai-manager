"use client";

import { memo } from "react";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";

export interface MessageRowProps {
  msg: TranscriptMessage;
  messageIndex: number;
  isLast: boolean;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
  /** Fork handler; omit to hide the Fork action where forking isn't supported. */
  onFork?: (messageIndex: number) => void;
  /**
   * Per-render extras consumed only by the final-message decorations
   * (`DebugActionCard`). Non-last rows receive `null`, which is stable across
   * renders and lets `memo()` skip reconciliation when the only state change
   * is in a sibling row's debug context.
   */
  lastMessageExtras: {
    projectName: string;
    sessionName: string;
    conversation: ConversationState;
    onSendPrompt: (text: string) => Promise<void>;
    isBusy: boolean;
  } | null;
}

const MessageRow = memo(function MessageRow({
  msg,
  messageIndex,
  isLast,
  selectedBackend,
  worktreePath,
  onFork,
  lastMessageExtras,
}: MessageRowProps): React.JSX.Element {
  if (msg.role === "notice") {
    return (
      <div className="message notice" data-msg-index={messageIndex}>
        <div className="message-role">System</div>
        <div className="message-content">
          <MessageContent content={msg.content} worktreePath={worktreePath} />
        </div>
      </div>
    );
  }
  const isUserMsg = msg.role === "user";
  const iterationIndex =
    msg.origin?.source === "workflow"
      ? msg.origin.workflow?.iterationIndex
      : undefined;
  return (
    <div className={`message ${msg.role}`} data-msg-index={messageIndex}>
      <div className="message-role">
        {isUserMsg ? "You" : selectedBackend === "codex" ? "Codex" : "Claude"}
        {iterationIndex !== undefined && (
          <span
            className="cc-badge cc-badge--count message-iteration-badge"
            data-iteration={iterationIndex}
          >
            iter {iterationIndex}
          </span>
        )}
        {!isUserMsg && (msg.model || msg.effort) && (
          <span className="message-meta">
            <span className="message-meta-sep">&middot;</span>
            {msg.model && (
              <span className="message-meta-model">{msg.model}</span>
            )}
            {msg.model && msg.effort && (
              <span className="message-meta-sep">&middot;</span>
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
      {isLast && !isUserMsg && lastMessageExtras && (
        <DebugActionCard
          projectName={lastMessageExtras.projectName}
          sessionName={lastMessageExtras.sessionName}
          conversation={lastMessageExtras.conversation}
          onSendPrompt={lastMessageExtras.onSendPrompt}
          isBusy={lastMessageExtras.isBusy}
        />
      )}
      <MessageActions
        messageIndex={messageIndex}
        content={msg.content}
        onFork={onFork}
      />
    </div>
  );
});

export default MessageRow;
