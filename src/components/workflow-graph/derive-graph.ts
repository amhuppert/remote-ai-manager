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
import { getContextOutput } from "@/lib/workflow-graph/context-outputs";

/**
 * The graph is a read-only projection, so it takes the CASCADE shape: a seeded
 * context is a cascade context plus `profileSnapshot`, and nothing here reads
 * the snapshot — one type therefore serves both the builder preview (which has
 * no snapshots) and a running execution.
 */
type DeriveGraphDefinition =
  | WorkflowSemanticDefinition
  | CascadeWorkflowSemanticDefinition;

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
};

export type ContextEdgeData = {
  sourceStatus?: GraphWorkflowContextStatus;
  targetStatus?: GraphWorkflowContextStatus;
};

export type ContextDisplayPhase =
  | GraphWorkflowContextStatus
  | "validating"
  | "merging";

export type DisplayValidators = {
  script: boolean;
  agent: "claude" | "codex" | null;
};

export function getDisplayValidators(
  context: ExecutionContextNodeData["context"],
): DisplayValidators {
  const script = context.scriptValidator?.enabled === true;
  return { script, agent: getDisplayAgentValidator(context.contextValidator) };
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
  if (
    contextState.status === "running" &&
    contextState.totalTaskCount > 0 &&
    contextState.completedTaskCount >= contextState.totalTaskCount
  ) {
    return "validating";
  }
  return contextState.status;
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
  return definition.edges.map((edge) => {
    const data: ContextEdgeData = {};

    if (execution) {
      data.sourceStatus = execution.contextStates[edge.sourceContextId]?.status;
      data.targetStatus = execution.contextStates[edge.targetContextId]?.status;
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
