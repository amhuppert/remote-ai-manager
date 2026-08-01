import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  GraphWorkflowVisualLayout,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  validateWorkflowDefinition,
  type WorkflowGraphValidationError,
} from "./validation";

export type ContextOverrideBlock =
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "mutability"
  | "circuitBreaker"
  | "iterationPolicy"
  | "planRepair"
  | "collaboration";

export type WorkflowConfigBlock =
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "iterationPolicy"
  | "circuitBreaker"
  | "mutability"
  | "planRepair"
  | "collaboration"
  | "humanApprovalGate"
  | "askUserQuestions";

export interface WorkflowBuilderDraftData {
  definition: WorkflowSemanticDefinition;
  layout: GraphWorkflowVisualLayout;
}

export interface WorkflowBuilderMutationResult {
  ok: boolean;
  definition: WorkflowSemanticDefinition;
  errors: WorkflowGraphValidationError[];
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortTasks(
  tasks: GraphWorkflowTaskDefinition[],
): GraphWorkflowTaskDefinition[] {
  return [...tasks].sort((left, right) => left.order - right.order);
}

function renumberContextTasks(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  orderedTasks: GraphWorkflowTaskDefinition[],
): WorkflowSemanticDefinition {
  const otherTasks = definition.tasks.filter(
    (task) => task.contextId !== contextId,
  );
  return {
    ...definition,
    tasks: [
      ...otherTasks,
      ...orderedTasks.map((task, index) => ({
        ...task,
        order: index + 1,
      })),
    ],
  };
}

function nextSequentialContextNumber(
  definition: WorkflowSemanticDefinition,
): number {
  const explicitNumbers = definition.executionContexts
    .map((context) => /^context-(\d+)$/.exec(context.id)?.[1])
    .filter((value): value is string => value != null)
    .map((value) => Number.parseInt(value, 10));

  const maxExplicit =
    explicitNumbers.length > 0 ? Math.max(...explicitNumbers) : 0;
  return Math.max(definition.executionContexts.length + 1, maxExplicit + 1);
}

function createContextEdgeId(
  sourceContextId: string,
  targetContextId: string,
): string {
  return `edge-${sourceContextId}-${targetContextId}`;
}

function createTaskId(contextId: string, order: number): string {
  const numericContextId = /^context-(\d+)$/.exec(contextId)?.[1];
  if (numericContextId && order === 1) {
    return `task-${numericContextId}`;
  }
  return `task-${contextId}-${order}`;
}

export function addExecutionContext(
  draft: WorkflowBuilderDraftData,
): WorkflowBuilderDraftData & { contextId: string } {
  const definition = cloneValue(draft.definition);
  const layout = cloneValue(draft.layout);
  const contextNumber = nextSequentialContextNumber(definition);
  const contextId = `context-${contextNumber}`;
  const maxX = Object.values(layout.contextPositions).reduce(
    (currentMax, position) => Math.max(currentMax, position.x),
    0,
  );

  definition.executionContexts.push({
    id: contextId,
    title: `Execution Context ${contextNumber}`,
    acceptanceCriteria: "",
  });

  layout.contextPositions[contextId] = {
    x: maxX + 360,
    y: 0,
  };

  return {
    definition,
    layout,
    contextId,
  };
}

export function updateExecutionContext(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  updates: Partial<WorkflowSemanticDefinition["executionContexts"][number]>,
): WorkflowSemanticDefinition {
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<WorkflowSemanticDefinition["executionContexts"][number]>;
  return {
    ...cloneValue(definition),
    executionContexts: definition.executionContexts.map((context) =>
      context.id === contextId ? { ...context, ...definedUpdates } : context,
    ),
  };
}

export function deleteExecutionContext(
  draft: WorkflowBuilderDraftData,
  contextId: string,
): WorkflowBuilderDraftData {
  const definition = cloneValue(draft.definition);
  const layout = cloneValue(draft.layout);

  definition.executionContexts = definition.executionContexts.filter(
    (context) => context.id !== contextId,
  );
  definition.tasks = definition.tasks.filter(
    (task) => task.contextId !== contextId,
  );
  definition.edges = definition.edges.filter(
    (edge) =>
      edge.sourceContextId !== contextId && edge.targetContextId !== contextId,
  );
  delete layout.contextPositions[contextId];

  return {
    definition,
    layout,
  };
}

export function addContextDependency(
  definition: WorkflowSemanticDefinition,
  sourceContextId: string,
  targetContextId: string,
): WorkflowBuilderMutationResult {
  if (sourceContextId === targetContextId) {
    return {
      ok: false,
      definition,
      errors: [
        {
          code: "self-edge",
          message: "Execution contexts cannot depend on themselves",
          contextId: sourceContextId,
        },
      ],
    };
  }

  if (
    definition.edges.some(
      (edge) =>
        edge.sourceContextId === sourceContextId &&
        edge.targetContextId === targetContextId,
    )
  ) {
    return {
      ok: false,
      definition,
      errors: [
        {
          code: "duplicate-edge",
          message: "Dependency already exists",
          edgeId: createContextEdgeId(sourceContextId, targetContextId),
        },
      ],
    };
  }

  const nextDefinition = cloneValue(definition);
  nextDefinition.edges.push({
    id: createContextEdgeId(sourceContextId, targetContextId),
    sourceContextId,
    targetContextId,
  });

  const validation = validateWorkflowDefinition(nextDefinition);
  if (!validation.ok) {
    return {
      ok: false,
      definition,
      errors: validation.errors,
    };
  }

  return {
    ok: true,
    definition: nextDefinition,
    errors: [],
  };
}

export function removeContextDependency(
  definition: WorkflowSemanticDefinition,
  edgeId: string,
): WorkflowSemanticDefinition {
  return {
    ...cloneValue(definition),
    edges: definition.edges.filter((edge) => edge.id !== edgeId),
  };
}

export function addTaskToContext(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): { definition: WorkflowSemanticDefinition; taskId: string } {
  const tasksForContext = sortTasks(
    definition.tasks.filter((task) => task.contextId === contextId),
  );
  const nextOrder = tasksForContext.length + 1;
  const taskId = createTaskId(contextId, nextOrder);

  return {
    definition: {
      ...cloneValue(definition),
      tasks: [
        ...definition.tasks,
        {
          id: taskId,
          contextId,
          order: nextOrder,
          title: `New Task ${nextOrder}`,
          instructions: "",
          source: "user",
        },
      ],
    },
    taskId,
  };
}

export function updateTask(
  definition: WorkflowSemanticDefinition,
  taskId: string,
  updates: Partial<GraphWorkflowTaskDefinition>,
): WorkflowSemanticDefinition {
  return {
    ...cloneValue(definition),
    tasks: definition.tasks.map((task) =>
      task.id === taskId ? { ...task, ...updates } : task,
    ),
  };
}

export function removeTask(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  taskId: string,
): WorkflowSemanticDefinition {
  const tasksForContext = sortTasks(
    definition.tasks.filter(
      (task) => task.contextId === contextId && task.id !== taskId,
    ),
  );
  return renumberContextTasks(definition, contextId, tasksForContext);
}

export function moveTaskWithinContext(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  taskId: string,
  direction: "up" | "down",
): WorkflowSemanticDefinition {
  const tasksForContext = sortTasks(
    definition.tasks.filter((task) => task.contextId === contextId),
  );
  const currentIndex = tasksForContext.findIndex((task) => task.id === taskId);
  if (currentIndex === -1) {
    return cloneValue(definition);
  }

  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= tasksForContext.length) {
    return cloneValue(definition);
  }

