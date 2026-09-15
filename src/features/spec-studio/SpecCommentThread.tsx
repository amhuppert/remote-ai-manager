"use client";

import { useEffect, useId, useRef, useState } from "react";

import { MultilineInput } from "@/components/MultilineInput";
import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { findBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import type { SpecCommentThreadModel } from "@/lib/specs/comment-threads";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import type { SpecCommentFallbackReason } from "./spec-comment-placement";

export interface SpecCommentThreadProps {
  thread: SpecCommentThreadModel;
  anchorState: SpecThreadAnchorState;
  fallbackReason?: SpecCommentFallbackReason | null;
  onReply?(body: string): Promise<void>;
  onResolve?(): Promise<void>;
}

function authorLabel(comment: SpecCommentView): string {
  if (comment.author === null) return "Unknown author";
  if (comment.author.kind === "human") return "Operator";
  const backend = findBackendCatalogEntry(comment.author.backend ?? "");
  return backend === null ? "Agent" : `${backend.label} agent`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

const fallbackExplanation: Record<SpecCommentFallbackReason, string> = {
  "historical-revision": "This thread belongs to an earlier revision.",
  "removed-element": "The reviewed element is not present in this revision.",
  "invalid-anchor": "The saved comment anchor is incomplete or invalid.",
  "invalid-thread":
    "Thread data is incomplete, so reply and resolve are unavailable.",
  "unsupported-host":
    "This thread cannot be placed beside its subject in this view.",
};

export default function SpecCommentThread({
  thread,
  anchorState,
  fallbackReason = null,
  onReply,
  onResolve,
}: SpecCommentThreadProps): React.JSX.Element {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyPending, setReplyPending] = useState(false);
  const [resolvePending, setResolvePending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const restoreReplyFocusRef = useRef(false);
  const replyErrorId = useId();
  const resolveErrorId = useId();
  const headingId = useId();
  const replyButtonId = useId();
  const location = thread.root.handle ?? thread.root.elementId;
  const lifecycleLabel =
    thread.resolution === "resolved"
      ? "Resolved"
      : thread.resolution === "dismissed"
        ? "Dismissed"
        : "Open";
  const lifecycleTone =
    thread.resolution === "open"
      ? "cyan"
      : thread.resolution === "resolved"
        ? "green"
        : "neutral";
  const mutationPending = replyPending || resolvePending;
  const validThread = thread.integrity === "valid";

  function focusReplyButton(): void {
    document.getElementById(replyButtonId)?.focus();
  }

  useEffect(() => {
    if (replyOpen || !restoreReplyFocusRef.current) return;
    restoreReplyFocusRef.current = false;
    focusReplyButton();
  }, [replyOpen]);

  async function submitReply(): Promise<void> {
    const body = replyBody.trim();
    if (
      onReply === undefined ||
      !validThread ||
      mutationPending ||
      body.length === 0
    ) {
      return;
    }
    setReplyPending(true);
    setReplyError(null);
    setResolveError(null);
    setStatus(null);
    try {
      await onReply(body);
      setReplyBody("");
      restoreReplyFocusRef.current = true;
      setReplyOpen(false);
      setStatus("Reply added");
    } catch (submissionError) {
      setReplyError(
        submissionError instanceof Error
          ? submissionError.message
          : "Couldn't add reply.",
      );
    } finally {
      setReplyPending(false);
    }
  }

  async function resolveThread(): Promise<void> {
    if (onResolve === undefined || !validThread || mutationPending) return;
    setResolvePending(true);
    setReplyError(null);
    setResolveError(null);
    setStatus(null);
    try {
      await onResolve();
      setStatus("Thread resolved");
      articleRef.current?.focus();
    } catch (resolutionError) {
      setResolveError(
        resolutionError instanceof Error
          ? resolutionError.message
          : "Couldn't resolve thread.",
      );
    } finally {
      setResolvePending(false);
    }
  }

  return (
    <article
      ref={articleRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-thread-id={thread.threadId}
      data-testid={`review-thread-${thread.threadId}`}
      className="scroll-mt-[180px] scroll-mb-[180px] rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:scroll-mt-[260px] max-768:scroll-mb-[260px]"
    >
      <div className="flex flex-wrap items-center gap-xs">
        <h3
          id={headingId}
          className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.06em] text-text-secondary uppercase"
        >
          Review thread · Revision {thread.root.revisionNumber ?? "unknown"} ·{" "}
          {location}
        </h3>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-xs">
          <StatusChip tone={lifecycleTone}>{lifecycleLabel}</StatusChip>
          {thread.blocking ? (
            <StatusChip tone="red">Blocking</StatusChip>
          ) : null}
          {anchorState.status === "reanchored" ? (
            <StatusChip tone="amber">Reanchored</StatusChip>
          ) : null}
          {anchorState.status === "stale" ? (
            <StatusChip tone="amber">Stale anchor</StatusChip>
          ) : null}
          {anchorState.status === "orphaned" ? (
            <StatusChip tone="amber">Orphaned</StatusChip>
          ) : null}
          {fallbackReason === "unsupported-host" ? (
            <StatusChip tone="amber">Unplaced</StatusChip>
          ) : null}
          {fallbackReason === "historical-revision" ? (
            <StatusChip tone="neutral">Historical</StatusChip>
          ) : null}
          {thread.integrity !== "valid" ? (
            <StatusChip tone="red">Thread data incomplete</StatusChip>
          ) : null}
        </div>
      </div>

      {fallbackReason !== null ? (
        <p className="mt-sm mb-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
          {fallbackExplanation[fallbackReason]}
        </p>
      ) : null}

      {thread.root.quote ? (
        <blockquote className="my-sm border-x-0 border-y-0 border-l border-solid border-l-cyan-dim pl-sm font-mono text-[0.78rem] leading-relaxed whitespace-pre-wrap text-text-secondary italic">
          “{thread.root.quote}”
        </blockquote>
      ) : null}

      <ol className="m-0 grid list-none gap-sm p-0">
        {thread.messages.map((message, index) => {
          const actor = authorLabel(message);
          const reply = index > 0;
          return (
            <li
              key={message.id}
              className={
                reply
                  ? "ml-sm border-x-0 border-y-0 border-l border-solid border-l-border-subtle pl-sm"
                  : undefined
              }
            >
              <div className="mb-xs flex flex-wrap items-center gap-xs font-mono text-[0.7rem] tracking-[0.05em] text-text-tertiary uppercase">
                <span className="font-semibold text-text-secondary">
                  {reply ? "Reply" : "Root"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{actor}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={message.createdAt}>
                  {formatTimestamp(message.createdAt)}
                </time>
              </div>
              <div className="text-[0.82rem] leading-relaxed text-text-primary [&_[data-markdown-intent=compact]]:m-0">
                <CompactMarkdown content={message.body} />
              </div>
              {message.author?.kind === "agent" ? (
                <a
                  href={conversationsPageHref({
                    conversationId: message.author.conversationId,
                  })}
                  aria-label={`Open conversation from ${actor} (${message.author.conversationId})`}
                  className="mt-xs inline-flex min-h-[44px] items-center font-mono text-[0.7rem] font-semibold text-cyan-dim underline-offset-2 hover:text-cyan hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                >
                  Open conversation ↗
                </a>
              ) : null}
            </li>
          );
        })}
      </ol>

      {resolveError !== null ? (
        <p
          id={resolveErrorId}
          role="alert"
          className="mt-sm mb-0 font-mono text-[0.7rem] text-red"
        >
          {resolveError}
        </p>
      ) : null}
      {status !== null ? (
        <p
          role="status"
          className="mt-sm mb-0 font-mono text-[0.7rem] text-green"
        >
          {status}
        </p>
      ) : null}

      {replyOpen && onReply !== undefined && validThread ? (
        <div className="mt-sm grid gap-sm border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm">
          <MultilineInput
            autoFocus
            value={replyBody}
            onValueChange={(body) => {
              setReplyBody(body);
              if (replyError !== null) setReplyError(null);
            }}
            onPrimaryAction={() => void submitReply()}
            aria-label="Reply to review thread"
            aria-invalid={replyError === null ? undefined : true}
            aria-describedby={replyError === null ? undefined : replyErrorId}
            disabled={mutationPending}
            rows={3}
            className="w-full resize-none rounded-sm border border-solid border-border-default bg-bg-base px-sm py-xs font-body text-[0.82rem] text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-1px]"
          />
          {replyError !== null ? (
            <p
              id={replyErrorId}
              role="alert"
              className="m-0 font-mono text-[0.7rem] text-red"
            >
              {replyError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-sm">
            <Button
              size="touch"
              variant="ghost"
              disabled={mutationPending}
              onClick={() => {
                restoreReplyFocusRef.current = true;
                setReplyOpen(false);
                setReplyError(null);
              }}
            >
              Cancel reply
            </Button>
            <Button
              size="touch"
              variant="primary"
              loading={replyPending}
              disabled={resolvePending || replyBody.trim().length === 0}
              onClick={() => void submitReply()}
            >
              {replyPending ? "Replying…" : "Send reply"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-sm flex flex-wrap items-center gap-sm">
        {onReply !== undefined && validThread ? (
          <Button
            id={replyButtonId}
            size="touch"
            variant="ghost"
            disabled={mutationPending}
            onClick={() => {
              setReplyOpen(true);
              setReplyError(null);
              setStatus(null);
            }}
          >
            Reply
          </Button>
        ) : null}
        {onResolve !== undefined && validThread ? (
          <div className="ml-auto">
            <Button
              size="touch"
              variant="default"
              loading={resolvePending}
              disabled={replyPending}
              aria-describedby={
                resolveError === null ? undefined : resolveErrorId
              }
              onClick={() => void resolveThread()}
            >
              {resolvePending ? "Resolving…" : "Resolve"}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
