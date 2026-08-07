import type { Node, Edge } from "@xyflow/react";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowExecutionContextDefinition,
  CascadeWorkflowSemanticDefinition,
  GraphWorkflowCascadeContext,
  GraphWorkflowTaskDefinition,
  GraphWorkflowVisualLayout,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  deriveContextWaitState,
  type ContextWaitState,
} from "./derive-wait-state";
import { createExecutionIndex } from "@/lib/workflow-graph/execution-index";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  resolvedRouteEdge,
  type RouteEdgeResolution,
} from "@/lib/workflow-graph/route-projection";
import { getContextOutput } from "@/lib/workflow-graph/context-outputs";
import {
  resolveLoopPassMembership,
  type LoopPassMembership,
} from "@/lib/workflow-graph/loop-ledger";
import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import type { GraphWorkflowContextSkipReason } from "@/lib/workflow-graph/schemas";

/**
 * The graph is a read-only projection, so it takes the CASCADE shape: a seeded
 * context is a cascade context plus `profileSnapshot`, and nothing here reads
 * the snapshot — one type therefore serves both the builder preview (which has
 * no snapshots) and a running execution.
 */
type DeriveGraphDefinition =
  | WorkflowSemanticDefinition
  | CascadeWorkflowSemanticDefinition;

/**
 * A skipped context as the read surfaces render it (D4 R13): the COMPLETE
 * recorded verdict set, plus the subset that actually decided the skip.
 *
 * `decidingEdgeIds` is derived rather than persisted because the durable reason
 * records every incoming edge — an operator asking "why was this branch not
 * taken" wants the guards that resolved false, not the ones that merely dropped
 * out of the conjunction.
 */
export type ContextSkipDisplay = {
  at: string;
  edgeEvaluations: GraphWorkflowContextSkipReason["edgeEvaluations"];
  decidingEdgeIds: string[];
};

/** A materialized loop pass instance, with its group's activation and budget. */
export type ContextLoopDisplay = LoopPassMembership;

/** The accepted expansion that authorized a runtime-added node (R8 provenance). */
export type ContextProvenanceDisplay = {
  requestId: string;
  invokerContextId: string;
  rationale: string;
  payloadHash: string;
  acceptedAt: string;
};

export type ExecutionContextNodeData = {
  context:
    | GraphWorkflowExecutionContextDefinition
    | GraphWorkflowCascadeContext;
  tasks: GraphWorkflowTaskDefinition[];
  mode: "builder" | "execution";
  contextState?: GraphWorkflowExecutionContextState;
  taskStates?: Record<string, GraphWorkflowTaskState>;
  waitState?: ContextWaitState;
  /**
   * Present ONLY when the context declares an `outputSchema` — its absence is
   * how the node knows to draw no contract glyph at all. `captured` is false in
   * builder mode by construction: nothing has run, so a declared contract is
   * always still owed.
   */
  outputSchema?: { captured: boolean };
  /** Present only on a `skipped` context (D4 R4) — the recorded route verdicts. */
  skip?: ContextSkipDisplay;
  /** Present only on a materialized loop pass instance (D4 R9). */
  loop?: ContextLoopDisplay;
  /** Present only on a context a runtime expansion created (D4 R8). */
  provenance?: ContextProvenanceDisplay;
};

export type ContextEdgeData = {
  sourceStatus?: GraphWorkflowContextStatus;
  targetStatus?: GraphWorkflowContextStatus;
  /**
   * Present ONLY on a guarded edge (D4 R1) — its absence is how the edge knows
   * to draw a plain solid line with no chip, which is every pre-D4 edge.
   * `resolution` is the projection's verdict, so the chip reports what the
   * engine actually decided rather than re-evaluating the guard.
   */
  guard?: { kind: "schema" | "else"; resolution: RouteEdgeResolution["kind"] };
  /**
   * The instance whose landed work satisfies this edge, when it differs from
   * the authored source — a concluded loop's external edge (D1). Topology still
   * renders the logical source; this is the provenance beside it.
   */
  effectiveSourceId?: string;
};

export type ContextDisplayPhase =
  | GraphWorkflowContextStatus
  | "validating"
  | "advisory-response"
  | "merging";

