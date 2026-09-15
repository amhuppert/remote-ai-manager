import type { GraphWorkflowExecution } from "./schemas";
import type { GraphWorkflowEventDelivery } from "./execution-events";

export type ExecutionMutationDelivery = Pick<
  GraphWorkflowEventDelivery,
  "events" | "pushes"
> & {
  /** Context history retired atomically before this mutation's events are appended. */
  preResetContextIds?: readonly string[];
};

export type ExecutionMutationDecision<Value = void, Refusal = never> =
  | {
      kind: "changed";
      execution: GraphWorkflowExecution;
      value: Value;
      delivery?: ExecutionMutationDelivery;
    }
  | {
      kind: "events_only";
      value: Value;
      delivery: ExecutionMutationDelivery;
      execution?: never;
    }
  | { kind: "unchanged"; value: Value; execution?: never; delivery?: never }
  | {
      kind: "refused";
      refusal: Refusal;
      value?: never;
      execution?: never;
      delivery?: never;
    };

export type ExecutionMutationValue<Value, Refusal> =
  | { kind: "changed" | "events_only" | "unchanged"; value: Value }
  | { kind: "refused"; refusal: Refusal };

export type ExecutionMutationOutcome<
  Value = void,
  Refusal = never,
> = ExecutionMutationValue<Value, Refusal> & {
  execution: GraphWorkflowExecution;
};

export function mutationValue<Value>(
  outcome: ExecutionMutationOutcome<Value, never>,
): Value {
  if (outcome.kind === "refused")
    throw new Error("An infallible mutation returned a refusal");
  return outcome.value;
}

export function changed(
  execution: GraphWorkflowExecution,
): Extract<ExecutionMutationDecision<void>, { kind: "changed" }>;
export function changed<Value>(
  execution: GraphWorkflowExecution,
  value: Value,
  delivery?: ExecutionMutationDelivery,
): Extract<ExecutionMutationDecision<Value>, { kind: "changed" }>;
export function changed<Value>(
  execution: GraphWorkflowExecution,
  value?: Value,
  delivery?: ExecutionMutationDelivery,
): Extract<ExecutionMutationDecision<Value | undefined>, { kind: "changed" }> {
  return {
    kind: "changed",
    execution,
    value,
    ...(delivery ? { delivery } : {}),
  };
}

export function unchanged(): Extract<
  ExecutionMutationDecision<void>,
  { kind: "unchanged" }
>;
export function unchanged<Value>(
  value: Value,
): Extract<ExecutionMutationDecision<Value>, { kind: "unchanged" }>;
export function unchanged<Value>(
  value?: Value,
): Extract<
  ExecutionMutationDecision<Value | undefined>,
  { kind: "unchanged" }
> {
  return { kind: "unchanged", value };
}

export function refused<Refusal>(
  refusal: Refusal,
): Extract<ExecutionMutationDecision<never, Refusal>, { kind: "refused" }> {
  return { kind: "refused", refusal };
}

export function eventsOnly<Value>(
  value: Value,
  delivery: ExecutionMutationDelivery,
): Extract<ExecutionMutationDecision<Value>, { kind: "events_only" }> {
  if (delivery.events.length === 0 && delivery.pushes.length === 0)
    throw new Error("An events_only mutation requires nonempty delivery");
  return { kind: "events_only", value, delivery };
}

/** Storage transports the operation value without persisting it in the execution row. */
export type GraphWorkflowStorageMutation<Value> =
  | {
      kind: "commit";
      execution: GraphWorkflowExecution;
      events: GraphWorkflowEventDelivery["events"];
      pushes?: GraphWorkflowEventDelivery["pushes"];
      preResetContextIds?: readonly string[];
      value: Value;
    }
  | {
      kind: "no_commit";
      value: Value;
      execution?: never;
      events?: never;
      pushes?: never;
    };

export type GraphWorkflowStorageMutationOutcome<Value> =
  | {
      kind: "committed";
      execution: GraphWorkflowExecution;
      delivery: GraphWorkflowEventDelivery;
      value: Value;
    }
  | {
      kind: "not_committed";
      execution: GraphWorkflowExecution | null;
      value: Value;
    };
