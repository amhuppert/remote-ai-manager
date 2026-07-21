import { buildInitialContextState } from "@/lib/workflow-graph/execution-state";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowStatus,
} from "@/lib/workflow-graph/definition-schemas";

/**
 * Single transition owner for graph-workflow CONTEXT-level lifecycle state:
 * context status (with a legality table), context merge status, join status,
 * and the persisted lifecycle snapshot (`machineSnapshot`). Every writer in
 * the graph engine routes through this module — the grep assertion in
 * context-transitions.test.ts enforces that no direct write exists elsewhere.
 *
 * EXECUTION-level status stays hand-rolled in workflow-manager by design
 * (decision D4: the post-RCA design is already single-owner and carries
 * persistence-layer fencing).
 *
 * PURITY (Design 3.1/3.3, `no-slow-work-in-critical-section`): every function
 * here runs INSIDE a `mutateActive` reducer, i.e. inside the global write-queue
 * critical section. They must therefore be pure — no logging (logging is
 * `appendFileSync` I/O). An illegal transition still throws
 * {@link IllegalContextStatusTransitionError}, which carries the full
 * `{ contextId, from, to, reason }`; the mutation seam's owner logs it AFTER
 * the aborted mutation unwinds, outside the lock (see `mutateActive`'s catch in
 * execution-repository.ts), exactly as it reconstructs the stale-loop-fence warn.
 */

export type GraphWorkflowRecoveryMode =
  | "none"
  | "rehydrated"
  | "interrupted_task"
  | "restart_normalized"
  | "restart_drain_resumed";

export interface GraphWorkflowLifecycleSnapshot {
  schemaVersion: 1;
  lifecycleStatus: GraphWorkflowStatus;
  activeContextId: string | null;
  recoveryMode: GraphWorkflowRecoveryMode;
  hasLiveIteration: boolean;
}

/**
 * Legality table for context-status transitions. Derived from every writer in
 * the graph engine; identity transitions are always legal no-ops.
 *
 * `pending -> running` exists because an iteration seed may activate a
 * pending context directly (task-run flows bypass the scheduler's
 * pending -> ready pass). `halted` is deliberately permissive: a context-level
 * halt is recorded immediately by signal-halt while the live iteration keeps
 * finalizing (the execution-level drain settles the race), so in-flight
 * mutations may legally write over a just-halted context. `completed` is
 * terminal — reopening a completed context is exactly the zombie-loop
 * corruption this table exists to reject.
 */
export const CONTEXT_STATUS_TRANSITIONS: Readonly<
  Record<GraphWorkflowContextStatus, readonly GraphWorkflowContextStatus[]>
> = {
  pending: ["ready", "running", "halted"],
  ready: ["running", "halted"],
  running: [
    "ready",
    "completed",
    "halted",
    "awaiting_approval",
    "awaiting_user_input",
  ],
  awaiting_approval: ["running", "completed", "halted"],
  awaiting_user_input: ["running", "halted"],
  halted: [
    "ready",
    "running",
    "completed",
    "awaiting_approval",
    "awaiting_user_input",
  ],
  completed: [],
};

export function isLegalContextStatusTransition(
  from: GraphWorkflowContextStatus,
  to: GraphWorkflowContextStatus,
): boolean {
  return from === to || CONTEXT_STATUS_TRANSITIONS[from].includes(to);
}

export class IllegalContextStatusTransitionError extends Error {
  constructor(
    readonly contextId: string,
    readonly from: GraphWorkflowContextStatus,
    readonly to: GraphWorkflowContextStatus,
    readonly reason: string,
  ) {
    super(
      `Illegal context status transition "${from}" -> "${to}" for context "${contextId}" (${reason})`,
    );
    this.name = "IllegalContextStatusTransitionError";
  }
}

export interface ContextTransitionMeta {
  /** Writer-site label recorded with the transition (e.g. "approval_gate.park"). */
  reason: string;
}