export type DisplayValidators = {
  script: boolean;
  agent: "claude" | "codex" | null;
};

export function getDisplayValidators(
  context: ExecutionContextNodeData["context"],
): DisplayValidators {
  return {
    script: getDisplayScriptGate(context.scriptValidator),
    agent: getDisplayAgentValidator(context.contextValidator),
  };
}

function getDisplayScriptGate(
  scriptValidator: ExecutionContextNodeData["context"]["scriptValidator"],
): boolean {
  if (!scriptValidator) return false;
  return scriptValidator.commands.length > 0;
}

// The node shows ONE agent-validator pill, so a cohort collapses to the backend
// its assignments run on — or `null` when they disagree, since a single pill
// claiming one backend for a mixed cohort would be worse than none.
function getDisplayAgentValidator(
  cohort: ExecutionContextNodeData["context"]["contextValidator"],
): "claude" | "codex" | null {
  if (!cohort?.enabled) return null;
  const backends = new Set(
    cohort.assignments.map((assignment) => assignment.agent.backend),
  );
  if (backends.size !== 1) return null;
  return [...backends][0] ?? null;
}

export function getDisplayApprovalGate(
  context: ExecutionContextNodeData["context"],
): boolean {
  return context.humanApprovalGate?.enabled === true;
}

export function getContextDisplayPhase(
  contextState: GraphWorkflowExecutionContextState | undefined,
): ContextDisplayPhase | undefined {
  if (!contextState) return undefined;
  if (contextState.mergeStatus === "in-progress") {
    return "merging";
  }
  if (contextState.status === "running") {
    // Ahead of the task-count check for the same reason as the wait state: a
    // context owing an advisory-response turn has already been certified, and
    // reading it as `validating` would colour the node for a review that is
    // over. `recertifying` falls through — a blocking round IS what runs next.
    if (contextState.advisoryResponse?.phase === "awaiting_response") {
      return "advisory-response";
    }
    if (
      contextState.totalTaskCount > 0 &&
      contextState.completedTaskCount >= contextState.totalTaskCount
    ) {
      return "validating";
    }
  }
  return contextState.status;
}

/** One incoming route as the inspector reports it (D4 R13 legibility). */
export type ContextRouteRow = {
  edgeId: string;
  logicalSourceId: string;
  effectiveSourceId: string | null;
  guard: "none" | "schema" | "else";
  resolution: RouteEdgeResolution["kind"];
};

/**
 * A context's incoming routes with the projection's verdict on each.
 *
 * The WHOLE conjunction is reported, not just the guarded edges: "why did this
 * context run / not run" is a statement about every incoming route, and an
 * omitted sibling is part of that answer.
 */
export function deriveContextRouteRows(
  execution: GraphWorkflowExecution,
  contextId: string,
  definition: DeriveGraphDefinition = execution.workingDefinition,
): ContextRouteRow[] {
  const projection = projectExecutionRoutes(execution, definition);
  return projection.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => ({
      edgeId: edge.edgeId,
      logicalSourceId: edge.logicalSourceId,
      effectiveSourceId: edge.effectiveSourceId,
      guard: edge.guard,
      resolution: edge.resolution.kind,
    }));
}

/**
 * The recorded skip verdicts of a skipped context, or null for every other
 * status. Read off the durable `skipReason` rather than re-projected: the
 * reason describes the moment the branch was decided, and a later projection
 * over a moved graph would answer a different question.
 */
