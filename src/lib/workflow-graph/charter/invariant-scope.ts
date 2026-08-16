import type {
  CharterInvariant,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import { parseLoopInstanceId } from "@/lib/workflow-graph/loop-resolver";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

export type InvariantScopeExecution = Pick<
  GraphWorkflowExecution,
  "charter" | "expansionReceipts" | "workingDefinition"
>;

export interface ApplicableCharterInvariants {
  logicalContextId: string | null;
  invariants: CharterInvariant[];
}

export function collectLogicalAuthoredContextIds(
  execution: InvariantScopeExecution,
): Set<string> {
  const loopGroups = execution.workingDefinition.loopGroups ?? [];
  const loopGroupIds = loopGroups.map((group) => group.id);
  const contextIds = new Set<string>();

  for (const context of execution.workingDefinition.executionContexts) {
    const expansion = resolveExpansionProvenance(
      execution.expansionReceipts,
      context.id,
    );
    if (expansion?.nodeKind === "context") continue;
    if (parseLoopInstanceId(context.id, loopGroupIds)) continue;
    contextIds.add(context.id);
  }

  for (const group of loopGroups) {
    for (const context of group.template.contexts) {
      contextIds.add(context.id);
    }
  }

  return contextIds;
}

function resolveLogicalContextId(
  execution: InvariantScopeExecution,
  contextId: string,
  visited: Set<string>,
): string | null {
  if (visited.has(contextId)) return null;
  visited.add(contextId);

  const expansion = resolveExpansionProvenance(
    execution.expansionReceipts,
    contextId,
  );
  if (expansion?.nodeKind === "context") {
    return resolveLogicalContextId(
      execution,
      expansion.receipt.invokerContextId,
      visited,
    );
  }

  const loopGroups = execution.workingDefinition.loopGroups ?? [];
  const loopInstance = parseLoopInstanceId(
    contextId,
    loopGroups.map((group) => group.id),
  );
  if (loopInstance) {
    return loopInstance.authoredId;
  }

  return execution.workingDefinition.executionContexts.some(
    (context) => context.id === contextId,
  )
    ? contextId
    : null;
}

export function resolveLogicalAuthoredContextId(input: {
  execution: InvariantScopeExecution;
  contextId: string;
}): string | null {
  return resolveLogicalContextId(input.execution, input.contextId, new Set());
}

export function resolveApplicableCharterInvariants(input: {
  execution: InvariantScopeExecution;
  contextId: string;
  charter?: WorkflowCharter;
}): ApplicableCharterInvariants {
  const logicalContextId = resolveLogicalAuthoredContextId(input);
  const charter = input.charter ?? input.execution.charter;
  const invariants = (charter.invariants ?? []).filter(
    (invariant) =>
      invariant.appliesTo === undefined ||
      (logicalContextId !== null &&
        invariant.appliesTo.contextIds.includes(logicalContextId)),
  );

  return { logicalContextId, invariants };
}

export function resolveScopedCharterForContext(input: {
  execution: InvariantScopeExecution;
  contextId: string;
  charter?: WorkflowCharter;
}): WorkflowCharter {
  const charter = input.charter ?? input.execution.charter;
  if (charter.invariants === undefined) return charter;

  return {
    ...charter,
    invariants: resolveApplicableCharterInvariants(input).invariants,
  };
}
