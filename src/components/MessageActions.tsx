"use client";

import { memo, useCallback, useState } from "react";
import { cn } from "@/lib/ui/cn";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import { Spinner } from "@/components/ui/Spinner";
import { shouldOfferMessageCompaction } from "@/lib/context-artifacts/message-gating";
import { useContextArtifacts } from "@/lib/context-artifacts/queries";
import { useCompactMutation } from "@/lib/context-artifacts/mutations";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import MessageCompactionViewer from "@/components/context-artifacts/MessageCompactionViewer";
import CopyMessageButton, { msgActionBtnClass } from "./CopyMessageButton";

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
   */
  onFork?: (messageIndex: number) => void | Promise<void>;
  /**
   * Conversation identity for per-message compaction. Omit to hide the
   * Compact action (hosts without project/session/conversation identity).
   */
  compactionTarget?: ContextArtifactTarget;
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

/** List cache tolerance; SSE `context_artifact_status` patches keep it fresh. */
const ARTIFACT_LIST_STALE_MS = 30_000;

function CompactableMessageActions({
  messageIndex,
  content,
  onFork,
  compactionTarget,
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
      <ActionBar messageIndex={messageIndex} content={content} onFork={onFork}>
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
          data-tooltip={label}
          title={label}
        >
          {busy ? <Spinner size="sm" tone="inherit" /> : <CompactIcon />}
        </button>
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
  onFork,
  children,
}: Pick<MessageActionsProps, "messageIndex" | "content" | "onFork"> & {
  children?: React.ReactNode;
}) {
  const [forking, setForking] = useState(false);

  const handleFork = useCallback(() => {
    if (forking) return;
    const result = onFork?.(messageIndex);
    if (result instanceof Promise) {
      setForking(true);
      result.then(
        () => setForking(false),
        () => setForking(false),
      );
    }
  }, [messageIndex, onFork, forking]);

  return (
    <div className="mt-xs ml-auto flex w-fit items-center gap-[2px]">
      <CopyMessageButton content={content} />
      {onFork && (
        <button
          className={msgActionBtnClass}
          onClick={handleFork}
          disabled={forking}
          aria-busy={forking || undefined}
          data-tooltip={forking ? "Forking…" : "Fork"}
          title="Fork conversation from this message"
        >
          {forking ? <Spinner size="sm" tone="inherit" /> : <ForkIcon />}
        </button>
      )}
      {children}
    </div>
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
