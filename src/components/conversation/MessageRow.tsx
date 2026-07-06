"use client";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import { EffortLabel } from "@/components/conversation/EffortLabel";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { QueuedMessageMetadata } from "@/lib/conversations/message-queue-schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";

// `message`, the role modifier, `message-content`, and `message-iteration-badge`
// are retained as structural / generated-content / test hooks — external slices
// and tooling still target them and they are NOT this slice's to migrate:
//   - `.message-content` (base typography + the `.message.notice .message-content`
//     override + `.message-content code/pre` + the globals.css rendered-markdown
//     `.message-content p/ul/h*/a/table/…`) is the PRESERVED markdown/code
//     container (R6), shared with the collab slice's CollabFinalAnswerMessage —
//     kept as scoped CSS, so the content div carries only the bare class.
//   - globals.css `.wb-transcript-body .message`.
//   - session.css `[data-debug-mode] .message.assistant … .message-content`.
//   - `.conversation-virtuoso-item .message` inter-row spacing (conversation.css,
//     owned by the conversation-surfaces slice).
//   - a session-workflow smoke test selecting `.message.user/.assistant
//     .message-iteration-badge`.
// The row's own chrome (role label, meta, iteration badge, notice frame) is
// utilities.
export const messageRoleClass =
  "font-mono text-[0.7rem] font-bold uppercase tracking-[0.1em] mb-[6px]";

export interface MessageRowProps {
  msg: TranscriptMessage;
  /**
   * Provenance tag of the queue row this message renders from — see the
   * `queuedMetadata` prop on `MessageContent`. Omit for transcript rows.
   */
  queuedMetadata?: QueuedMessageMetadata | null;
  messageIndex: number;
  isLast: boolean;
  selectedBackend: AgentBackendId;
  worktreePath: string | undefined;
  thinkingExpansionCommand?: ThinkingBlockExpansionCommand;
  /** Fork handler; omit to hide the Fork action where forking isn't supported. */
  onFork?: (messageIndex: number) => void;
  /**
   * Conversation identity for the per-message Compact action; omit on hosts
   * without it (the action is hidden). Must be referentially stable — this row
   * is memoized.
   */
  compactionTarget?: ContextArtifactTarget;
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
  queuedMetadata,
  messageIndex,
  isLast,
  selectedBackend,
  worktreePath,
  thinkingExpansionCommand,
  onFork,
  compactionTarget,
  lastMessageExtras,
}: MessageRowProps): React.JSX.Element {
  if (msg.role === "notice") {
    return (
      <div
        className="message notice relative border-y-0 border-r-0 border-l-2 border-solid border-border-subtle pl-md"
        data-msg-index={messageIndex}
      >
        <div className={cn(messageRoleClass, "text-[var(--text-muted)]")}>
          System
        </div>
        <div className="message-content">
          <MessageContent
            content={msg.content}
            worktreePath={worktreePath}
            thinkingExpansionCommand={thinkingExpansionCommand}
          />
        </div>
      </div>
    );
  }
  const isUserMsg = msg.role === "user";
  const iterationIndex =
    msg.origin?.source === "workflow"
      ? msg.origin.workflow?.iterationIndex
      : undefined;
  // Assistant role colour is ancestor-dependent, exactly as the legacy CSS:
  // cyan by default, violet only when inside a `[data-backend=codex]` ancestor
  // (`.conversation[data-backend=codex] .message.assistant .message-role`). It
  // is NOT derived from `selectedBackend` — outside a conversation thread (e.g.
  // the sidebar peek) the legacy label stayed cyan even for a Codex turn.
  // Arbitrary `[var(--…)]` values (not `text-cyan`/`text-violet`) are required so
  // both base and override live in `@layer utilities`: CC's typography.css ships
  // UNLAYERED `.text-cyan`/`.text-violet` classes that would otherwise outrank
  // (unlayered > layered) the codex override and pin the colour to cyan.
  const roleColor = isUserMsg
    ? "text-[var(--amber)]"
    : "text-[var(--cyan)] [[data-backend=codex]_&]:text-[var(--violet)]";
  return (
    <div
      className={cn("message", msg.role, "relative")}
      data-msg-index={messageIndex}
    >
      <div className={cn(messageRoleClass, roleColor)}>
        {isUserMsg ? "You" : selectedBackend === "codex" ? "Codex" : "Claude"}
        {iterationIndex !== undefined && (
          <span
            className="message-iteration-badge ml-sm inline-flex items-center justify-center rounded-full bg-bg-raised px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-medium tracking-[0.02em] whitespace-nowrap text-text-secondary normal-case"
            data-iteration={iterationIndex}
          >
            iter {iterationIndex}
          </span>
        )}
        {!isUserMsg && (msg.model || msg.effort) && (
          <span className="inline text-[0.7rem] font-medium tracking-[0.02em] normal-case">
            <span className="mx-[5px] text-text-tertiary">&middot;</span>
            {msg.model && (
              <span className="text-text-secondary">{msg.model}</span>
            )}
            {msg.model && msg.effort && (
              <span className="mx-[5px] text-text-tertiary">&middot;</span>
            )}
            {msg.effort && <EffortLabel effort={msg.effort} />}
          </span>
        )}
      </div>
      <div className="message-content">
        <MessageContent
          content={msg.content}
          worktreePath={worktreePath}
          queuedMetadata={queuedMetadata}
          thinkingExpansionCommand={thinkingExpansionCommand}
        />
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
        role={msg.role}
        onFork={onFork}
        compactionTarget={compactionTarget}
      />
    </div>
  );
});

export default MessageRow;
