/**
 * Assembles the resolution-context brief handed to the Smart Merge conflict
 * resolver when a join merges one lane into another.
 *
 * The knowledge already exists in the execution state — context goals from the
 * working definition and per-task summaries captured by `complete_task` — so
 * the brief is assembled deterministically; no extra agent turn is spent.
 */

import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import { createLogger } from "@/lib/logging";
import { truncate } from "@/lib/shared/truncate";

const logger = createLogger("graph-workflow-join-resolution-context");

const RESOLUTION_CONTEXT_TRUNCATION_MARKER =
  "\n…[resolution context truncated]";

/** Per-task summary cap; summaries beyond this are cut mid-sentence. */
const MAX_TASK_SUMMARY_CHARS = 700;
/** Whole-brief cap; keeps the resolver prompt bounded on wide lanes. */
const MAX_BRIEF_CHARS = 6_000;

/**
 * Build the merge brief for merging `sourceLaneId` into the join's target
 * lane. The join merge runs inside the source lane's worktree and merges the
 * target lane's branch in, so in conflict markers ours/HEAD is the source
 * lane and theirs/incoming is the target lane.
 *
 * Returns null when there is nothing useful to say (missing lanes, or no
 * describable work on either side).
 */
export function buildJoinResolutionContext(
  execution: GraphWorkflowExecution,
  join: GraphWorkflowExecutionJoinState,
  sourceLaneId: string,
  coveredSourceLaneIds: readonly string[] = [],
): string | null {
  const sourceLane = execution.executionLanes[sourceLaneId];
  const targetLane = execution.executionLanes[join.targetLaneId];
  if (!sourceLane || !targetLane) return null;

  // Contexts present on both lanes are shared ancestry: their changes exist
  // identically on both sides and cannot conflict with themselves. Only the
  // set difference distinguishes the two sides for the resolver.
  const sourceContextIds = new Set(sourceLane.includedContextIds);
  const targetContextIds = new Set(targetLane.includedContextIds);
  const oursOnly = sourceLane.includedContextIds.filter(
    (id) => !targetContextIds.has(id),
  );
  const theirsOnly = targetLane.includedContextIds.filter(
    (id) => !sourceContextIds.has(id),
  );

  const oursSection = describeLaneWork(execution, oursOnly);
  const theirsSection = describeLaneWork(execution, theirsOnly);
  const theirsFallback = describeBareLane(targetLane);

  const coveredSections: string[] = [];
  for (const coveredLaneId of new Set(coveredSourceLaneIds)) {
    const coveredLane = execution.executionLanes[coveredLaneId];
    if (!coveredLane) continue;
    coveredSections.push(
      [
        `- Lane \`${coveredLaneId}\` (branch \`${coveredLane.branchName}\`):`,
        describeLaneWork(execution, coveredLane.includedContextIds) ??
          "  - No recorded work descriptions for this lane.",
      ].join("\n"),
    );
  }

  if (
    oursSection === null &&
    theirsSection === null &&
    !theirsFallback &&
    coveredSections.length === 0
  ) {
    return null;
  }

  const lines: string[] = [
    ...(coveredSections.length > 0
      ? [
          "Validation coverage — failures may originate in any of these lanes:",
          coveredSections.join("\n"),
          "",
        ]
      : []),
    `Ours (HEAD, branch \`${sourceLane.branchName}\`) — the work being merged:`,
    oursSection ?? "- No recorded work descriptions for this side.",
    "",
    `Theirs (incoming branch \`${targetLane.branchName}\`) — work already on the merge target:`,
    theirsSection ??
      theirsFallback ??
      "- No recorded work descriptions for this side.",
  ];

  const brief = truncate(lines.join("\n"), MAX_BRIEF_CHARS, {
    ellipsis: RESOLUTION_CONTEXT_TRUNCATION_MARKER,
  });
  logger.debug("join-resolution-context.built", {
    joinId: join.joinId,
    sourceLaneId,
    targetLaneId: join.targetLaneId,
    briefLength: brief.length,
    oursContextCount: oursOnly.length,
    theirsContextCount: theirsOnly.length,
    coveredLaneCount: coveredSections.length,
  });
  return brief;
}

/**
 * Render the goals + completed-task summaries for the given contexts.
 * Returns null when no context yields any content.
 */
function describeLaneWork(
  execution: GraphWorkflowExecution,
  contextIds: string[],
): string | null {
  const { executionContexts, tasks } = execution.workingDefinition;
  const sections: string[] = [];

  for (const contextId of contextIds) {
    const context = executionContexts.find((c) => c.id === contextId);
    const lines: string[] = [];

    const heading = context
      ? `- ${context.title}${context.description ? `: ${context.description}` : ""}`
      : `- ${contextId}`;
    lines.push(heading);

    for (const task of tasks.filter((t) => t.contextId === contextId)) {
      const state = execution.taskStates[task.id];
      if (state?.status !== "completed" || !state.summary) continue;
      lines.push(
        `  - ${task.title}: ${truncate(state.summary, MAX_TASK_SUMMARY_CHARS, {
          ellipsis: RESOLUTION_CONTEXT_TRUNCATION_MARKER,
        })}`,
      );
    }

    // A bare unknown-context id line carries no signal; require either a
    // known context (title/goal) or at least one task summary.
    if (context || lines.length > 1) {
      sections.push(lines.join("\n"));
    }
  }

  return sections.length > 0 ? sections.join("\n") : null;
}

/**
 * Fallback description for a target lane whose distinguishing context set is
 * empty — the session lane during a final publish is the main case: it holds
 * the workflow's base branch plus everything previously merged onto it.
 */
function describeBareLane(
  lane: GraphWorkflowExecutionLaneState,
): string | null {
  if (lane.kind !== "session") return null;
  return "- The workflow session's base branch, including work from previously merged lanes.";
}