function requireContextState(
  draft: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecutionContextState {
  const contextState = draft.contextStates[contextId];
  if (!contextState) {
    throw new Error(
      `Execution context "${contextId}" does not exist in runtime state`,
    );
  }
  return contextState;
}

/**
 * Apply a context-status transition on a mutable execution draft. Identity
 * transitions are no-ops; illegal transitions throw (aborting the enclosing
 * repository mutation) so the draft is never persisted in an illegal shape.
 */
export function transitionContextStatus(
  draft: GraphWorkflowExecution,
  contextId: string,
  next: GraphWorkflowContextStatus,
  meta: ContextTransitionMeta,
): void {
  const contextState = requireContextState(draft, contextId);
  const from = contextState.status;
  if (from === next) {
    return;
  }
  if (!isLegalContextStatusTransition(from, next)) {
    // No logging here — this runs inside the write-queue critical section. The
    // error carries from/to/contextId/reason; the seam owner logs it post-abort.
    throw new IllegalContextStatusTransitionError(
      contextId,
      from,
      next,
      meta.reason,
    );
  }
  contextState.status = next;
}

/**
 * The one sanctioned way to return an existing context to its canonical
 * initial (pending) state. Reset is deliberately absent from the legality
 * table — no runtime writer may move a context back to `pending`; only an
 * operator-initiated reset does, so it is a distinct narrowly-typed operation
 * rather than a transition mode. Its sole legality rule is that `completed`
 * stays terminal: resetting a completed context throws exactly like any
 * reopening transition. Resetting from `running` is legal here (the caller
 * gates on a paused/halted execution, where a context stuck in `running` has
 * no live iteration).
 *
 * Returns a new contextStates record with the target entry rebuilt from the
 * working definition; the caller spreads it into its next execution snapshot.
 */
export function resetContextStateToInitial(
  execution: GraphWorkflowExecution,
  contextId: string,
  meta: ContextTransitionMeta,
): Record<string, GraphWorkflowExecutionContextState> {
  const contextState = requireContextState(execution, contextId);
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(
      `Execution context "${contextId}" not found in the working definition`,
    );
  }
  const from = contextState.status;
  if (from === "completed") {
    // Pure critical-section code (see module header): throw with full data, let
    // the seam owner log the illegal reset outside the lock.
    throw new IllegalContextStatusTransitionError(
      contextId,
      from,
      "pending",
      meta.reason,
    );
  }
  return {
    ...execution.contextStates,
    [contextId]: buildInitialContextState(
      context,
      execution.workingDefinition.tasks,
    ),
  };
}

export type GraphWorkflowContextMergeStatus =
  GraphWorkflowExecutionContextState["mergeStatus"];

/**
 * Single owner for context `mergeStatus` writes. No legality table (yet) —
 * merge status is reconciled against git ground truth by the merge runner, so
 * ownership is the contract here, not transition rejection. `_meta` (the
 * writer-site reason) is retained for call-site documentation and API symmetry
 * with {@link transitionContextStatus}, but is not consumed: this runs inside a
 * write-queue reducer and so must stay pure (`no-slow-work-in-critical-section`).
 */
export function transitionContextMergeStatus(
  draft: GraphWorkflowExecution,
  contextId: string,
  next: GraphWorkflowContextMergeStatus,
  _meta: ContextTransitionMeta,
): void {
  const contextState = requireContextState(draft, contextId);
  const from = contextState.mergeStatus;
  if (from === next) {
    return;
  }
  contextState.mergeStatus = next;
}

/**
 * The one builder for the persisted lifecycle snapshot (`machineSnapshot`).
 * `lifecycleStatus` defaults to the draft's current execution status and
 * `recoveryMode` to "none"; recovery paths override both explicitly.
 */
