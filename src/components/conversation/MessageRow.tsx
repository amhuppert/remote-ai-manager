"use client";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import ModelSelectionMetadata from "@/components/ModelSelectionMetadata";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import { backendLabel } from "@/lib/agent-backends/catalog";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { QueuedMessageMetadata } from "@/lib/conversations/message-queue-schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

// `message`, the role modifier, `message-content`, and `message-iteration-badge`
// are retained as structural / test hooks — external slices and tooling still
// target them:
//   - `.message-content` is a structural host hook: its base container
//     typography + the `.message.notice .message-content` tone override +
//     the session.css debug-mode ancestor selectors. Generated Markdown
//     typography comes from the canonical MessageMarkdown adapter, so the
//     content div carries only the bare class.
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

/**
 * Trailing clock time for a message label row. Rendered from the viewer's zone,
 * so it is suppressed from hydration comparison — a server render in a
 * different zone would otherwise mismatch.
 */
function MessageTimestamp({
  timestamp,
}: {
  timestamp: string | null;
}): React.JSX.Element | null {
  if (!timestamp) return null;
  const label = formatLocalTime(timestamp);
  if (!label) return null;
  return (
    <span className="inline text-[0.7rem] font-medium tracking-[0.02em] normal-case">
      <span className="mx-[5px] text-text-tertiary">&middot;</span>
      <time
        dateTime={timestamp}
        className="text-text-tertiary"
        suppressHydrationWarning
      >
        {label}
      </time>
    </span>
  );
}

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
  onFork?: (messageIndex: number, profile?: AgentProfileRef) => void;
  /**
   * Project whose profile library the index-0 fork picker lists — that fork
   * derives from no session, so it is a fresh conversation with an identity to
   * choose. Omit and the action stays one-click at every index.
   */
  forkProjectName?: string;
  /**
   * Conversation identity for the per-message Compact action; omit on hosts
   * without it (the action is hidden). Must be referentially stable — this row
   * is memoized.
   */
  compactionTarget?: ContextArtifactTarget;
  /**
   * Conversation display name carried on copied message references; omit for
   * unnamed conversations or hosts without one.
   */
  conversationName?: string;
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
  forkProjectName,
  compactionTarget,
  conversationName,
  lastMessageExtras,
}: MessageRowProps): React.JSX.Element {
  if (msg.role === "notice") {
    return (
      <div
        className="message notice relative border-y-0 border-r-0 border-l-2 border-solid border-border-subtle pl-md"
        data-testid="message-row"
        data-msg-index={messageIndex}
      >
        <div className={cn(messageRoleClass, "text-[var(--text-muted)]")}>
          System
          <MessageTimestamp timestamp={msg.timestamp} />
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
      data-testid="message-row"
      data-msg-index={messageIndex}
    >
      <div className={cn(messageRoleClass, roleColor)}>
        {isUserMsg ? "You" : backendLabel(selectedBackend)}
        {iterationIndex !== undefined && (
          <span
            className="message-iteration-badge ml-sm inline-flex items-center justify-center rounded-full bg-bg-raised px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-medium tracking-[0.02em] whitespace-nowrap text-text-secondary normal-case"
            data-iteration={iterationIndex}
          >
            iter {iterationIndex}
          </span>
        )}
        {!isUserMsg && msg.modelSelection && (
          <span className="inline text-[0.7rem] font-medium tracking-[0.02em] normal-case">
            <span className="mx-[5px] text-text-tertiary">&middot;</span>
            <ModelSelectionMetadata selection={msg.modelSelection} />
          </span>
        )}
        <MessageTimestamp timestamp={msg.timestamp} />
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
        forkProjectName={forkProjectName}
        compactionTarget={compactionTarget}
        messageRef={
          // Queued rows render at a provisional index that may not be their
          // final transcript position, so they get no Copy-reference action.
          queuedMetadata === undefined
            ? {
                conversationName: conversationName ?? null,
                timestamp: msg.timestamp,
                model: msg.modelSelection?.modelId ?? null,
              }
            : undefined
        }
      />
    </div>
  );
});

export default MessageRow;
