import type { Node, Edge } from "@xyflow/react";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowExecutionContextState,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/types";

type DeriveGraphDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type ExecutionContextNodeData = {
  context:
    | GraphWorkflowExecutionContextDefinition
    | GraphWorkflowResolvedContext;
  tasks: GraphWorkflowTaskDefinition[];
  mode: "builder" | "execution";
  contextState?: GraphWorkflowExecutionContextState;
  taskStates?: Record<string, GraphWorkflowTaskState>;
};

export type ContextEdgeData = {
  sourceStatus?: GraphWorkflowContextStatus;
  targetStatus?: GraphWorkflowContextStatus;
};

export type ContextDisplayPhase =
  | GraphWorkflowContextStatus
  | "validating"
  | "merging";

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
  return definition.executionContexts.map((context) => {
    const tasks = definition.tasks
      .filter((t) => t.contextId === context.id)
      .sort((a, b) => a.order - b.order);

    const data: ExecutionContextNodeData = {
      context,
      tasks,
      mode: execution ? "execution" : "builder",
    };

    if (execution) {
      const ctxState = execution.contextStates[context.id];
      if (ctxState) {
        data.contextState = ctxState;
      }

      const filteredTaskStates: Record<string, GraphWorkflowTaskState> = {};
      for (const [taskId, taskState] of Object.entries(execution.taskStates)) {
        if (taskState.contextId === context.id) {
          filteredTaskStates[taskId] = taskState;
        }
      }
      if (Object.keys(filteredTaskStates).length > 0) {
        data.taskStates = filteredTaskStates;
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
