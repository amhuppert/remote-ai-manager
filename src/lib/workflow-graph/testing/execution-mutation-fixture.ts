import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
  ExecutionMutationDelivery,
} from "../execution-mutation";
import type { GraphWorkflowExecution } from "../schemas";
import { nextStructuralRevision } from "../structural-revision";

export function applyFixtureMutation<Value, Refusal>(
  current: GraphWorkflowExecution,
  reduce: (
    draft: GraphWorkflowExecution,
  ) => ExecutionMutationDecision<Value, Refusal>,
  commit: (
    execution: GraphWorkflowExecution,
    delivery: ExecutionMutationDelivery,
  ) => void,
): ExecutionMutationOutcome<Value, Refusal> {
  const decision = reduce(structuredClone(current));
  switch (decision.kind) {
    case "refused":
      return { ...decision, execution: current };
    case "unchanged":
      return { ...decision, execution: current };
    case "events_only": {
      if (
        decision.delivery.events.length === 0 &&
        decision.delivery.pushes.length === 0
      )
        throw new Error("An events_only mutation requires nonempty delivery");
      const execution = {
        ...current,
        executionStateRevision: current.executionStateRevision + 1,
      };
      commit(execution, decision.delivery);
      return { kind: decision.kind, value: decision.value, execution };
    }
    case "changed": {
      const execution = {
        ...decision.execution,
        executionStateRevision: current.executionStateRevision + 1,
        structuralRevision: nextStructuralRevision(current, decision.execution),
      };
      commit(execution, decision.delivery ?? { events: [], pushes: [] });
      return { kind: decision.kind, value: decision.value, execution };
    }
  }
}