  const reordered = [...tasksForContext];
  const [task] = reordered.splice(currentIndex, 1);
  reordered.splice(nextIndex, 0, task!);
  return renumberContextTasks(definition, contextId, reordered);
}

export function setContextBlockOverride<K extends ContextOverrideBlock>(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  block: K,
  value: NonNullable<GraphWorkflowExecutionContextDefinition[K]>,
): WorkflowSemanticDefinition {
  return {
    ...cloneValue(definition),
    executionContexts: definition.executionContexts.map((context) =>
      context.id === contextId
        ? { ...context, [block]: cloneValue(value) }
        : context,
    ),
  };
}

/**
 * Set or clear a context's declared output schema.
 *
 * Separate from `setContextBlockOverride`/`clearContextBlockOverride` because
 * `outputSchema` is per-context IDENTITY, not a cascade override: there is no
 * workflow- or global-tier value to inherit or reset to, so "clear" means delete
 * the key outright. It is also why `updateExecutionContext` cannot express the
 * clear — that helper drops `undefined` entries so a partial patch never blanks
 * an untouched field, which leaves it no way to remove one.
 */
export function setContextOutputSchema(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  schema: Record<string, unknown> | null,
): WorkflowSemanticDefinition {
  return {
    ...cloneValue(definition),
    executionContexts: definition.executionContexts.map((context) => {
      if (context.id !== contextId) return context;
      if (schema === null) {
        const cleared = { ...context };
        delete cleared.outputSchema;
        return cleared;
      }
      return { ...context, outputSchema: cloneValue(schema) };
    }),
  };
}

export function clearContextBlockOverride(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  block: ContextOverrideBlock,
): WorkflowSemanticDefinition {
  const next = cloneValue(definition);
  next.executionContexts = next.executionContexts.map((context) => {
    if (context.id !== contextId) return context;
    const updated = { ...context };
    delete updated[block];
    return updated;
  });
  return next;
}

export function disableContextValidator(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): WorkflowSemanticDefinition {
  return setContextBlockOverride(definition, contextId, "contextValidator", {
    kind: "disabled",
  });
}

export function enableContextValidator(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): WorkflowSemanticDefinition {
  return clearContextBlockOverride(definition, contextId, "contextValidator");
}

export function setWorkflowConfigOverride<K extends WorkflowConfigBlock>(
  definition: WorkflowSemanticDefinition,
  block: K,
  value: NonNullable<WorkflowConfigOverride[K]>,
): WorkflowSemanticDefinition {
  const next = cloneValue(definition);
  next.workflowConfig = {
    ...next.workflowConfig,
    [block]: cloneValue(value),
  };
  return next;
}

export function clearWorkflowConfigOverride(
  definition: WorkflowSemanticDefinition,
  block: WorkflowConfigBlock,
): WorkflowSemanticDefinition {
  const next = cloneValue(definition);
  const updated = { ...next.workflowConfig };
  delete updated[block];
  next.workflowConfig = updated;
  return next;
}

export function updateContextPosition(
  layout: GraphWorkflowVisualLayout,
  contextId: string,
  position: { x: number; y: number },
): GraphWorkflowVisualLayout {
  return {
    ...cloneValue(layout),
    contextPositions: {
      ...layout.contextPositions,
      [contextId]: position,
    },
  };
}