export function deriveContextSkipDisplay(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextSkipDisplay | null {
  const state = execution.contextStates[contextId];
  if (!state || state.status !== "skipped" || !state.skipReason) return null;
  return {
    at: state.skipReason.at,
    edgeEvaluations: state.skipReason.edgeEvaluations,
    decidingEdgeIds: state.skipReason.edgeEvaluations
      .filter((evaluation) => evaluation.verdict === "inactive")
      .map((evaluation) => evaluation.edgeId),
  };
}

/**
 * A context's loop membership, or null when it is not a pass instance. Goes
 * through the shared `resolveLoopPassMembership` projection the inspector and
 * the CLI outline also read, so one instance cannot be badged three ways.
 */
export function deriveContextLoopDisplay(
  definition: DeriveGraphDefinition,
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextLoopDisplay | null {
  return resolveLoopPassMembership({
    contextId,
    loopGroups: definition.loopGroups ?? [],
    loopStates: execution.loopStates,
  });
}

/**
 * The accepted expansion that created this context, or null for one the planner
 * authored. Goes through `resolveExpansionProvenance` rather than re-deriving
 * from `addedContextIds`, so the badge and the audit ledger name one receipt.
 */
export function deriveContextProvenanceDisplay(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextProvenanceDisplay | null {
  const provenance = resolveExpansionProvenance(
    execution.expansionReceipts,
    contextId,
  );
  if (!provenance || provenance.nodeKind !== "context") return null;
  const { receipt } = provenance;
  return {
    requestId: receipt.requestId,
    invokerContextId: receipt.invokerContextId,
    rationale: receipt.rationale,
    payloadHash: receipt.payloadHash,
    acceptedAt: receipt.acceptedAt,
  };
}

export function deriveNodes(
  definition: DeriveGraphDefinition,
  layout: GraphWorkflowVisualLayout,
  execution?: GraphWorkflowExecution | null,
): Node<ExecutionContextNodeData>[] {
  const index = createExecutionIndex(definition, execution);

  return definition.executionContexts.map((context) => {
    const data: ExecutionContextNodeData = {
      context,
      tasks: index.tasksByContext.get(context.id) ?? [],
      mode: execution ? "execution" : "builder",
    };

    if (context.outputSchema !== undefined) {
      // Read through the D6 accessor rather than `execution.contextOutputs`, so
      // "captured" means the same thing on the node as it does in the inspector
      // and in the downstream prompt injection.
      data.outputSchema = {
        captured:
          execution != null &&
          getContextOutput(execution, context.id).kind === "captured",
      };
    }

    if (execution) {
      const ctxState = execution.contextStates[context.id];
      if (ctxState) {
        data.contextState = ctxState;
      }

      const waitState = deriveContextWaitState({
        contextId: context.id,
        definition,
        execution,
      });
      if (waitState) {
        data.waitState = waitState;
      }

      const taskStates = index.taskStatesByContext.get(context.id);
      if (taskStates && Object.keys(taskStates).length > 0) {
        data.taskStates = taskStates;
      }

      const skip = deriveContextSkipDisplay(execution, context.id);
      if (skip) {
        data.skip = skip;
      }

      const loop = deriveContextLoopDisplay(definition, execution, context.id);
      if (loop) {
        data.loop = loop;
      }

      const provenance = deriveContextProvenanceDisplay(execution, context.id);
      if (provenance) {
        data.provenance = provenance;
      }
    }

    return {
      id: context.id,
      type: "executionContext" as const,
      position: layout.contextPositions[context.id] ?? { x: 0, y: 0 },
      data,
    };
  });
}

export function deriveEdges(
  definition: DeriveGraphDefinition,
  execution?: GraphWorkflowExecution | null,
): Edge<ContextEdgeData>[] {
  // Topology renders the LOGICAL source (decision D1) — the authored edge is
  // what the author drew and what the layout positions — while the STATUS the
  // edge paints follows the EFFECTIVE source, i.e. the instance whose landed
  // work actually satisfies it.
  const projection = execution
    ? projectExecutionRoutes(execution, definition)
    : null;

  return definition.edges.map((edge) => {
    const data: ContextEdgeData = {};

    if (execution) {
      const resolved = projection
        ? resolvedRouteEdge(projection, edge.id)
        : undefined;
      const sourceId = resolved?.effectiveSourceId ?? edge.sourceContextId;
      data.sourceStatus = execution.contextStates[sourceId]?.status;
      data.targetStatus = execution.contextStates[edge.targetContextId]?.status;
      if (resolved && resolved.guard !== "none") {
        data.guard = {
          kind: resolved.guard,
          resolution: resolved.resolution.kind,
        };
      }
      if (
        resolved?.effectiveSourceId != null &&
        resolved.effectiveSourceId !== resolved.logicalSourceId
      ) {
        data.effectiveSourceId = resolved.effectiveSourceId;
      }
    }

    return {
      id: edge.id,
      source: edge.sourceContextId,
      target: edge.targetContextId,
      type: "contextEdge" as const,
      data,
    };
  });
}
