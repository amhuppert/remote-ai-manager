"use client";

import {
  useContextArtifacts,
  type ContextArtifactListItem,
} from "@/lib/context-artifacts/queries";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";

export interface CheckpointArtifactCoverage {
  /** Raw JSONL sequence the rolling artifact was generated through. */
  coveredEndSeq: number;
  updatedAt: string;
}

/**
 * The conversation's rolling reading artifact, reduced to what a checkpoint
 * view needs to compare against its own frozen boundary.
 *
 * The two are different objects with different lifetimes — the artifact is
 * regenerated, the checkpoint never is — so a saved checkpoint says when the
 * artifact has moved past it rather than quietly showing whichever is newer.
 *
 * Kept separate from the hook so the session host, which already observes this
 * list for its own compaction chip, reduces the rows it has instead of opening
 * a second observer on the same query.
 */
export function checkpointArtifactCoverage(
  artifacts: readonly ContextArtifactListItem[] | undefined,
): CheckpointArtifactCoverage | null {
  const row = artifacts?.find(
    (candidate) =>
      candidate.kind === "conversation_compaction" &&
      candidate.status === "complete",
  );
  return row === undefined
    ? null
    : { coveredEndSeq: row.coveredEndSeq, updatedAt: row.updatedAt };
}

/**
 * The same comparison for a host that does not already read the artifact list —
 * the project cockpit, whose checkpoint controls are self-contained.
 */
export function useCheckpointArtifactComparison(
  target: ConversationTarget,
): CheckpointArtifactCoverage | null {
  const { data } = useContextArtifacts(target);
  return checkpointArtifactCoverage(data);
}
