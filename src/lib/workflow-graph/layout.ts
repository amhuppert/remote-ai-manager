import type {
  GraphWorkflowVisualLayout,
  WorkflowSemanticDefinition,
} from "@/types";

const X_SPACING = 360;
const Y_SPACING = 240;

function computeDepths(
  definition: WorkflowSemanticDefinition,
): Map<string, number> {
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
  definition: WorkflowSemanticDefinition,
  existingLayout?: GraphWorkflowVisualLayout | null,
): GraphWorkflowVisualLayout {
  const contextPositions: GraphWorkflowVisualLayout["contextPositions"] = {};
  const existingPositions = existingLayout?.contextPositions ?? {};
  const depths = computeDepths(definition);
  const rowsByDepth = new Map<number, number>();

  for (const context of definition.executionContexts) {
    const existingPosition = existingPositions[context.id];
    if (existingPosition) {
      contextPositions[context.id] = existingPosition;
      const depth = depths.get(context.id) ?? 0;
      const occupiedRow = Math.max(
        0,
        Math.round(existingPosition.y / Y_SPACING),
      );
      rowsByDepth.set(
        depth,
        Math.max(rowsByDepth.get(depth) ?? 0, occupiedRow + 1),
      );
      continue;
    }

    const depth = depths.get(context.id) ?? 0;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);

    contextPositions[context.id] = {
      x: depth * X_SPACING,
      y: row * Y_SPACING,
    };
  }

  return {
    workflowId: existingLayout?.workflowId ?? "generated",
    contextPositions,
    viewport: existingLayout?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}
