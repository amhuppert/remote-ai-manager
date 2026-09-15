"use client";

import { useEffect, useRef, useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  useDeleteNotepadCommentMutation,
  useSetNotepadCommentStatusMutation,
} from "@/lib/notepads/mutations";
import type { NotepadAuthorKind } from "@/lib/notepads/schemas";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { cn } from "@/lib/ui/cn";

import NotepadDispatchBar from "./NotepadDispatchBar";
import type { DispatchNotepadRef } from "./notepad-comment-dispatch";
import type { NotepadReviewThread } from "./notepad-review-annotations";

export interface NotepadCommentThreadsProps {
  notepad: DispatchNotepadRef;
  threads: readonly NotepadReviewThread[];
  isLoading: boolean;
  /** The thread a highlight or gutter marker pointed at, scrolled to and lit. */
  activeCommentId?: string | null;
}

/** Enough of the conversation id to tell two agents apart, per the ID rule. */
const CONVERSATION_ID_PREFIX = 8;

/**
 * Who wrote it. A user is "you" — the panel has one reader and they are the
 * only human writer; an agent names the conversation it wrote from, because
 * several conversations can review the same notepad and "agent" alone would
 * make their replies indistinguishable.
 */
function authorLabel(
  authorKind: NotepadAuthorKind,
  authorConversationId: string | null,
): string {
  if (authorKind === "user") return "you";
  return authorConversationId === null
    ? "agent"
    : `agent · ${authorConversationId.slice(0, CONVERSATION_ID_PREFIX)}`;
}

const AUTHOR_CLASS =
  "inline-flex shrink-0 items-baseline gap-[4px] font-mono text-[0.7rem]";

function Author({
  authorKind,
  authorConversationId,
}: {
  authorKind: NotepadAuthorKind;
  authorConversationId: string | null;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        AUTHOR_CLASS,
        authorKind === "user" ? "text-amber" : "text-cyan",
      )}
    >
      <span
        aria-hidden
        className="inline-block h-[6px] w-[6px] self-center rounded-full bg-current"
      />
      {authorLabel(authorKind, authorConversationId)}
    </span>
  );
}

/**
 * The review threads on one notepad: every comment with its quoted passage,
 * its replies, and the lifecycle acts that belong to the reader. Resolve,
 * reopen, and delete are user affordances by contract — the agent surface has
 * no such verb — so they live only here.
 *
 * A comment whose quote no longer matches the current text is badged stale
 * rather than relocated: it still shows what was said and about what, but it
 * claims no position in text that has moved on.
 */
export default function NotepadCommentThreads({
  notepad,
  threads,
  isLoading,
  activeCommentId = null,
}: NotepadCommentThreadsProps): React.JSX.Element {
  const { notepadId } = notepad;
  const setStatus = useSetNotepadCommentStatusMutation();
  const deleteComment = useDeleteNotepadCommentMutation();
  const [deleteTarget, setDeleteTarget] = useState<{
    commentId: string;
    quote: string;
  } | null>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  // Bring the activated thread into view. The list is short and the effect runs
  // on the id, so re-activating the same marker is a no-op rather than a scroll
  // that fights the reader.
  useEffect(() => {
    if (activeCommentId === null) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeCommentId]);

  const openCount = threads.filter(
    ({ thread }) => thread.comment.status === "open",
  ).length;

  return (
    <section
      data-testid="notepad-comment-threads"
      aria-label="Notepad comments"
      className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-0 border-t border-solid border-border-subtle bg-bg-base"
    >
      <div className="flex shrink-0 items-center gap-sm border-0 border-b border-solid border-border-subtle bg-bg-raised px-[12px] py-[3px] font-mono text-[0.64rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
        Comments
        <span className="tracking-normal normal-case">
          {openCount} open · {threads.length - openCount} resolved
        </span>
      </div>

      {isLoading ? (
        <EmptyState layoutClassName="my-md">
          <EmptyStateTitle>Loading comments…</EmptyStateTitle>
        </EmptyState>
      ) : threads.length === 0 ? (
        <EmptyState layoutClassName="my-md">
          <EmptyStateTitle>No comments yet</EmptyStateTitle>
        </EmptyState>
      ) : (
        <ul className="m-0 min-h-0 list-none overflow-y-auto p-0">
          {threads.map(({ thread, stale }) => {
            const { comment, replies, passage } = thread;
            const resolved = comment.status === "resolved";
            const pending =
              (setStatus.isPending &&
                setStatus.variables?.commentId === comment.id) ||
              (deleteComment.isPending &&
                deleteComment.variables?.commentId === comment.id);
            const active = comment.id === activeCommentId;
            return (
              <li
                key={comment.id}
                ref={active ? activeRef : undefined}
                data-testid={`notepad-comment-${comment.id}`}
                data-status={comment.status}
                data-active={active ? "true" : undefined}
                className={cn(
                  "m-0 flex list-none flex-col gap-[6px] border-0 border-b border-solid border-border-subtle px-[12px] py-[8px]",
                  active && "bg-cyan-glow",
                )}
              >
                <div className="flex flex-wrap items-center gap-x-sm gap-y-[4px]">
                  <StatusChip tone={resolved ? "green" : "cyan"}>
                    {resolved ? "resolved" : "open"}
                  </StatusChip>
                  {stale ? (
                    <StatusChip
                      tone="amber"
                      title="The quoted text has changed — this comment keeps its original quote."
                    >
                      stale
                    </StatusChip>
                  ) : null}
                  <Author
                    authorKind={comment.authorKind}
                    authorConversationId={comment.authorConversationId}
                  />
                  <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-text-tertiary">
                    {formatRelativeTime(comment.createdAt)}
                  </span>
                </div>

                <div className="font-mono text-[0.68rem] text-text-tertiary">
                  {passage.location}
                </div>
                <blockquote className="m-0 border-0 border-l-2 border-solid border-border-default pl-sm font-mono text-[0.72rem] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-secondary">
                  {passage.quote}
                </blockquote>
                <p className="m-0 font-mono text-[0.75rem] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-primary">
                  {comment.body}
                </p>

                {replies.length > 0 ? (
                  <ul className="m-0 flex list-none flex-col gap-[6px] border-0 border-l border-solid border-border-subtle p-0 pl-sm">
                    {replies.map((reply) => (
                      <li key={reply.id} className="m-0 list-none p-0">
                        <div className="flex flex-wrap items-center gap-x-sm gap-y-[2px]">
                          <Author
                            authorKind={reply.authorKind}
                            authorConversationId={reply.authorConversationId}
                          />
                          <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-text-tertiary">
                            {formatRelativeTime(reply.createdAt)}
                          </span>
                        </div>
                        <p className="m-0 font-mono text-[0.72rem] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-secondary">
                          {reply.body}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="flex flex-wrap items-center gap-[6px]">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      setStatus.mutate({
                        notepadId,
                        commentId: comment.id,
                        status: resolved ? "open" : "resolved",
                      })
                    }
                  >
                    {resolved ? "Reopen" : "Resolve"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      setDeleteTarget({
                        commentId: comment.id,
                        quote: passage.quote,
                      })
                    }
                  >
                    Delete…
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <NotepadDispatchBar notepad={notepad} threads={threads} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete comment?"
        message={
          deleteTarget
            ? `This permanently removes the comment on "${deleteTarget.quote}" and its replies. Resolving keeps it in the notepad's review record instead.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) {
            deleteComment.mutate({
              notepadId,
              commentId: deleteTarget.commentId,
            });
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
