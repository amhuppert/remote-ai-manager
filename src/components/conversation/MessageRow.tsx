"use client";
import type { BackendAdmissionRefusal } from "@/lib/agent-backends/execution-admission";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import ModelSelectionMetadata from "@/components/ModelSelectionMetadata";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import {
  backendLabel,
  queueCapabilityForBackend,
} from "@/lib/agent-backends/catalog";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type {
  QueuedMessageMetadata,
  PendingQueuedMessageStatus,
} from "@/lib/conversations/message-queue-schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { MessagePartRange } from "@/lib/conversations/group-content-blocks";

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
  queuedStatus?: PendingQueuedMessageStatus | "accepted";
  /**
   * True for an in-flight optimistic row (streamed during an active turn):
   * its display index and content are not durable, so it gets no
   * reference-bearing actions — the same exclusion queued rows get.
   */
  provisional?: boolean;
  messageIndex: number;
  /**
   * Slice of the message this row renders. The transcript gives a message one
   * row per renderable unit, so the role header rides the first part and the
   * per-message affordances ride the last. Omit on hosts that render a message
   * whole (previews, stories).
   */
  part?: MessagePartRange;
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
  forkRefusal?: BackendAdmissionRefusal | null;
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
  queuedStatus,
  provisional,
  messageIndex,
  part,
  isLast,
  selectedBackend,
  worktreePath,
  thinkingExpansionCommand,
  onFork,
  forkProjectName,
  forkRefusal,
  compactionTarget,
  conversationName,
  lastMessageExtras,
}: MessageRowProps): React.JSX.Element {
  // Chrome placement across a split message: the header opens it, the
  // affordances close it. An unsplit message is both at once.
  const isFirstPart = part === undefined || part.index === 0;
  const isLastPart = part === undefined || part.index === part.count - 1;
  const partAttrs = {
    "data-part-last": String(isLastPart),
    ...(part === undefined ? {} : { "data-part-index": part.index }),
  };
  const capture =
    msg.origin?.source === "checkpoint_capture"
      ? msg.origin.checkpointCapture
      : undefined;
  if (msg.role === "notice" && !capture) {
    return (
      <div
        className="message notice relative border-y-0 border-r-0 border-l-2 border-solid border-border-subtle pl-md"
        data-testid="message-row"
        data-msg-index={messageIndex}
        {...partAttrs}
      >
        {isFirstPart && (
          <div className={cn(messageRoleClass, "text-[var(--text-muted)]")}>
            System
            <MessageTimestamp timestamp={msg.timestamp} />
          </div>
        )}
        <div className="message-content">
          <MessageContent
            content={msg.content}
            worktreePath={worktreePath}
            thinkingExpansionCommand={thinkingExpansionCommand}
            {...(part ? { part } : {})}
          />
        </div>
      </div>
    );
  }
  const isUserMsg = msg.role === "user";
  // The copy-reference gate: only rows whose display index is their durable
  // transcript position can produce a message reference. Queued rows render at
  // a provisional index, and in-flight optimistic rows are not durable at all,
  // so neither gets the Copy-reference action nor the clip-source stamp below.
  const messageRef =
    queuedMetadata === undefined && !provisional
      ? {
          conversationName: conversationName ?? null,
          timestamp: msg.timestamp,
          model: msg.modelSelection?.modelId ?? null,
        }
      : undefined;
  // The clip-source contract consumed by the transcript's selection-clip
  // affordance: stamped under exactly the copy-reference gate, so a selection
  // over any other row never offers Clip (R22).
  const clipSourceAttrs =
    compactionTarget && messageRef
      ? {
          "data-clip-index": messageIndex,
          "data-clip-role": msg.role,
          ...(msg.timestamp === null
            ? {}
            : { "data-clip-timestamp": msg.timestamp }),
          ...(messageRef.model === null
            ? {}
            : { "data-clip-model": messageRef.model }),
        }
      : {};
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
  const roleColor = capture
    ? "text-text-secondary"
    : isUserMsg
      ? "text-[var(--amber)]"
      : "text-[var(--cyan)] [[data-backend=codex]_&]:text-[var(--violet)]";
  return (
    <div
      className={cn("message", msg.role, "relative")}
      data-testid="message-row"
      data-msg-index={messageIndex}
      {...partAttrs}
    >
      {isFirstPart && (
        <div className={cn(messageRoleClass, roleColor)}>
          {capture
            ? `Checkpoint handoff · ${capture.part}`
            : isUserMsg
              ? "You"
              : backendLabel(selectedBackend)}
          {queuedStatus ? (
            <span className="ml-sm font-medium text-text-secondary normal-case">
              {queuedStatus === "uncertain"
                ? "Delivery uncertain"
                : queuedStatus === "failed"
                  ? "Delivery failed"
                  : queuedStatus === "delivering"
                    ? "Delivering"
                    : queueCapabilityForBackend(selectedBackend)
                          .deliveryTiming === "next_turn"
                      ? "Queued for next turn"
                      : "Queued"}
            </span>
          ) : null}
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
              <ModelSelectionMetadata
                backend={selectedBackend}
                selection={msg.modelSelection}
              />
            </span>
          )}
          <MessageTimestamp timestamp={msg.timestamp} />
        </div>
      )}
      {capture && isFirstPart && (
        <div className="mb-sm font-mono text-[0.7rem] [overflow-wrap:anywhere] text-text-secondary">
          <p>
            {capture.part === "output"
              ? "Audit record · agent handoff is advisory and does not grant approval, validation or task-completion authority. Inclusion is recorded in the checkpoint receipt."
              : "Audit record · checkpoint maintenance, not a user task or ordinary assistant turn."}
          </p>
          <p className="mt-xs">
            Operation {capture.operationId} · Capture {capture.captureId}
          </p>
        </div>
      )}
      <div className="message-content" {...clipSourceAttrs}>
        <MessageContent
          content={msg.content}
          worktreePath={worktreePath}
          queuedMetadata={queuedMetadata}
          thinkingExpansionCommand={thinkingExpansionCommand}
          {...(part ? { part } : {})}
        />
      </div>
      {isLastPart && isLast && !isUserMsg && !capture && lastMessageExtras && (
        <DebugActionCard
          projectName={lastMessageExtras.projectName}
          sessionName={lastMessageExtras.sessionName}
          conversation={lastMessageExtras.conversation}
          onSendPrompt={lastMessageExtras.onSendPrompt}
          isBusy={lastMessageExtras.isBusy}
        />
      )}
      {isLastPart && msg.role !== "notice" && (
        <MessageActions
          messageIndex={messageIndex}
          content={msg.content}
          role={msg.role}
          onFork={onFork}
          forkProjectName={forkProjectName}
          forkRefusal={forkRefusal}
          compactionTarget={compactionTarget}
          messageRef={messageRef}
        />
      )}
    </div>
  );
});

export default MessageRow;
