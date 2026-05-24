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
} from "@/lib/workflows/schemas";
import {
  deriveContextWaitState,
  type ContextWaitState,
} from "./derive-wait-state";
import { createExecutionIndex } from "@/lib/workflow-graph/execution-index";

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
  waitState?: ContextWaitState;
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
  const validator = context.contextValidator;
  if (
    validator &&
    "enabled" in validator &&
    "type" in validator &&
    validator.enabled === true
  ) {
    return { script, agent: validator.type };
  }
  return { script, agent: null };
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
