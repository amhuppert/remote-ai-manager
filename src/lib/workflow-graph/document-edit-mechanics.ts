import type {
  GraphWorkflowContextEdge,
  GraphWorkflowTaskDefinition,
} from "./definition-schemas";
import type { DefinitionEditTaskPosition } from "@/lib/workflows/edit-schemas";

/** Context task ids in current `order`. */
export function orderedContextTaskIds(
  tasks: readonly GraphWorkflowTaskDefinition[],
  contextId: string,
): string[] {
  return tasks
    .filter((task) => task.contextId === contextId)
    .sort((a, b) => a.order - b.order)
    .map((task) => task.id);
}

/** Assign dense 1..n `order` to the given task ids in list order. */
export function setTaskOrder(
  tasks: readonly GraphWorkflowTaskDefinition[],
  orderedTaskIds: readonly string[],
): void {
  orderedTaskIds.forEach((taskId, position) => {
    const task = tasks.find((entry) => entry.id === taskId);
    if (task) task.order = position + 1;
  });
}

/** Renumber a context's tasks densely by their current relative order. */
export function resequenceContextTasks(
  tasks: readonly GraphWorkflowTaskDefinition[],
  contextId: string,
): void {
  setTaskOrder(tasks, orderedContextTaskIds(tasks, contextId));
}

/**
 * Place `taskId` (already assigned to `contextId`) at `position` within its
 * context, then densely renumber the context. `position` is relative — the
 * server owns the numeric `order`, agents never write it. Returns an error when
 * an `after`/`before` anchor is not a sibling task.
 */
export function placeTask(
  tasks: readonly GraphWorkflowTaskDefinition[],
  contextId: string,
  taskId: string,
  position: DefinitionEditTaskPosition | undefined,
): { ok: true } | { ok: false; message: string } {
  const siblings = orderedContextTaskIds(tasks, contextId).filter(
    (id) => id !== taskId,
  );

  let insertIndex: number;
  if (position === undefined || "at" in position) {
    insertIndex = position && position.at === "start" ? 0 : siblings.length;
  } else if ("after" in position) {
    const anchor = siblings.indexOf(position.after);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.after}" is not in context "${contextId}"`,
      };
    }
    insertIndex = anchor + 1;
  } else {
    const anchor = siblings.indexOf(position.before);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.before}" is not in context "${contextId}"`,
      };
    }
    insertIndex = anchor;
  }

  siblings.splice(insertIndex, 0, taskId);
  setTaskOrder(tasks, siblings);
  return { ok: true };
}

export function isPermutation(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of b) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

export function insertTask(
  tasks: GraphWorkflowTaskDefinition[],
  task: GraphWorkflowTaskDefinition,
  position: DefinitionEditTaskPosition | undefined,
) {
  tasks.push(task);
  return placeTask(tasks, task.contextId, task.id, position);
}

export function removeTask(
  tasks: GraphWorkflowTaskDefinition[],
  task: GraphWorkflowTaskDefinition,
): void {
  const index = tasks.findIndex((entry) => entry.id === task.id);
  if (index < 0) return;
  tasks.splice(index, 1);
  resequenceContextTasks(tasks, task.contextId);
}

export function moveTask(
  tasks: GraphWorkflowTaskDefinition[],
  task: GraphWorkflowTaskDefinition,
  contextId: string,
  position: DefinitionEditTaskPosition | undefined,
) {
  const sourceContextId = task.contextId;
  task.contextId = contextId;
  const placed = placeTask(tasks, contextId, task.id, position);
  if (!placed.ok) {
    // Restore the original context before bailing so a rejected batch never
    // half-moves a task (the caller discards its draft, but stay consistent).
    task.contextId = sourceContextId;
    return placed;
  }
  if (sourceContextId !== contextId)
    resequenceContextTasks(tasks, sourceContextId);
  return placed;
}

export function removeContextContent<Context extends { id: string }>(
  definition: {
    executionContexts: Context[];
    tasks: GraphWorkflowTaskDefinition[];
    edges: GraphWorkflowContextEdge[];
  },
  contextId: string,
): void {
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
}

type EdgeTarget = {
  edgeId?: string;
  sourceContextId?: string;
  targetContextId?: string;
};

/** Every edge an endpoint- or id-addressed `remove-edge` could mean. */
export function matchEdgeTargets(
  edges: readonly GraphWorkflowContextEdge[],
  operation: EdgeTarget,
): GraphWorkflowContextEdge[] {
  if (operation.edgeId !== undefined) {
    return edges.filter((edge) => edge.id === operation.edgeId);
  }
  return edges.filter(
    (edge) =>
      edge.sourceContextId === operation.sourceContextId &&
      edge.targetContextId === operation.targetContextId,
  );
}

type ResolvedEdgeTarget =
  | { ok: true; edge: GraphWorkflowContextEdge }
  | {
      ok: false;
      code: "unknown-edge" | "ambiguous-edge-endpoints";
      message: string;
      extra: { edgeId?: string };
    };

/**
 * Resolve the single edge a `remove-edge` addresses. Endpoint addressing stays
 * supported alongside id addressing. Once a definition carries parallel edges
 * between one pair, silently removing whichever came first would delete the
 * wrong guard. So
 * an ambiguous endpoint pair refuses and names the candidate ids, which are the
 * `edgeId` values the caller retries with (D4 decision D2).
 */
export function resolveEdgeTarget(
  edges: readonly GraphWorkflowContextEdge[],
  operation: EdgeTarget,
): ResolvedEdgeTarget {
  const matches = matchEdgeTargets(edges, operation);
  const described =
    operation.edgeId !== undefined
      ? `"${operation.edgeId}"`
      : `${operation.sourceContextId} → ${operation.targetContextId}`;

  if (matches.length === 0) {
    return {
      ok: false,
      code: "unknown-edge",
      message: `no edge ${described}`,
      extra: operation.edgeId !== undefined ? { edgeId: operation.edgeId } : {},
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "ambiguous-edge-endpoints",
      message: `${matches.length} edges match ${described}; address one by edgeId: ${matches
        .map((edge) => edge.id)
        .join(", ")}`,
      extra: {},
    };
  }
  const edge = matches[0];
  if (!edge) throw new Error("single edge match missing");
  return { ok: true, edge };
}

export function updateEdgeGuard(
  edge: GraphWorkflowContextEdge,
  when: GraphWorkflowContextEdge["when"] | null,
): void {
  if (when === null) delete edge.when;
  else if (when !== undefined) edge.when = when;
}

export function removeEdge(
  edges: readonly GraphWorkflowContextEdge[],
  edgeId: string,
): GraphWorkflowContextEdge[] {
  return edges.filter((edge) => edge.id !== edgeId);
}
