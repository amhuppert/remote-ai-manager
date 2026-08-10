import type {
  DeliveryPlanContextType,
  DeliveryPlanDocument,
  DeliveryPlanEdge,
} from "@/lib/specs/delivery-plan";

/**
 * The authored plan laid out for reading. This is presentation only: every
 * classification a reviewer acts on (disposition, delivery class, freshness,
 * health, candidate identity) is resolved by the server projection and passed
 * through untouched. What happens here is layering — which contexts can start
 * before which — and it exists because a rank is a property of how the graph
 * draws, not a fact about the plan.
 */

export interface DeliveryPlanGraphNode {
  readonly contextId: string;
  readonly title: string;
  readonly contextType: DeliveryPlanContextType;
  readonly ownedCriterionCount: number;
  readonly taskCount: number;
  /** The contexts this one waits on, in document edge order. */
  readonly dependsOnContextIds: readonly string[];
}

export interface DeliveryPlanGraph {
  /** Contexts grouped by dependency depth; rank 0 has nothing upstream. */
  readonly ranks: readonly (readonly DeliveryPlanGraphNode[])[];
  readonly edges: readonly DeliveryPlanEdge[];
  /**
   * Contexts the layering could not order because they sit on a cycle. Plan
   * lint refuses a cycle at propose; a draft can still carry one, and naming
   * the contexts is what lets the surface say so instead of drawing a lie.
   */
  readonly cyclicContextIds: readonly string[];
  /** Edges naming a context the document does not define. */
  readonly danglingEdges: readonly DeliveryPlanEdge[];
}

export function deliveryPlanGraph(
  document: DeliveryPlanDocument,
): DeliveryPlanGraph {
  const order = document.contexts.map((context) => context.contextId);
  const known = new Set(order);
  const spans = (edge: DeliveryPlanEdge): boolean =>
    known.has(edge.fromContextId) && known.has(edge.toContextId);
  const danglingEdges = document.edges.filter((edge) => !spans(edge));
  const live = document.edges.filter(spans);

  const incoming = new Map<string, string[]>(order.map((id) => [id, []]));
  const outgoing = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const edge of live) {
    incoming.get(edge.toContextId)?.push(edge.fromContextId);
    outgoing.get(edge.fromContextId)?.push(edge.toContextId);
  }

  const taskCounts = new Map<string, number>();
  for (const task of document.tasks) {
    taskCounts.set(task.contextId, (taskCounts.get(task.contextId) ?? 0) + 1);
  }

  // Longest-path layering by Kahn traversal: a node settles one layer past its
  // deepest settled dependency, so an edge always points strictly downward.
  const remaining = new Map(
    order.map((id) => [id, incoming.get(id)?.length ?? 0]),
  );
  const rankOf = new Map<string, number>();
  let frontier = order.filter((id) => remaining.get(id) === 0);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const depth = (incoming.get(id) ?? []).reduce(
        (deepest, from) => Math.max(deepest, (rankOf.get(from) ?? 0) + 1),
        0,
      );
      rankOf.set(id, depth);
      for (const to of outgoing.get(id) ?? []) {
        const left = (remaining.get(to) ?? 0) - 1;
        remaining.set(to, left);
        if (left === 0) next.push(to);
      }
    }
    frontier = next;
  }

  const cyclicContextIds = order.filter((id) => !rankOf.has(id));
  const settledDepth = Math.max(-1, ...rankOf.values());
  for (const id of cyclicContextIds) rankOf.set(id, settledDepth + 1);

  const nodes: DeliveryPlanGraphNode[] = document.contexts.map((context) => ({
    contextId: context.contextId,
    title: context.title,
    contextType: context.contextType,
    ownedCriterionCount: context.criterionElementIds.length,
    taskCount: taskCounts.get(context.contextId) ?? 0,
    dependsOnContextIds: incoming.get(context.contextId) ?? [],
  }));

  const depth = Math.max(-1, ...[...rankOf.values()]);
  const ranks: DeliveryPlanGraphNode[][] = Array.from(
    { length: depth + 1 },
    () => [],
  );
  for (const node of nodes) {
    ranks[rankOf.get(node.contextId) ?? 0]?.push(node);
  }

  return { ranks, edges: live, cyclicContextIds, danglingEdges };
}
