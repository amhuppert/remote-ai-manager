import type { SpecCommentView } from "./view-schemas";

export type SpecCommentThreadIntegrity =
  | "valid"
  | "missing-root"
  | "multiple-roots"
  | "invalid-parent";

export interface SpecCommentThreadModel {
  threadId: string;
  root: SpecCommentView;
  messages: readonly SpecCommentView[];
  replies: readonly SpecCommentView[];
  open: boolean;
  blocking: boolean;
  resolution: "open" | "resolved" | "dismissed";
  integrity: SpecCommentThreadIntegrity;
}

export interface SpecCommentSummary {
  openCount: number;
  openBlockingCount: number;
  openThreadCount: number;
  openBlockingThreadCount: number;
}

function compareComments(
  left: SpecCommentView,
  right: SpecCommentView,
): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) return createdAtOrder;
  return left.id.localeCompare(right.id);
}

function assembleThread(
  threadId: string,
  unsortedComments: readonly SpecCommentView[],
): SpecCommentThreadModel {
  const sortedComments = [...unsortedComments].sort(compareComments);
  const roots = sortedComments.filter(
    (comment) => comment.parentCommentId === null,
  );
  const root = roots[0] ?? sortedComments[0];
  if (root === undefined) {
    throw new Error(`Cannot assemble empty spec comment thread ${threadId}.`);
  }

  const remainingMessages = sortedComments.filter(
    (comment) => comment.id !== root.id,
  );
  const messages = [root, ...remainingMessages];
  const open = messages.some((comment) => comment.resolution === "open");
  const integrity: SpecCommentThreadIntegrity =
    roots.length === 0
      ? "missing-root"
      : roots.length > 1
        ? "multiple-roots"
        : remainingMessages.some(
              (comment) => comment.parentCommentId !== root.id,
            )
          ? "invalid-parent"
          : "valid";

  return {
    threadId,
    root,
    messages,
    replies: remainingMessages,
    open,
    blocking: open && messages.some((comment) => comment.blocking),
    resolution: open ? "open" : root.resolution,
    integrity,
  };
}

export function assembleSpecCommentThreads(
  comments: readonly SpecCommentView[],
): SpecCommentThreadModel[] {
  const commentsByThread = new Map<string, SpecCommentView[]>();
  for (const comment of comments) {
    const threadComments = commentsByThread.get(comment.threadId) ?? [];
    threadComments.push(comment);
    commentsByThread.set(comment.threadId, threadComments);
  }

  return [...commentsByThread.entries()]
    .map(([threadId, threadComments]) =>
      assembleThread(threadId, threadComments),
    )
    .sort((left, right) => compareComments(left.root, right.root));
}

export function summarizeSpecComments(
  comments: readonly SpecCommentView[],
): SpecCommentSummary {
  const threads = assembleSpecCommentThreads(comments);
  return {
    openCount: comments.filter((comment) => comment.resolution === "open")
      .length,
    openBlockingCount: comments.filter(
      (comment) => comment.resolution === "open" && comment.blocking,
    ).length,
    openThreadCount: threads.filter((thread) => thread.open).length,
    openBlockingThreadCount: threads.filter((thread) => thread.blocking).length,
  };
}
