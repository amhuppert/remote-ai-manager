/**
 * Loop-generation fencing for graph-workflow execution loops.
 *
 * An execution loop can outlive its mandate: lifecycle transitions mutate
 * persisted state while cancellation is best-effort, so a loop blocked in a
 * long await (an agent turn, a validator run) does not observe them until it
 * wakes — by which time its generation may have been retired by pause, halt,
 * abort, completion, or resume. Every
 * manager/repository API such a zombie calls is keyed by (projectPath,
 * sessionName), so without a fence it transparently reads and mutates the
 * *successor* generation's state (incident 622782a0: three loops raced one
 * session).
 *
 * The fence pins a loop instance to the (executionId, loopEpoch) pair it was
 * started with. It rides a dedicated AsyncLocalStorage so it propagates from
 * the loop into everything the loop awaits — iterations, validators,
 * committers, and the state-store write queue (whose mutation callbacks run in
 * the enqueuer's async context) — with no signature threading. The execution
 * repository asserts it inside every `mutateActive` critical section, so a
 * stale generation's writes are rejected atomically; requests that carry no
 * fence (user/agent routes) are untouched.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

export interface GraphWorkflowLoopFence {
  /** The session whose active execution this fence governs. Mutations the
   * fenced code performs against OTHER sessions (e.g. collaboration dispatch)
   * are outside the fence's claim and are not checked against it. */
  projectPath: string;
  sessionName: string;
  executionId: string;
  loopEpoch: number;
}

/** Whether the ambient fence governs the given session's execution state. */
export function loopFenceAppliesTo(
  fence: GraphWorkflowLoopFence,
  projectPath: string,
  sessionName: string,
): boolean {
  return fence.projectPath === projectPath && fence.sessionName === sessionName;
}

export class StaleLoopFenceError extends Error {
  readonly fence: GraphWorkflowLoopFence;
  readonly actualExecutionId: string | null;
  readonly actualLoopEpoch: number | null;

  constructor(
    fence: GraphWorkflowLoopFence,
    actual: Pick<GraphWorkflowExecution, "id" | "loopEpoch"> | null,
  ) {
    const observed = actual
      ? `execution "${actual.id}" at loop epoch ${actual.loopEpoch}`
      : "no active execution";
    super(
      `Stale loop generation: loop is fenced to execution "${fence.executionId}" at loop epoch ${fence.loopEpoch}, but the session's active state is ${observed}. This loop instance has been superseded and must exit without writing.`,
    );
    this.name = "StaleLoopFenceError";
    this.fence = fence;
    this.actualExecutionId = actual?.id ?? null;
    this.actualLoopEpoch = actual?.loopEpoch ?? null;
  }
}

const fenceStorage = new AsyncLocalStorage<GraphWorkflowLoopFence>();

/** Run `fn` with `fence` as the ambient loop generation. */
export function runWithLoopFence<T>(
  fence: GraphWorkflowLoopFence,
  fn: () => Promise<T>,
): Promise<T> {
  return fenceStorage.run(fence, fn);
}

/** The ambient loop fence, or null outside any fenced loop scope. */
export function getCurrentLoopFence(): GraphWorkflowLoopFence | null {
  return fenceStorage.getStore() ?? null;
}

/** Whether `execution` belongs to the generation `fence` is pinned to. */
export function matchesLoopFence(
  fence: GraphWorkflowLoopFence,
  execution: Pick<GraphWorkflowExecution, "id" | "loopEpoch"> | null,
): boolean {
  return (
    execution !== null &&
    execution.id === fence.executionId &&
    execution.loopEpoch === fence.loopEpoch
  );
}

/**
 * Whether `execution` is the fenced generation's own execution, observed after
 * a lifecycle transition retired it.
 *
 * Retiring a generation bumps `loopEpoch` atomically with the status change, so
 * the loop that owns the generation stops matching its own fence the instant an
 * operator pauses or aborts it. That loop still has to observe the terminal
 * snapshot — to report the true status instead of the pre-transition one it
 * happens to be holding, and to run its exit path. Only a *successor*
 * generation is off-limits to it, and a successor is always running: resume is
 * the sole way out of a quiescent state and it bumps the epoch again. So a
 * non-running snapshot of the same execution at a later epoch can only be this
 * loop's own retirement notice.
 *
 * Read-only: the fence still governs writes, so a retired loop that tries to
 * mutate is rejected by the repository exactly as before.
 */
export function isOwnRetiredGeneration(
  fence: GraphWorkflowLoopFence,
  execution: Pick<GraphWorkflowExecution, "id" | "loopEpoch" | "status"> | null,
): boolean {
  return (
    execution !== null &&
    execution.id === fence.executionId &&
    execution.loopEpoch > fence.loopEpoch &&
    execution.status !== "running"
  );
}

/**
 * Assert the ambient fence (if any) still matches the given session's
 * persisted execution. A no-op outside a fenced scope and for sessions the
 * fence does not govern; otherwise a mismatched or missing execution throws
 * {@link StaleLoopFenceError}.
 */
export function assertLoopFence(
  projectPath: string,
  sessionName: string,
  execution: Pick<GraphWorkflowExecution, "id" | "loopEpoch"> | null,
): void {
  const fence = getCurrentLoopFence();
  if (fence === null || !loopFenceAppliesTo(fence, projectPath, sessionName)) {
    return;
  }
  if (!matchesLoopFence(fence, execution)) {
    throw new StaleLoopFenceError(fence, execution);
  }
}
