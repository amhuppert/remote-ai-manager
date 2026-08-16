import type { WorkflowSemanticDefinition } from "./definition-schemas";

export function collectStableAccountabilityContextIds(
  definition: WorkflowSemanticDefinition,
): string[] {
  const loopBodyContextIds = new Set(
    (definition.loopGroups ?? []).flatMap((group) => group.bodyContextIds),
  );
  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => !loopBodyContextIds.has(contextId));
}
