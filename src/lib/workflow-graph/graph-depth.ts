/**
 * Dependency depth per context — the longest path from any root, which is what
 * both the band ordering and the automatic layout mean by "left to right".
 *
 * Structurally typed rather than tied to a definition schema so the authored,
 * cascade and resolved shapes all satisfy it with no adapter.
 */
export interface DepthGraph {
  executionContexts: readonly { id: string }[];
  edges: readonly { sourceContextId: string; targetContextId: string }[];
}

export function computeContextDepths(graph: DepthGraph): Map<string, number> {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const context of graph.executionContexts) {
    incoming.set(context.id, 0);
    outgoing.set(context.id, []);
  }

  for (const edge of graph.edges) {
    outgoing.get(edge.sourceContextId)?.push(edge.targetContextId);
    incoming.set(
      edge.targetContextId,
      (incoming.get(edge.targetContextId) ?? 0) + 1,
    );
  }

  const queue = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([contextId]) => contextId);
  const depth = new Map<string, number>(
    queue.map((contextId) => [contextId, 0]),
  );

  while (queue.length > 0) {
    const contextId = queue.shift()!;
    const currentDepth = depth.get(contextId) ?? 0;

    for (const nextContextId of outgoing.get(contextId) ?? []) {
      const nextDepth = Math.max(
        depth.get(nextContextId) ?? 0,
        currentDepth + 1,
      );
      depth.set(nextContextId, nextDepth);
      const nextIncoming = (incoming.get(nextContextId) ?? 0) - 1;
      incoming.set(nextContextId, nextIncoming);
      if (nextIncoming === 0) {
        queue.push(nextContextId);
      }
    }
  }

  // A context inside a dependency cycle never drains its incoming count, so it
  // never leaves the queue. Depth 0 keeps it on the canvas rather than dropping
  // it — the cycle is refused at validation, not here.
  for (const context of graph.executionContexts) {
    if (!depth.has(context.id)) {
      depth.set(context.id, 0);
    }
  }

  return depth;
}
