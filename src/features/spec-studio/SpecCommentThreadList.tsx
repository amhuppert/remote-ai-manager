"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { MarkdownAnnotationTarget } from "@/components/document-viewer/annotation-contract";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";
import {
  specCommentRowSchema,
  type SpecCommentRow,
  type SpecRevision,
} from "@/lib/specs/schemas";

import SpecCommentThread from "./SpecCommentThread";
import { logInvalidSpecCommentThread } from "./spec-comment-observability";
import type { PlacedSpecCommentThread } from "./spec-comment-placement";

const logger = createClientLogger("spec-studio-comments");

export interface SpecCommentThreadListHandle {
  focus(target: MarkdownAnnotationTarget): void;
}

export interface SpecCommentThreadListProps {
  projectName: string;
  slug: string;
  specId: string;
  viewedRevisionId: string;
  viewedRevisionState: SpecRevision["state"];
  specAbandoned: boolean;
  humanTransport: boolean;
  placements: readonly PlacedSpecCommentThread[];
  label: string;
}

interface ReplyBody {
  threadId: string;
  body: string;
}

interface ResolveBody {
  revisionId: string;
  threadId: string;
  resolution: "resolved";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SpecCommentThreadList = forwardRef<
  SpecCommentThreadListHandle,
  SpecCommentThreadListProps
>(function SpecCommentThreadList(
  {
    projectName,
    slug,
    specId,
    viewedRevisionId,
    viewedRevisionState,
    specAbandoned,
    humanTransport,
    placements,
    label,
  },
  forwardedRef,
) {
  const queryClient = useQueryClient();
  const [focusTarget, setFocusTarget] =
    useState<MarkdownAnnotationTarget | null>(null);
  const threadWrappersRef = useRef(new Map<string, HTMLDivElement>());
  const focusedGroupRef = useRef<HTMLDivElement>(null);
  const invalidThreadWarningsRef = useRef(new Set<string>());
  const reply = useSpecActionMutation<ReplyBody, SpecCommentRow>(
    projectName,
    slug,
    "reply",
    specCommentRowSchema,
    { specId, eventTypes: ["spec-attention-changed"] },
  );
  const resolve = useSpecActionMutation<ResolveBody, SpecCommentRow[]>(
    projectName,
    slug,
    "resolve-thread",
    z.array(specCommentRowSchema),
    { specId, eventTypes: ["spec-attention-changed"] },
  );

  useImperativeHandle(
    forwardedRef,
    () => ({ focus: (target) => setFocusTarget(target) }),
    [],
  );

  useEffect(() => {
    for (const { thread } of placements) {
      if (thread.integrity === "valid") continue;
      const rowIds = thread.messages.map((message) => message.id).sort();
      const warningKey = JSON.stringify([
        specId,
        thread.threadId,
        thread.integrity,
        rowIds,
      ]);
      if (invalidThreadWarningsRef.current.has(warningKey)) continue;
      invalidThreadWarningsRef.current.add(warningKey);
      logInvalidSpecCommentThread(logger, { specId, thread });
    }
  }, [placements, specId]);

  useLayoutEffect(() => {
    if (focusTarget === null) return;
    const ids =
      focusTarget.kind === "annotation" ? [focusTarget.id] : focusTarget.ids;
    const visibleIds = ids.filter((id) => threadWrappersRef.current.has(id));
    const target =
      visibleIds.length > 1
        ? focusedGroupRef.current
        : (threadWrappersRef.current
            .get(visibleIds[0] ?? "")
            ?.querySelector<HTMLElement>("article") ?? null);
    target?.scrollIntoView?.({ block: "center" });
    target?.focus();
  }, [focusTarget]);

  if (placements.length === 0) return null;

  async function refreshDetail(): Promise<void> {
    await queryClient.refetchQueries({
      queryKey: specKeys.detail(projectName, slug),
      type: "active",
    });
  }

  async function replyToThread(
    placement: PlacedSpecCommentThread,
    body: string,
  ): Promise<void> {
    const threadId = placement.thread.threadId;
    try {
      const result = await reply.mutateAsync({ threadId, body });
      await refreshDetail();
      logger.info("spec_studio.comment.reply.completed", {
        specId,
        threadId,
        commentId: result.id,
      });
    } catch (error) {
      logger.warn("spec_studio.comment.reply.failed", {
        specId,
        threadId,
        error: safeError(error),
      });
      throw error;
    }
  }

  async function resolveThread(
    placement: PlacedSpecCommentThread,
  ): Promise<void> {
    const threadId = placement.thread.threadId;
    const revisionId = placement.thread.root.revisionId;
    try {
      const result = await resolve.mutateAsync({
        revisionId,
        threadId,
        resolution: "resolved",
      });
      await refreshDetail();
      logger.info("spec_studio.comment.resolve.completed", {
        specId,
        revisionId,
        threadId,
        updatedRowCount: result.length,
      });
    } catch (error) {
      logger.warn("spec_studio.comment.resolve.failed", {
        specId,
        revisionId,
        threadId,
        error: safeError(error),
      });
      throw error;
    }
  }

  const focusedIds =
    focusTarget?.kind === "block-group" ? new Set(focusTarget.ids) : null;
  const groupedPlacements =
    focusedIds === null
      ? []
      : placements.filter(({ thread }) => focusedIds.has(thread.threadId));
  const groupThreadIds = new Set(
    groupedPlacements.length > 1
      ? groupedPlacements.map(({ thread }) => thread.threadId)
      : [],
  );
  const firstGroupedId = groupedPlacements[0]?.thread.threadId;

  function renderThread(placement: PlacedSpecCommentThread): React.JSX.Element {
    const canReply =
      placement.thread.integrity === "valid" &&
      placement.thread.open &&
      !specAbandoned;
    const canResolve =
      canReply &&
      humanTransport &&
      viewedRevisionState === "draft" &&
      placement.thread.root.revisionId === viewedRevisionId;
    return (
      <div
        key={placement.thread.threadId}
        ref={(node) => {
          if (node === null) {
            threadWrappersRef.current.delete(placement.thread.threadId);
          } else {
            threadWrappersRef.current.set(placement.thread.threadId, node);
          }
        }}
      >
        <SpecCommentThread
          thread={placement.thread}
          anchorState={placement.anchorState}
          fallbackReason={placement.fallbackReason}
          onReply={
            canReply ? (body) => replyToThread(placement, body) : undefined
          }
          onResolve={canResolve ? () => resolveThread(placement) : undefined}
        />
      </div>
    );
  }

  return (
    <div role="group" aria-label={label} className="grid gap-sm">
      {placements.map((placement) => {
        const threadId = placement.thread.threadId;
        if (!groupThreadIds.has(threadId)) return renderThread(placement);
        if (threadId !== firstGroupedId) return null;
        return (
          <div
            key={`group-${threadId}`}
            ref={focusedGroupRef}
            role="group"
            tabIndex={-1}
            aria-label={`${groupedPlacements.length} review threads on this passage`}
            className="grid scroll-mt-[180px] scroll-mb-[180px] gap-sm focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:scroll-mt-[260px] max-768:scroll-mb-[260px]"
          >
            {groupedPlacements.map(renderThread)}
          </div>
        );
      })}
    </div>
  );
});

export default SpecCommentThreadList;
