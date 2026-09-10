import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createExecutionIndex } from "@/lib/workflow-graph/execution-index";
import { deriveExecutionLaneActivities } from "@/lib/workflow-graph/lane-activity";
import { laneDisplayName } from "@/lib/workflow-graph/lane-bands";
import { awaitsDefinitionApproval } from "@/lib/workflow-graph/lifecycle-classifier";
import { deriveExecutionGates } from "@/lib/workflow-graph/execution-gates";

/**
 * The status bar's contextual sentence and its gate count (design E1).
 *
 * Returned as parts rather than a formatted string so the bar can emphasize the
 * lane, context and task NAMES without the component re-deciding the sentence —
 * the phrasing (and the "running in parallel" it earns only with two or more
 * members) is a single tested decision here.
 */

export interface ExecutionSummaryPart {
  readonly text: string;
  /** Rendered as the emphasized name of a lane, context or task. */
  readonly emphasis: boolean;
}

const SEPARATOR = " · ";

function plain(text: string): ExecutionSummaryPart {
  return { text, emphasis: false };
}

function name(text: string): ExecutionSummaryPart {
  return { text, emphasis: true };
}

/** `a`, `a and b`, `a, b and c` — the names interleaved with plain joiners. */
function nameList(values: string[]): ExecutionSummaryPart[] {
  return values.flatMap((value, index) => {
    if (index === 0) return [name(value)];
    const joiner = index === values.length - 1 ? " and " : ", ";
    return [plain(joiner), name(value)];
  });
}

/**
 * The sentence for a run whose remaining work is a lane merge, or null when no
 * join is in flight.
 *
 * Only lanes the join has NOT recorded in `mergedSourceLaneIds` are named: a
 * multi-source join merges one lane at a time, so listing a finished one would
 * report work that is already done. Once every source has landed the join is
 * finalizing rather than carrying a particular lane, and the sentence drops the
 * source list instead of naming one arbitrarily.
 */
function mergeSummary(
  execution: GraphWorkflowExecution,
): ExecutionSummaryPart[] | null {
  const inFlight = Object.values(execution.joins ?? {}).find(
    (join) => join.status === "running",
  );
  if (!inFlight) return null;

  const targetName = laneDisplayName(inFlight.targetLaneId);
  const pendingSources = inFlight.sourceLaneIds
    .filter((laneId) => !inFlight.mergedSourceLaneIds.includes(laneId))
    .map(laneDisplayName);

  if (pendingSources.length === 0) {
    return [plain("Publishing → "), name(targetName)];
  }
  return [
    plain("Merging "),
    ...nameList(pendingSources),
    plain(" → "),
    name(targetName),
  ];
}

export function deriveExecutionStatusSummary(
  execution: GraphWorkflowExecution,
): ExecutionSummaryPart[] {
  // A parked plan has no running context, so the ordinary sentence would report
  // "No context is running" — true, and useless. The park's own fact is what
  // the decision needs: the bytes under review cannot move while it stands,
  // which is why approve and reject may address the execution alone.
  if (
    awaitsDefinitionApproval(execution.status, execution.definitionApproval)
  ) {
    return [
      name("Definition awaiting approval"),
      plain(`${SEPARATOR}the snapshot is frozen for the decision`),
    ];
  }

  // Active membership is not liveness. A context parked on an approval or a
  // question KEEPS its place in activeContextIds, so reading membership alone
  // would claim it is running beside a gates chip saying it waits on the
  // operator. The runtime status is the only statement of what it is doing.
  const running: string[] = [];
  const awaiting: string[] = [];
  for (const contextId of execution.activeContextIds) {
    const status = execution.contextStates[contextId]?.status;
    if (status === "running") running.push(contextId);
    if (status === "awaiting_approval" || status === "awaiting_user_input") {
      awaiting.push(contextId);
    }
  }
  if (running.length === 0 && awaiting.length === 0) {
    // Not idle: a join in flight IS the work. Reporting "no context is running"
    // through a merge that may also be running validation commands inside the
    // lane worktrees describes a stalled run rather than a busy one.
    return mergeSummary(execution) ?? [plain("No context is running")];
  }

  const activeLaneIds = deriveExecutionLaneActivities(execution)
    .filter((lane) =>
      lane.members.some((member) => member.activity === "active"),
    )
    .map((lane) => lane.laneId);

  const parts: ExecutionSummaryPart[] = [];
  if (activeLaneIds.length > 0) {
    parts.push(plain(activeLaneIds.length === 1 ? "Lane " : "Lanes "));
    parts.push(...nameList(activeLaneIds));
    parts.push(plain(SEPARATOR));
  }

  const clauses: ExecutionSummaryPart[][] = [];
  if (running.length > 0) {
    clauses.push([
      ...nameList(running),
      plain(running.length > 1 ? " running in parallel" : " running"),
    ]);
  }
  if (awaiting.length > 0) {
    clauses.push([...nameList(awaiting), plain(" awaiting you")]);
  }
  clauses.forEach((clause, index) => {
    if (index > 0) parts.push(plain(SEPARATOR));
    parts.push(...clause);
  });

  // The task names what is being worked on, so it belongs to a RUNNING context.
  // A run whose every active context is parked has no task in progress to name.
  const index = createExecutionIndex(execution.workingDefinition, execution);
  const leadContextId = running[0];
  const currentTask =
    leadContextId === undefined
      ? undefined
      : (index.tasksByContext.get(leadContextId) ?? []).find(
          (task) => execution.taskStates[task.id]?.status !== "completed",
        );
  if (currentTask) {
    parts.push(plain(`${SEPARATOR}task `), name(currentTask.title));
  }

  return parts;
}

/**
 * How many decisions are waiting on the human right now — approval gates plus
 * parked questions, counted per answerable record because a cohort's validators
 * park independently (README §10: there is no single global gate).
 *
 * The count is the length of the list the chip opens, derived by its one owner,
 * so a chip announcing two gates can never open a list holding one.
 */
export function countExecutionGates(execution: GraphWorkflowExecution): number {
  return deriveExecutionGates(execution).length;
}
