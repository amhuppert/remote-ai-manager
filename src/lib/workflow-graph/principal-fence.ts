/**
 * Execution-turnover fencing for graph-workflow mutation routes (D7 R9).
 *
 * {@link ./mutation-guard} authorizes a principal against the execution it
 * READ; every lifecycle verb then writes through a session-keyed API — "pause
 * the session's active run", not "pause execution E1". Those name the same run
 * almost always, and a different one exactly when it matters: if E1 settles and
 * successor E2 takes the lease in the gap, the authorization that named E1's
 * origin (or E1's lane) is spent on E2, and an agent with no business on E2
 * mutates it. Lane rotation and origin deletion ride the same gap.
 *
 * The fence closes it the way the loop fence closes its own: it rides an
 * AsyncLocalStorage, so it propagates from the route into everything the act
 * awaits — including the state-store write queue, whose reducers run in the
 * enqueuer's async context — with no signature threading through the manager.
 * The execution repository asserts it inside every `mutateActive` critical
 * section against the row it is about to write, so a turnover is rejected
 * atomically and write-free. Acts that carry no fence are untouched: the human
 * UI, whose authority is session-wide by contract, and every internal writer.
 *
 * WHAT IT PINS is execution identity for every write and lane freshness at the
 * first serialized mutation frontier. The first check closes the gap where a
 * lane is current at route admission but is replaced before any reducer runs.
 * Later writes in the same act retain that admission: pause itself retires the
 * running task that resolves the binding, so re-checking after the act's own
 * first write would reject its cleanup. Session membership remains a read-time
 * question because the reducer is synchronous and performs no I/O.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowRequestPrincipal } from "./request-principal";
import { resolveBoundConversationId } from "./lane-binding";

export interface GraphWorkflowPrincipalFence {
  /**
   * The session whose active execution this fence governs. A fenced act may
   * legitimately write to another session (collaboration dispatch does); those
   * writes are outside the fence's claim.
   */
  projectPath: string;
  sessionName: string;
  /** The execution the mutation guard authorized this principal against. */
  executionId: string;
  /** The immutable origin named in a stale-lane refusal. */
  originConversationId: string | null;
  /** The verified principal whose execution and lane binding are pinned. */
  principal: WorkflowRequestPrincipal;
}

export class ExecutionTurnoverError extends Error {
  readonly fence: GraphWorkflowPrincipalFence;
  readonly actualExecutionId: string | null;

  constructor(
    fence: GraphWorkflowPrincipalFence,
    actual: Pick<GraphWorkflowExecution, "id"> | null,
  ) {
    super(
      `Execution turnover: this act was authorized against execution "${fence.executionId}", but the session's active state is ${
        actual ? `execution "${actual.id}"` : "no active execution"
      }. The authorization does not carry to a different run, so nothing was written.`,
    );
    this.name = "ExecutionTurnoverError";
    this.fence = fence;
    this.actualExecutionId = actual?.id ?? null;
  }
}

export class LaneBindingTurnoverError extends Error {
  readonly fence: GraphWorkflowPrincipalFence;
  readonly actualConversationId: string | null;

  constructor(
    fence: GraphWorkflowPrincipalFence,
    actualConversationId: string | null,
  ) {
    const principal = fence.principal;
    if (principal.kind !== "lane") {
      throw new Error("Lane binding turnover requires a lane principal");
    }
    super(
      `Lane turnover: conversation "${principal.conversationId}" was authorized for context "${principal.contextId}", but that context is now driven by ${
        actualConversationId === null
          ? "no conversation"
          : `conversation "${actualConversationId}"`
      }. Nothing was written.`,
    );
    this.name = "LaneBindingTurnoverError";
    this.fence = fence;
    this.actualConversationId = actualConversationId;
  }
}

interface PrincipalFenceState {
  fence: GraphWorkflowPrincipalFence;
  laneBindingValidated: boolean;
}

const fenceStorage = new AsyncLocalStorage<PrincipalFenceState>();

/** Run `fn` with `fence` pinning which execution its writes may touch. */
export function runWithExecutionPrincipalFence<T>(
  fence: GraphWorkflowPrincipalFence,
  fn: () => Promise<T>,
): Promise<T> {
  return fenceStorage.run({ fence, laneBindingValidated: false }, fn);
}

/** The ambient principal fence, or null outside any fenced act. */
export function getCurrentExecutionPrincipalFence(): GraphWorkflowPrincipalFence | null {
  return fenceStorage.getStore()?.fence ?? null;
}

/**
 * Assert the ambient fence (if any) still names the given session's persisted
 * execution. A no-op outside a fenced act and for sessions the fence does not
 * govern; otherwise a successor — or an emptied slot — throws
 * {@link ExecutionTurnoverError}.
 *
 * Purely computational: it performs NO logging, because it runs inside the
 * write-queue critical section (`no-slow-work-in-critical-section`). The error
 * carries what the structured log needs, written by the caller post-abort.
 */
export function assertExecutionPrincipalFence(
  projectPath: string,
  sessionName: string,
  execution: GraphWorkflowExecution | null,
): void {
  const state = fenceStorage.getStore();
  const fence = state?.fence ?? null;
  if (
    fence === null ||
    fence.projectPath !== projectPath ||
    fence.sessionName !== sessionName
  ) {
    return;
  }
  if (execution === null || execution.id !== fence.executionId) {
    throw new ExecutionTurnoverError(fence, execution);
  }
  if (
    fence.principal.kind !== "lane" ||
    state === undefined ||
    state.laneBindingValidated
  ) {
    return;
  }

  const actualConversationId = resolveBoundConversationId(
    execution,
    fence.principal.contextId,
  );
  if (actualConversationId !== fence.principal.conversationId) {
    throw new LaneBindingTurnoverError(fence, actualConversationId);
  }
  state.laneBindingValidated = true;
}
