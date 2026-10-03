import type { ControlPermits } from "@/lib/control/permits";
import type { Executor, OperationState } from "../executor";
import type { PendingIntent } from "../schemas";

interface Operation {
  intent: PendingIntent;
  state: OperationState;
}

/**
 * An executor double for supervisor tests. It records submissions by cause the
 * way real executors do, and admits an operation only when its permit admits.
 */
export interface FakeExecutor extends Executor {
  submitted(): PendingIntent[];
  operation(cause: string): Operation | undefined;
  /** Admits a queued operation; returns false when its permit refuses. */
  admit(cause: string): boolean;
  settle(cause: string, outcome: unknown): void;
  settleUncertain(cause: string, evidence: string): void;
  readonly withdrawn: string[];
  readonly interrupted: string[];
}

export function createFakeExecutor(permits: ControlPermits): FakeExecutor {
  const operations = new Map<string, Operation>();
  const withdrawn: string[] = [];
  const interrupted: string[] = [];
  const require = (cause: string): Operation => {
    const op = operations.get(cause);
    if (op === undefined) throw new Error(`No operation for ${cause}`);
    return op;
  };
  return {
    withdrawn,
    interrupted,
    submitted: () => [...operations.values()].map((op) => op.intent),
    operation: (cause) => operations.get(cause),
    submit(intent) {
      const existing = operations.get(intent.cause);
      if (existing !== undefined) {
        if (existing.state.kind === "queued") existing.intent = intent;
        return;
      }
      operations.set(intent.cause, { intent, state: { kind: "queued" } });
    },
    outcome: (cause) => operations.get(cause)?.state ?? { kind: "unknown" },
    withdraw(cause) {
      const op = operations.get(cause);
      if (op !== undefined && op.state.kind === "queued") {
        operations.delete(cause);
        withdrawn.push(cause);
      }
    },
    interrupt(cause) {
      interrupted.push(cause);
    },
    admit(cause) {
      const op = require(cause);
      if (op.state.kind !== "queued" || !permits.admits(op.intent.permit))
        return false;
      op.state = { kind: "running" };
      return true;
    },
    settle(cause, outcome) {
      require(cause).state = { kind: "settled", outcome };
    },
    settleUncertain(cause, evidence) {
      require(cause).state = { kind: "uncertain", evidence };
    },
  };
}