export function buildLifecycleSnapshot(
  execution: GraphWorkflowExecution,
  opts: {
    hasLiveIteration: boolean;
    lifecycleStatus?: GraphWorkflowStatus;
    recoveryMode?: GraphWorkflowRecoveryMode;
  },
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus: opts.lifecycleStatus ?? execution.status,
    activeContextId: execution.activeContextIds[0] ?? null,
    recoveryMode: opts.recoveryMode ?? "none",
    hasLiveIteration: opts.hasLiveIteration,
  };
}

export interface ApplyJoinProgressPatch {
  status?: GraphWorkflowExecutionJoinState["status"];
  addMergedSourceLaneId?: string;
  errorMessage?: string | null;
  conflicts?: GraphWorkflowExecutionJoinState["conflicts"];
  conflictGuidance?: GraphWorkflowExecutionJoinState["conflictGuidance"];
}

export function applyJoinProgress(
  execution: GraphWorkflowExecution,
  joinId: string,
  now: string,
  patch: ApplyJoinProgressPatch,
): GraphWorkflowExecution {
  const join = execution.joins[joinId];
  if (!join) {
    throw new Error(
      `applyJoinProgress: join ${JSON.stringify(joinId)} not found`,
    );
  }
  const mergedSourceLaneIds =
    patch.addMergedSourceLaneId &&
    !join.mergedSourceLaneIds.includes(patch.addMergedSourceLaneId)
      ? [...join.mergedSourceLaneIds, patch.addMergedSourceLaneId]
      : join.mergedSourceLaneIds;

  const status = patch.status ?? join.status;
  const completedAt =
    status === "succeeded" || status === "failed" || status === "conflicts"
      ? now
      : join.completedAt;

  return {
    ...execution,
    joins: {
      ...execution.joins,
      [joinId]: {
        ...join,
        status,
        mergedSourceLaneIds,
        errorMessage:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : join.errorMessage,
        conflicts:
          patch.conflicts !== undefined ? patch.conflicts : join.conflicts,
        conflictGuidance:
          patch.conflictGuidance !== undefined
            ? patch.conflictGuidance
            : join.conflictGuidance,
        updatedAt: now,
        completedAt,
      },
    },
  };
}

/**
 * Reset a failed/conflicts join back to `pending` so the loop re-runs it,
 * preserving per-lane merge progress (`mergedSourceLaneIds`). Optional
 * operator guidance is attached for the next conflict-resolution attempt.
 * Joins in any other status are returned unchanged — resume treats the reset
 * as a manual retry decision that only applies to concluded failures.
 */
export function resetJoinForRetry(
  execution: GraphWorkflowExecution,
  joinId: string,
  now: string,
  conflictGuidance?: GraphWorkflowExecutionJoinState["conflictGuidance"],
): GraphWorkflowExecution {
  const join = execution.joins[joinId];
  if (!join) {
    throw new Error(
      `resetJoinForRetry: join ${JSON.stringify(joinId)} not found`,
    );
  }
  if (join.status !== "failed" && join.status !== "conflicts") {
    return execution;
  }
  return {
    ...execution,
    joins: {
      ...execution.joins,
      [joinId]: {
        ...join,
        status: "pending",
        errorMessage: null,
        conflicts: null,
        conflictGuidance:
          conflictGuidance !== undefined
            ? conflictGuidance
            : join.conflictGuidance,
        updatedAt: now,
        completedAt: null,
      },
    },
  };
}

/**
 * Normalize `running` joins back to `pending` on a mutable draft so the loop
 * re-runs them after a restart/halt drain (the merge runner reconciles per
 * lane, so a replay is safe). Returns the ids of the joins that were reset.
 */
export function resetRunningJoinsToPending(
  draft: GraphWorkflowExecution,
  timestamp: string,
): string[] {
  const resetIds: string[] = [];
  for (const join of Object.values(draft.joins)) {
    if (join.status !== "running") continue;
    join.status = "pending";
    join.updatedAt = timestamp;
    resetIds.push(join.joinId);
  }
  return resetIds;
}
