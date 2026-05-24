import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
type PlanInputDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

/**
 * Advisory deterministic lane plan computed at execution seed time.
 *
 * `continuationMap` records, for each parent context that has at least one
 * downstream child, which child should inherit the parent's lane during
 * fan-out. The scheduler uses this to decide reuse vs fork: the named child
 * inherits the parent lane; every other concurrently-ready child forks from
 * the parent lane's committed head into a new worktree lane.
 *
 * `longestDownstreamPath` is the unweighted longest path length from a context
 * to any terminal. Terminals are 0. Stored so callers can inspect plan output
 * and so deterministic restart can compare expected continuation scores.
 */
export interface LanePlan {
  continuationMap: Record<string, string>;
  longestDownstreamPath: Record<string, number>;
}

/**
 * Compute the advisory lane plan for a workflow definition. Pure — no I/O,
 * no mutation. Deterministic for a given definition: continuation picks use
 * unweighted longest downstream path as the primary signal, task count as the
 * secondary tiebreaker, and workflow definition order as the final tiebreaker.
 */
export function computeLanePlan(definition: PlanInputDefinition): LanePlan {
  const contextIds = definition.executionContexts.map((ctx) => ctx.id);
  const contextOrder = new Map<string, number>(
    contextIds.map((id, index) => [id, index]),
  );

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of contextIds) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of definition.edges) {
    outgoing.get(edge.sourceContextId)?.push(edge.targetContextId);
    incoming.get(edge.targetContextId)?.push(edge.sourceContextId);
  }

  const taskCounts = countTasksByContext(definition);
  const longestDownstreamPath = computeLongestDownstreamPath(
    contextIds,
    outgoing,
  );

  const continuationMap: Record<string, string> = {};
  for (const parentId of contextIds) {
    const children = outgoing.get(parentId) ?? [];
    if (children.length === 0) continue;
    const chosen = pickContinuationChild({
      children,
      longestDownstreamPath,
      taskCounts,
      contextOrder,
    });
    if (chosen !== null) {
      continuationMap[parentId] = chosen;
    }
  }

  return { continuationMap, longestDownstreamPath };
}

/**
 * Recompute the lane plan for a subset of contexts and merge with the previous
 * plan. Use this for runtime edits or context resets that only affect a
 * not-yet-started portion of the graph — passing all context ids recomputes
 * the entire plan and is equivalent to {@link computeLanePlan}.
 *
 * Entries outside the affected subgraph (the union of the supplied context ids
 * and every transitive ancestor) are preserved from {@link previousPlan}.
 */
export function recomputeLanePlanForSubgraph(input: {
  definition: PlanInputDefinition;
  previousPlan: LanePlan;
  contextIds: readonly string[];
}): LanePlan {
  const { definition, previousPlan, contextIds } = input;
  const affected = collectAffectedAncestors(definition, contextIds);
  const fresh = computeLanePlan(definition);

  const mergedContinuationMap: Record<string, string> = {};
  const mergedLongest: Record<string, number> = {};

  for (const ctx of definition.executionContexts) {
    if (affected.has(ctx.id)) {
      if (fresh.continuationMap[ctx.id] !== undefined) {
        mergedContinuationMap[ctx.id] = fresh.continuationMap[ctx.id]!;
      }
      mergedLongest[ctx.id] = fresh.longestDownstreamPath[ctx.id] ?? 0;
      continue;
    }
    if (previousPlan.continuationMap[ctx.id] !== undefined) {
      mergedContinuationMap[ctx.id] = previousPlan.continuationMap[ctx.id]!;
    }
    if (previousPlan.longestDownstreamPath[ctx.id] !== undefined) {
      mergedLongest[ctx.id] = previousPlan.longestDownstreamPath[ctx.id]!;
    } else {
      mergedLongest[ctx.id] = fresh.longestDownstreamPath[ctx.id] ?? 0;
    }
  }

  return {
    continuationMap: mergedContinuationMap,
    longestDownstreamPath: mergedLongest,
  };
}

function countTasksByContext(
  definition: PlanInputDefinition,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ctx of definition.executionContexts) {
    counts.set(ctx.id, 0);
  }
  for (const task of definition.tasks) {
    counts.set(task.contextId, (counts.get(task.contextId) ?? 0) + 1);
  }
  return counts;
}

function computeLongestDownstreamPath(
  contextIds: readonly string[],
  outgoing: Map<string, string[]>,
): Record<string, number> {
  const longest: Record<string, number> = {};
  const inProgress = new Set<string>();

  function visit(id: string): number {
    if (longest[id] !== undefined) return longest[id]!;
    if (inProgress.has(id)) {
      // Cycle protection: treat any context already in the DFS stack as 0 so
      // we never recurse forever on a malformed graph. Graph validation
      // upstream rejects cycles, but the planner must remain pure and safe.
      return 0;
    }
    inProgress.add(id);
    let best = 0;
    for (const child of outgoing.get(id) ?? []) {
      const childDepth = visit(child) + 1;
      if (childDepth > best) best = childDepth;
    }
    inProgress.delete(id);
    longest[id] = best;
    return best;
  }

  for (const id of contextIds) {
    visit(id);
  }
  return longest;
}

function pickContinuationChild(input: {
  children: readonly string[];
  longestDownstreamPath: Record<string, number>;
  taskCounts: Map<string, number>;
  contextOrder: Map<string, number>;
}): string | null {
  const { children, longestDownstreamPath, taskCounts, contextOrder } = input;
  if (children.length === 0) return null;

  // De-duplicate while preserving definition order.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const child of children) {
    if (seen.has(child)) continue;
    seen.add(child);
    candidates.push(child);
  }

  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (
      preferCandidate(candidate, best, {
        longestDownstreamPath,
        taskCounts,
        contextOrder,
      })
    ) {
      best = candidate;
    }
  }
  return best;
}

function preferCandidate(
  candidate: string,
  current: string,
  ctx: {
    longestDownstreamPath: Record<string, number>;
    taskCounts: Map<string, number>;
    contextOrder: Map<string, number>;
  },
): boolean {
  const candidatePath = ctx.longestDownstreamPath[candidate] ?? 0;
  const currentPath = ctx.longestDownstreamPath[current] ?? 0;
  if (candidatePath !== currentPath) return candidatePath > currentPath;

  const candidateTaskCount = ctx.taskCounts.get(candidate) ?? 0;
  const currentTaskCount = ctx.taskCounts.get(current) ?? 0;
  if (candidateTaskCount !== currentTaskCount) {
    return candidateTaskCount > currentTaskCount;
  }

  const candidateOrder =
    ctx.contextOrder.get(candidate) ?? Number.MAX_SAFE_INTEGER;
  const currentOrder = ctx.contextOrder.get(current) ?? Number.MAX_SAFE_INTEGER;
  return candidateOrder < currentOrder;
}

function collectAffectedAncestors(
  definition: PlanInputDefinition,
  seedIds: readonly string[],
): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const ctx of definition.executionContexts) {
    incoming.set(ctx.id, []);
  }
  for (const edge of definition.edges) {
    incoming.get(edge.targetContextId)?.push(edge.sourceContextId);
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  for (const id of seedIds) {
    if (!visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of incoming.get(current) ?? []) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      queue.push(parent);
    }
  }
  return visited;
}
