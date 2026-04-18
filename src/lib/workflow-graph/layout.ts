import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/types";

type LayoutInputDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type NodeDimensions = Map<string, { width: number; height: number }>;

const DEFAULT_NODE_WIDTH = 248;
const DEFAULT_NODE_HEIGHT = 200;
const MIN_X_GAP = 112;
const MIN_Y_GAP = 40;

function computeDepths(definition: LayoutInputDefinition): Map<string, number> {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const context of definition.executionContexts) {
    incoming.set(context.id, 0);
    outgoing.set(context.id, []);
  }

  for (const edge of definition.edges) {
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

  for (const context of definition.executionContexts) {
    if (!depth.has(context.id)) {
      depth.set(context.id, 0);
    }
  }

  return depth;
}

export function generateWorkflowLayout(
  definition: LayoutInputDefinition,
  existingLayout?: GraphWorkflowVisualLayout | null,
  nodeDimensions?: NodeDimensions,
): GraphWorkflowVisualLayout {
  const contextPositions: GraphWorkflowVisualLayout["contextPositions"] = {};
  const existingPositions = existingLayout?.contextPositions ?? {};
  const depths = computeDepths(definition);

  function nodeWidth(contextId: string): number {
    return nodeDimensions?.get(contextId)?.width ?? DEFAULT_NODE_WIDTH;
  }

  function nodeHeight(contextId: string): number {
    return nodeDimensions?.get(contextId)?.height ?? DEFAULT_NODE_HEIGHT;
  }

  // Compute max width per depth column to determine X offsets
  const maxWidthByDepth = new Map<number, number>();
  for (const context of definition.executionContexts) {
    const d = depths.get(context.id) ?? 0;
    maxWidthByDepth.set(
      d,
      Math.max(maxWidthByDepth.get(d) ?? 0, nodeWidth(context.id)),
    );
  }

  const xByDepth = new Map<number, number>();
  const sortedDepths = [...maxWidthByDepth.keys()].sort((a, b) => a - b);
  let cumulativeX = 0;
  for (const d of sortedDepths) {
    xByDepth.set(d, cumulativeX);
    cumulativeX += (maxWidthByDepth.get(d) ?? DEFAULT_NODE_WIDTH) + MIN_X_GAP;
  }

  // Track the next available Y position for each depth column
  const nextYByDepth = new Map<number, number>();

  for (const context of definition.executionContexts) {
    const existingPosition = existingPositions[context.id];
    if (existingPosition) {
      contextPositions[context.id] = existingPosition;
      const d = depths.get(context.id) ?? 0;
      const bottomEdge =
        existingPosition.y + nodeHeight(context.id) + MIN_Y_GAP;
      nextYByDepth.set(d, Math.max(nextYByDepth.get(d) ?? 0, bottomEdge));
      continue;
    }

    const d = depths.get(context.id) ?? 0;
    const y = nextYByDepth.get(d) ?? 0;
    nextYByDepth.set(d, y + nodeHeight(context.id) + MIN_Y_GAP);

    contextPositions[context.id] = {
      x: xByDepth.get(d) ?? 0,
      y,
    };
  }

  return {
    workflowId: existingLayout?.workflowId ?? "generated",
    contextPositions,
    viewport: existingLayout?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}
