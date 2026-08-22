import {
  contextNodeGrade,
  contextNodeStatus,
  ownedPathsText,
  type NodeStatus,
} from "@/components/workflow-graph/node-presentation";
import { deriveContextWaitState } from "@/components/workflow-graph/derive-wait-state";
import { deriveContextLoopDisplay } from "@/components/workflow-graph/derive-graph";
import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The selected context's header line (design E1).
 *
 * `ctx_id · lane <name> · <grade>[ paths] · iteration N · pass N of M` — the
 * same vocabulary the node uses, read from the same owners
 * (`node-presentation`, `derive-wait-state`, `derive-graph`), so the card on
 * the canvas and the header in the rail cannot describe one context two ways.
 */

export interface ContextHeaderView {
  contextId: string;
  title: string;
  status: NodeStatus;
  /** Meta-line segments, in order, excluding the loop chip. */
  metaParts: readonly string[];
  /** `pass 2 of 3`, present only while the context sits in a loop pass. */
  loopLabel: string | null;
}

export function deriveContextHeader(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextHeaderView | null {
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  if (!context) return null;

  const state = execution.contextStates[contextId];
  const waitState = deriveContextWaitState({
    contextId,
    definition: execution.workingDefinition,
    execution,
  });
  const grade = contextNodeGrade(context.placement);
  const paths = ownedPathsText(context.placement);
  const laneName =
    context.placement.lane === SESSION_LANE_ID
      ? SESSION_LANE_NAME
      : context.placement.lane;
  const loop = deriveContextLoopDisplay(
    execution.workingDefinition,
    execution,
    contextId,
  );

  return {
    contextId,
    title: context.title,
    status: contextNodeStatus("execution", waitState),
    metaParts: [
      contextId,
      `lane ${laneName}`,
      paths === "" ? grade.label : `${grade.label} ${paths}`,
      `iteration ${state?.iterationCount ?? 0}`,
    ],
    loopLabel: loop === null ? null : `pass ${loop.pass} of ${loop.maxPasses}`,
  };
}
