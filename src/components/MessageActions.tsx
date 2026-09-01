"use client";

import { memo, useCallback, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { WithTooltip } from "@/components/ui/WithTooltip";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import { Spinner } from "@/components/ui/Spinner";
import { shouldOfferMessageCompaction } from "@/lib/context-artifacts/message-gating";
import {
  ARTIFACT_LIST_STALE_MS,
  useContextArtifacts,
} from "@/lib/context-artifacts/queries";
import { useCompactMutation } from "@/lib/context-artifacts/mutations";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import AgentProfileChoicePopover from "@/components/agent-profiles/AgentProfileChoicePopover";
import MessageCompactionViewer from "@/components/context-artifacts/MessageCompactionViewer";
import CopyMessageButton, { msgActionBtnClass } from "./CopyMessageButton";
import CopyMessageRefButton, {
  type MessageRefMeta,
} from "./CopyMessageRefButton";
import ClipMessageButton from "./notepad-capture/ClipMessageButton";
import GenerateNameFromMessageButton from "./GenerateNameFromMessageButton";

interface MessageActionsProps {
  /** The 0-based index of this message in the conversation */
  messageIndex: number;
  /** Content blocks of the message — used for the Copy action */
  content: MessageContentBlock[];
  /**
   * Role of the message; gates the Compact action (assistant only). Omit on
   * surfaces that don't offer compaction.
   */
  role?: TranscriptMessage["role"];
  /**
   * Called when user clicks Fork — forks the conversation from this message.
   * Omit to hide the Fork action (e.g. surfaces with no fork backend).
   * Returning a promise puts the Fork button into a visible pending state
   * (spinner + disabled) until it settles.
   *
   * The profile is supplied only for a fork at index 0, which derives from no
   * session and is therefore a fresh conversation with an identity to choose;
   * every later index inherits the source snapshot verbatim (R7).
   */
  onFork?: (
    messageIndex: number,
    profile?: AgentProfileRef,
  ) => void | Promise<void>;
  /**
   * Project whose profile library the index-0 fork picker lists. Omit and that
   * fork stays one-click, creating under the Standard Agent.
   */
  forkProjectName?: string;
  /**
   * Conversation identity for per-message compaction. Omit to hide the
   * Compact action (hosts without project/session/conversation identity).
   */
  compactionTarget?: ContextArtifactTarget;
  /**
   * Message metadata for the Copy-reference action, which also requires
   * `compactionTarget` (the conversation identity) and `role`. Omit to hide
   * the action — e.g. for queued rows, whose display index is not their
   * final transcript position.
   */
  messageRef?: MessageRefMeta;
}

/**
 * Hover action bar shown beneath every message. Always renders Copy; renders
 * Fork only when an `onFork` handler is wired, and Compact only when a
 * `compactionTarget` is wired and the message passes the compaction gate.
 *
 * Render inside a message row — the parent must be `position: relative`
 * (MessageRow's row sets the `relative` utility).
 */
function MessageActions(props: MessageActionsProps) {
  const { compactionTarget, role, content } = props;
  if (compactionTarget && shouldOfferMessageCompaction(role, content)) {
    return (
      <CompactableMessageActions
        {...props}
        compactionTarget={compactionTarget}
      />
    );
  }
  return <ActionBar {...props} />;
}

function CompactableMessageActions({
  messageIndex,
  content,
  role,
  onFork,
  forkProjectName,
  compactionTarget,
  messageRef,
}: MessageActionsProps & { compactionTarget: ContextArtifactTarget }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const { data: artifacts } = useContextArtifacts(compactionTarget, {
    staleTime: ARTIFACT_LIST_STALE_MS,
  });
  const compact = useCompactMutation(compactionTarget);

  const artifact = artifacts?.find(
    (row) =>
      row.kind === "message_compaction" && row.messageIndex === messageIndex,
  );
  const busy = artifact?.status === "pending" || compact.isPending;

  const handleActivate = useCallback(() => {
    if (busy) return;
    if (artifact?.status === "complete") {
      setViewerOpen((open) => !open);
      return;
    }
    compact.mutate({ kind: "message_compaction", messageIndex });
  }, [busy, artifact?.status, compact, messageIndex]);

  const handleRefresh = useCallback(() => {
    compact.mutate({ kind: "message_compaction", messageIndex, force: true });
  }, [compact, messageIndex]);

  const label = busy
    ? "Compacting…"
    : artifact?.status === "complete"
      ? viewerOpen
        ? "Hide compacted message"
        : "View compacted message"
      : artifact?.status === "failed"
        ? "Compaction failed — retry"
        : "Compact message";

  const state = busy
    ? "pending"
    : artifact?.status === "failed"
      ? "failed"
      : viewerOpen
        ? "open"
        : "idle";

  return (
    <>
      <ActionBar
        messageIndex={messageIndex}
        content={content}
        role={role}
        onFork={onFork}
        forkProjectName={forkProjectName}
        compactionTarget={compactionTarget}
        messageRef={messageRef}
      >
        <WithTooltip label={label}>
          <button
            type="button"
            className={cn(
              msgActionBtnClass,
              "data-[state=failed]:text-red data-[state=open]:text-cyan",
            )}
            data-state={state}
            onClick={handleActivate}
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={label}
            title={label}
          >
            {busy ? <Spinner size="sm" tone="inherit" /> : <CompactIcon />}
          </button>
        </WithTooltip>
      </ActionBar>
      {viewerOpen && artifact && artifact.status !== "pending" && (
        <MessageCompactionViewer
          target={compactionTarget}
          artifact={artifact}
          onRefresh={handleRefresh}
          refreshPending={compact.isPending}
        />
      )}
    </>
  );
}

function ActionBar({
  messageIndex,
  content,
  role,
  onFork,
  forkProjectName,
  compactionTarget,
  messageRef,
  children,
}: Pick<
  MessageActionsProps,
  | "messageIndex"
  | "content"
  | "role"
  | "onFork"
  | "forkProjectName"
  | "compactionTarget"
  | "messageRef"
> & {
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-xs ml-auto flex w-fit items-center gap-[2px]">
      <CopyMessageButton content={content} />
      {compactionTarget && messageRef && role && (
        <>
          <CopyMessageRefButton
            target={compactionTarget}
            messageIndex={messageIndex}
            role={role}
            meta={messageRef}
          />
          <ClipMessageButton
            target={compactionTarget}
            messageIndex={messageIndex}
            role={role}
            meta={messageRef}
            content={content}
          />
        </>
      )}
      {compactionTarget && (
        <GenerateNameFromMessageButton
          target={compactionTarget}
          messageIndex={messageIndex}
        />
      )}
      {onFork && (
        <ForkAction
          messageIndex={messageIndex}
          onFork={onFork}
          {...(forkProjectName === undefined ? {} : { forkProjectName })}
        />
      )}
      {children}
    </div>
  );
}

/**
 * Fork this message into a new conversation.
 *
 * A fork at index 0 derives from no session, so the conversation it creates is
 * a fresh one with an identity to choose and the control opens a profile panel;
 * every later index inherits the source snapshot verbatim, so it stays the
 * one-click action it has always been (R7).
 */
function ForkAction({
  messageIndex,
  onFork,
  forkProjectName,
}: {
  messageIndex: number;
  onFork: NonNullable<MessageActionsProps["onFork"]>;
  forkProjectName?: string;
}) {
  const [forking, setForking] = useState(false);

  const runFork = useCallback(
    (profile?: AgentProfileRef) => {
      if (forking) return;
      const result = onFork(messageIndex, profile);
      if (result instanceof Promise) {
        setForking(true);
        result.then(
          () => setForking(false),
          () => setForking(false),
        );
      }
    },
    [messageIndex, onFork, forking],
  );

  const label = forking ? "Forking…" : "Fork";
  const glyph = forking ? <Spinner size="sm" tone="inherit" /> : <ForkIcon />;

  if (messageIndex === 0 && forkProjectName !== undefined) {
    return (
      <AgentProfileChoicePopover
        projectName={forkProjectName}
        triggerLabel={label}
        title="Fork as a new conversation"
        confirmLabel="Fork conversation"
        onConfirm={runFork}
        disabled={forking}
        // The popover owns the click: opening the panel is not forking.
        trigger={
          <button
            className={msgActionBtnClass}
            disabled={forking}
            aria-busy={forking || undefined}
            title="Fork conversation from this message"
          >
            {glyph}
          </button>
        }
      />
    );
  }

  return (
    <WithTooltip label={label}>
      <button
        className={msgActionBtnClass}
        onClick={() => runFork()}
        disabled={forking}
        aria-busy={forking || undefined}
        title="Fork conversation from this message"
      >
        {glyph}
      </button>
    </WithTooltip>
  );
}

function ForkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9" cy="4.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3 4V8M3 5.5C3 5.5 3 4.5 5.5 4.5H7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Two chevrons compressing toward the middle. */
function CompactIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 1.5L6 4.5L9.5 1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 10.5L6 7.5L9.5 10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default memo(MessageActions);
