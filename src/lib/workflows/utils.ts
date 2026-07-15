/**
 * Shared utilities for XState workflow machines.
 *
 * Provides common helpers to reduce duplication across workflow machines:
 * - extractErrorMessage: Uniform error → string extraction
 * - errorAssign: Standard onError assign action (error + completedAt)
 * - createTerminalStates: Generate final states that record finalStatus
 */

import { assign } from "xstate";

/**
 * Extract a human-readable error message from an unknown thrown value.
 *
 * Handles:
 * - Error objects (uses .message)
 * - Error objects with .gitOutput (appends git output)
 * - Non-Error values (converts via String())
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const errObj = error as Error & { gitOutput?: string };
    const parts: string[] = [errObj.message];
    if (errObj.gitOutput) parts.push(errObj.gitOutput);
    return parts.join("\n");
  }
  return String(error);
}

/**
 * Whether a thrown value carries the `timedOut` marker set by pre-merge
 * validation when its script was killed by the timeout (as opposed to failing
 * on a real check). Lets the merge machine distinguish an unfixable
 * environment/scope limit from a fixable validation failure.
 */
export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "timedOut" in error &&
    (error as { timedOut?: unknown }).timedOut === true
  );
}

/**
 * Build the halt message for a pre-merge validation timeout, appending the
 * actionable guidance to the underlying error. A timeout is not something the
 * validation-fix agent can resolve, so the message tells the operator the
 * concrete next step instead.
 */
export function timeoutHaltMessage(error: unknown): string {
  return (
    `${extractErrorMessage(error)}\n\n` +
    "Skipped the validation-fix agent: a pre-merge validation timeout is an " +
    "environment/scope limit, not a fixable code error. Increase " +
    "preMergeTimeoutMs in CommandCenter.json (or narrow the changed-file test " +
    "scope) and retry the merge."
  );
}

/**
 * Create a standard XState assign action for onError handlers.
 *
 * Sets `error` (via extractErrorMessage) and `completedAt` (current timestamp).
 * Designed for use in `onError` blocks where `event.error` is available.
 *
 * The return type uses a broad cast because XState's type system requires
 * actions to match the specific machine's context/event types. Since this
 * utility works across any machine with `error` and `completedAt` context
 * fields, we cast to allow cross-machine usage. Runtime behavior is correct
 * and verified by tests.
 *
 * Usage:
 *   onError: {
 *     target: "failed",
 *     actions: errorAssign(),
 *   }
 */
export function errorAssign() {
  return assign({
    error: ({ event }: { event: { error: unknown } }) =>
      extractErrorMessage(event.error),
    completedAt: () => new Date().toISOString(),
  }) as never;
}

/**
 * Generate standard terminal (final) states for a workflow machine.
 *
 * Each terminal state:
 * - Has `type: "final"`
 * - Sets `finalStatus` to its own name via assign
 *
 * Usage:
 *   const terminals = createTerminalStates(["completed", "failed", "conflicts"] as const);
 *   // Use in machine config:
 *   states: {
 *     working: { ... },
 *     ...terminals,
 *   }
 *
 * Requires the machine to have `finalStatus` in context (initially null).
 *
 * The return type uses a broad cast for the same reason as errorAssign():
 * XState's strict type system requires exact context/event type matches,
 * but these utilities work across any workflow machine.
 */
export function createTerminalStates<T extends readonly string[]>(
  statuses: T,
): Record<T[number], never> {
  const result = {} as Record<string, unknown>;
  for (const status of statuses) {
    result[status] = {
      type: "final" as const,
      entry: assign({ finalStatus: status as string }),
    };
  }
  return result as Record<T[number], never>;
}
