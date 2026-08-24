import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import type { SpecCommentThreadModel } from "@/lib/specs/comment-threads";
import type {
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";

export type SpecCommentHostSurface = "overview" | "review";

export type SpecCommentFallbackReason =
  | "historical-revision"
  | "removed-element"
  | "invalid-anchor"
  | "invalid-thread"
  | "unsupported-host";

export interface PlacedSpecCommentThread {
  thread: SpecCommentThreadModel;
  element: SpecRevisionElement | null;
  anchorState: SpecThreadAnchorState;
  fallbackReason: SpecCommentFallbackReason | null;
}

export interface SpecCommentPlacementPartition {
  coLocated: readonly PlacedSpecCommentThread[];
  fallback: readonly PlacedSpecCommentThread[];
  deferred: readonly SpecCommentThreadModel[];
  claimedThreadIds: ReadonlySet<string>;
}

interface PartitionSpecCommentThreadsBaseInput {
  viewedSnapshot: SpecRevisionSnapshot;
  threads: readonly SpecCommentThreadModel[];
  anchorStates?: ReadonlyMap<string, SpecThreadAnchorState>;
}

export type PartitionSpecCommentThreadsInput =
  | (PartitionSpecCommentThreadsBaseInput & {
      surface: "overview";
      reviewHostAvailable: boolean;
    })
  | (PartitionSpecCommentThreadsBaseInput & { surface: "review" });

export function partitionSpecCommentThreads(
  input: PartitionSpecCommentThreadsInput,
): SpecCommentPlacementPartition {
  const elementsById = new Map(
    input.viewedSnapshot.elements.map((entry) => [entry.element.id, entry]),
  );
  const coLocated: PlacedSpecCommentThread[] = [];
  const fallback: PlacedSpecCommentThread[] = [];
  const deferred: SpecCommentThreadModel[] = [];
  const claimedThreadIds = new Set<string>();

  for (const thread of input.threads) {
    const element = elementsById.get(thread.root.elementId) ?? null;
    const parsedAnchor = commentAnchorSchema.safeParse(thread.root.anchor);
    const suppliedState = input.anchorStates?.get(thread.threadId);
    const anchorState: SpecThreadAnchorState =
      element === null
        ? { status: "orphaned" }
        : (suppliedState ??
          (parsedAnchor.success
            ? {
                status: "anchored",
                charStart: parsedAnchor.data.charStart,
                charEnd: parsedAnchor.data.charEnd,
              }
            : { status: "stale" }));

    let fallbackReason: SpecCommentFallbackReason | null = null;
    if (thread.integrity !== "valid") {
      fallbackReason = "invalid-thread";
    } else if (thread.root.revisionId !== input.viewedSnapshot.revision.id) {
      fallbackReason = "historical-revision";
    } else if (element === null) {
      fallbackReason = "removed-element";
    } else if (!parsedAnchor.success) {
      fallbackReason = "invalid-anchor";
    }

    if (fallbackReason !== null) {
      fallback.push({ thread, element, anchorState, fallbackReason });
      claimedThreadIds.add(thread.threadId);
      continue;
    }

    if (input.surface === "overview") {
      if (element?.version.payload.kind === "section") {
        coLocated.push({ thread, element, anchorState, fallbackReason: null });
        claimedThreadIds.add(thread.threadId);
      } else if (input.reviewHostAvailable) {
        deferred.push(thread);
      } else {
        fallback.push({
          thread,
          element,
          anchorState,
          fallbackReason: "unsupported-host",
        });
        claimedThreadIds.add(thread.threadId);
      }
      continue;
    }

    coLocated.push({ thread, element, anchorState, fallbackReason: null });
    claimedThreadIds.add(thread.threadId);
  }

  return {
    coLocated,
    fallback,
    deferred,
    claimedThreadIds,
  };
}
