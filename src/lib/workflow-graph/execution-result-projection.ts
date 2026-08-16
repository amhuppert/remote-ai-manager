import type {
  GraphWorkflowBoundaryEvent,
  GraphWorkflowBoundaryKind,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecution,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { buildGraphWorkflowExecutionDeepLink } from "@/lib/workflow-graph/execution-deep-link";
import { originFallbackName } from "@/lib/workflow-graph/execution-origin";
import type { GraphWorkflowResultOutputProjection } from "@/lib/workflow-graph/result-output-contract";

export interface GraphWorkflowBoundaryResultProjection {
  cursor: number;
  occurredAt: string;
  executionId: string;
  boundaryKind: GraphWorkflowBoundaryKind;
  status: GraphWorkflowStatus;
  contextId: string | null;
  pendingActions: Array<Record<string, unknown>>;
  outputs: GraphWorkflowResultOutputProjection;
  name: string;
  origin: GraphWorkflowExecutionOrigin;
  originConversationId: string | null;
  startedAt: string;
  completedAt: string | null;
  haltReason: GraphWorkflowHaltReason | null;
  abandonment: GraphWorkflowAbandonment | null;
  documents: GraphWorkflowExecution["sharedDocuments"];
  deepLink: string;
}

/**
 * The transport-independent projection shared by wait, status, CLI, browser,
 * and origin-result delivery. Boundary-time facts come from the durable event;
 * execution identity and authored provenance come from the self-contained
 * Current-or-History record.
 */
export function projectGraphWorkflowBoundaryResult(input: {
  execution: GraphWorkflowExecution;
  event: GraphWorkflowBoundaryEvent;
  cursor: number;
  occurredAt: string;
}): GraphWorkflowBoundaryResultProjection {
  const { execution, event } = input;
  return {
    cursor: input.cursor,
    occurredAt: input.occurredAt,
    executionId: execution.id,
    boundaryKind: event.boundaryKind,
    status: event.workflowStatus,
    contextId: event.contextId,
    pendingActions: event.pendingActions,
    outputs: event.outputProjection,
    name:
      execution.launchDocument?.name ?? originFallbackName(execution.origin),
    origin: execution.origin,
    originConversationId: execution.ownerConversationId,
    startedAt: event.startedAt ?? execution.startedAt,
    completedAt:
      event.completedAt === undefined
        ? execution.completedAt
        : event.completedAt,
    haltReason:
      event.haltReason === undefined ? execution.haltReason : event.haltReason,
    abandonment:
      event.abandonment === undefined
        ? execution.abandonment
        : event.abandonment,
    documents: execution.sharedDocuments,
    deepLink: buildGraphWorkflowExecutionDeepLink({
      projectName: event.projectName,
      sessionName: event.sessionName,
      executionId: execution.id,
    }),
  };
}
