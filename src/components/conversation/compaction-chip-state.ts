import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";

/**
 * The six mutually-exclusive states of the per-conversation compaction status
 * chip (design §12.2). Derived from the conversation's artifact list — the
 * single rolling `conversation_compaction` row — plus the read-time freshness
 * flags the list endpoint computes.
 */
export type CompactionChipState =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "fresh" }
  | { kind: "stale"; behind: number }
  | { kind: "outdated" }
  | { kind: "failed" };

/**
 * Precedence is intentional: a run in flight outranks everything; a failure
 * outranks freshness flags; version drift (`outdated`, needs a forced full
 * regeneration) outranks ordinary staleness (delta-refreshable).
 */
export function deriveCompactionChipState(
  rows: ContextArtifactListItem[] | undefined,
): CompactionChipState {
  const row = rows?.find((r) => r.kind === "conversation_compaction");
  if (!row) return { kind: "none" };
  if (row.status === "pending") return { kind: "pending" };
  if (row.status === "failed") return { kind: "failed" };
  if (row.outdated) return { kind: "outdated" };
  if (row.stale) return { kind: "stale", behind: row.staleBehindMessages };
  return { kind: "fresh" };
}

export function compactionChipLabel(state: CompactionChipState): string {
  switch (state.kind) {
    case "none":
      return "No compact";
    case "pending":
      return "Compacting…";
    case "fresh":
      return "Fresh";
    case "stale":
      return `Stale (behind ${state.behind})`;
    case "outdated":
      return "Outdated";
    case "failed":
      return "Failed";
  }
}
