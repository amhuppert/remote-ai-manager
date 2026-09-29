import path from "node:path";
import { assertNever } from "@/lib/shared/assert-never";
import type {
  GraphWorkflowBoundaryEvent,
  GraphWorkflowBoundaryKind,
} from "./event-schemas";
import type { GraphWorkflowExecution } from "./schemas";
import { holdsExecutionLease } from "./lifecycle-classifier";
import { projectGraphWorkflowResultOutputs } from "./context-outputs";

/** Boundary-time event data shared by graph mutations and durable release. */
export function deriveExecutionBoundaryKind(
  previousExecution: GraphWorkflowExecution | null,
  nextExecution: GraphWorkflowExecution,
): GraphWorkflowBoundaryKind | null {
  if (
    previousExecution?.abandonment === null &&
    nextExecution.abandonment !== null
  ) {
    return "abandon";
  }

  const definitionApprovalParked =
    nextExecution.status === "pending" &&
    nextExecution.definitionApproval !== null &&
    nextExecution.definitionApproval.approvedAt === null &&
    (previousExecution === null ||
      previousExecution.definitionApproval?.requestedAt !==
        nextExecution.definitionApproval.requestedAt);
  if (definitionApprovalParked) return "definition_approval";

  if (previousExecution?.status === nextExecution.status) return null;
  switch (nextExecution.status) {
    case "paused":
      return "pause";
    case "halted":
      return "halt";
    case "completed":
      return "completion";
    case "aborted":
      return "abort";
    case "pending":
    case "running":
      return null;
    default:
      return assertNever(nextExecution.status);
  }
}

function projectBoundaryPendingActions(
  boundaryKind: GraphWorkflowBoundaryKind,
  contextId: string | null,
  execution: GraphWorkflowExecution,
): Array<Record<string, unknown>> {
  switch (boundaryKind) {
    case "definition_approval":
      return [{ kind: "approve_definition" }];
    case "context_approval":
      return [{ kind: "resolve_context_approval", contextId }];
    case "lane_question":
      return [{ kind: "answer_lane_question", contextId }];
    case "pause":
    case "halt":
      return holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
        ? [{ kind: "resume" }]
        : [];
    case "abandon":
    case "completion":
    case "abort":
      return [];
    default:
      return assertNever(boundaryKind);
  }
}

export function createGraphWorkflowBoundaryEvent(input: {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  boundaryKind: GraphWorkflowBoundaryKind;
  contextId?: string | null;
}): GraphWorkflowBoundaryEvent {
  const contextId = input.contextId ?? null;
  const projectName = path.basename(input.projectPath);
  return {
    type: "graph-workflow-boundary",
    projectName,
    sessionName: input.sessionName,
    executionId: input.execution.id,
    boundaryKind: input.boundaryKind,
    workflowStatus: input.execution.status,
    startedAt: input.execution.startedAt,
    completedAt: input.execution.completedAt,
    haltReason: input.execution.haltReason,
    abandonment: input.execution.abandonment,
    contextId,
    pendingActions: projectBoundaryPendingActions(
      input.boundaryKind,
      contextId,
      input.execution,
    ),
    outputProjection: projectGraphWorkflowResultOutputs({
      projectName,
      sessionName: input.sessionName,
      execution: input.execution,
    }),
  };
}
