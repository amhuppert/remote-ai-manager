import type { PendingIntent } from "./schemas";

/**
 * The authoritative state of the operation an executor recorded under a cause.
 * `running` may carry progress a requester observes without consuming it.
 */
export type OperationState<Progress = unknown> =
  | { kind: "unknown" }
  | { kind: "queued" }
  | { kind: "running"; progress?: Progress }
  | { kind: "settled"; outcome: unknown }
  | { kind: "uncertain"; evidence: string };

/** Implemented by every domain that executes another domain's requests. */
export interface Executor<Progress = unknown> {
  /**
   * Idempotent by cause: records the operation and returns without waiting for
   * its effect. Refreshes the permit of an operation that was not admitted.
   */
  submit(intent: PendingIntent): void | Promise<void>;
  outcome(cause: string): OperationState<Progress>;
  /** Withdraws an operation that has not been admitted; admitted ones drain. */
  withdraw(cause: string): void | Promise<void>;
  /** Requests interruption of an admitted operation, for cancellation. */
  interrupt?(cause: string): void | Promise<void>;
}
