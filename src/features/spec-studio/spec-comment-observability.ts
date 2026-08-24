import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import type { ClientLogger } from "@/lib/logging/client-logger";
import type { SpecCommentThreadModel } from "@/lib/specs/comment-threads";

export interface SpecCommentReanchorLogInput {
  specId: string;
  revisionId: string;
  anchorStates: readonly SpecThreadAnchorState[];
}

export interface InvalidSpecCommentThreadLogInput {
  specId: string;
  thread: SpecCommentThreadModel;
}

export function logSpecCommentReanchor(
  logger: Pick<ClientLogger, "debug">,
  input: SpecCommentReanchorLogInput,
): void {
  const totals = {
    anchored: 0,
    reanchored: 0,
    stale: 0,
    orphaned: 0,
  };
  for (const anchorState of input.anchorStates) {
    totals[anchorState.status] += 1;
  }
  logger.debug("spec_studio.comment.reanchor", {
    specId: input.specId,
    revisionId: input.revisionId,
    ...totals,
  });
}

export function logInvalidSpecCommentThread(
  logger: Pick<ClientLogger, "warn">,
  input: InvalidSpecCommentThreadLogInput,
): void {
  if (input.thread.integrity === "valid") return;
  logger.warn("spec_studio.comment.invalid_thread", {
    specId: input.specId,
    threadId: input.thread.threadId,
    integrity: input.thread.integrity,
    rowIds: input.thread.messages.map((message) => message.id),
  });
}
