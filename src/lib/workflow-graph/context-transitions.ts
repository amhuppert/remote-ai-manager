import { buildInitialContextState } from "@/lib/workflow-graph/execution-state";
import { openLoopLanes } from "@/lib/workflow-graph/lane-lifecycle";
import type {
  GraphWorkflowContextSkipReason,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionJoinResolvedConflict,
  GraphWorkflowExecutionJoinValidationEvidence,
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
 * LANE status rides here too, for the one transition that is not a fact about
 * the lane on its own: a source lane retires to `merged` in the same write that
 * records its work against the consuming join, so the lane record and
 * `mergedSourceLaneIds` can never disagree. Lane CREATION stays with the
 * scheduler that provisions the worktree.
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
 *
 * `skipped` is reachable only from the two UNSTARTED statuses (D4 R4): a
 * context that has started holds a lane, a conversation and work on disk, none
 * of which a route verdict may discard. It is terminal for the same reason
 * `completed` is — a skip is a settled routing decision, and resurrecting a
 * skipped branch mid-execution would strand every downstream frontier that
 * already resolved against it.
 */
export const CONTEXT_STATUS_TRANSITIONS: Readonly<
  Record<GraphWorkflowContextStatus, readonly GraphWorkflowContextStatus[]>
> = {
  pending: ["ready", "running", "halted", "skipped"],
  ready: ["running", "halted", "skipped"],
  running: [
    "ready",
    "completed",
    "halted",
    "awaiting_approval",
    "awaiting_user_input",
  ],
  // `awaiting_approval -> ready` returns an ABANDONED park to the schedulable
  // set: an approval that can no longer complete its context (the context's
  // output contract changed under the park, so it owes a validated output
  // again) leaves no runner behind, and only `pending`/`ready` survive a pause
  // or a restart as work the scheduler will pick up again.
  awaiting_approval: ["ready", "running", "completed", "halted"],
  // `awaiting_user_input -> ready` is the same abandoned-park case as the
  // approval gate's: pause-to-edit withdraws the round's parked validator
  // questions, so nothing is waiting on the human any more and the context owes
  // the edited roster a fresh round. Only `pending`/`ready` survive a pause as
  // work the scheduler picks up again.
  awaiting_user_input: ["ready", "running", "halted"],
  halted: [
    "ready",
    "running",
    "completed",
    "awaiting_approval",
    "awaiting_user_input",
  ],
  completed: [],
  skipped: [],
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
  if (next !== "completed" || contextState.laneId === null) return;

  const placement = draft.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement;
  if (placement?.mode !== "readOnly") return;

  const lane = draft.executionLanes[contextState.laneId];
  if (!lane || lane.includedContextIds.includes(contextId)) return;
  lane.includedContextIds = [...lane.includedContextIds, contextId];
}

/**
 * Settle a context as `skipped` and record WHY, in one write (D4 R4).
 *
 * The status move and the reason are inseparable: a `skipped` context with no
 * recorded verdicts is a routing decision no one can reconstruct, so both land
 * in the same mutation rather than in two writers that could interleave. The
 * legality check is the transition table's — a running or completed context is
 * refused there, and the reason is only written after it accepts.
 *
 * Re-deriving a settled skip is a no-op that PRESERVES the first reason: the
 * scheduler recomputes route verdicts every pass, and the durable record must
 * describe the moment the branch was actually decided.
 */
export function skipContext(
  draft: GraphWorkflowExecution,
  contextId: string,
  reason: GraphWorkflowContextSkipReason,
  meta: ContextTransitionMeta,
): void {
  const contextState = requireContextState(draft, contextId);
  if (contextState.status === "skipped") {
    return;
  }
  transitionContextStatus(draft, contextId, "skipped", meta);
  contextState.skipReason = reason;
}

/**
 * The one sanctioned way to return an existing context to its canonical
 * initial (pending) state. Reset is deliberately absent from the legality
 * table — no runtime writer may move a context back to `pending`; only an
 * operator-initiated reset does, so it is a distinct narrowly-typed operation
 * rather than a transition mode. Its legality rule is that the terminal
 * statuses stay terminal: resetting a `completed` or `skipped` context throws
 * exactly like any reopening transition — a skip is irreversible within the
 * execution (D4 R4.2), so reset is not a back door out of it. Resetting from
 * `running` is legal here (the caller gates on a paused/halted execution,
 * where a context stuck in `running` has no live iteration).
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
  if (from === "completed" || from === "skipped") {
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
  addValidationDebtSourceLaneId?: string;
  clearValidationDebt?: boolean;
  addValidationEvidence?: GraphWorkflowExecutionJoinValidationEvidence;
  errorMessage?: string | null;
  conflicts?: GraphWorkflowExecutionJoinState["conflicts"];
  /** Append one auto-resolved conflict record (smart-merge sub-turn or clean
   * retry) — survives later patches; only a join reset clears it. */
  addResolvedConflict?: GraphWorkflowExecutionJoinResolvedConflict;
  conflictGuidance?: GraphWorkflowExecutionJoinState["conflictGuidance"];
}

/**
 * Retire a source lane whose work has just landed in a join target.
 *
 * `mergedSourceLaneIds` is the moment the lane's commits become the target's,
 * so the lane record moves in the SAME write: a durable `status` that only ever
 * said `active` cannot be told apart from a lane still holding unmerged work,
 * which is what left every read surface reporting a delivered lane as live.
 *
 * Two lanes are deliberately spared. A lane an unconcluded loop may still write
 * another pass to keeps `active` — its body swaps work through an intra-loop
 * join every pass, and the same freeze-at-intent exception governs
 * `laneClosure`. And the session lane is the run's delivery target rather than
 * a lane that gets delivered away; it stays live even when a join reads from
 * it.
 */
function mergeSourceLane(
  execution: GraphWorkflowExecution,
  laneId: string | undefined,
  now: string,
): GraphWorkflowExecution["executionLanes"] {
  if (laneId === undefined) return execution.executionLanes;
  const lane = execution.executionLanes[laneId];
  if (!lane || lane.kind === "session" || lane.status === "merged") {
    return execution.executionLanes;
  }
  if (openLoopLanes(execution).all.has(laneId)) return execution.executionLanes;
  return {
    ...execution.executionLanes,
    [laneId]: { ...lane, status: "merged", updatedAt: now },
  };
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
  const currentValidationDebt = join.validationDebtSourceLaneIds ?? [];
  const validationDebtSourceLaneIds = patch.clearValidationDebt
    ? []
    : patch.addValidationDebtSourceLaneId &&
        !currentValidationDebt.includes(patch.addValidationDebtSourceLaneId)
      ? [...currentValidationDebt, patch.addValidationDebtSourceLaneId]
      : currentValidationDebt;
  const currentValidationEvidence = join.validationEvidence ?? [];
  const evidenceToAdd = patch.addValidationEvidence;
  const validationEvidence =
    evidenceToAdd &&
    !currentValidationEvidence.some(
      (evidence) =>
        evidence.sourceLaneIds.length === evidenceToAdd.sourceLaneIds.length &&
        evidence.sourceLaneIds.every(
          (laneId, index) => laneId === evidenceToAdd.sourceLaneIds[index],
        ),
    )
      ? [...currentValidationEvidence, evidenceToAdd]
      : currentValidationEvidence;

  const status = patch.status ?? join.status;
  const completedAt =
    status === "succeeded" || status === "failed" || status === "conflicts"
      ? now
      : join.completedAt;

  return {
    ...execution,
    executionLanes: mergeSourceLane(
      execution,
      patch.addMergedSourceLaneId,
      now,
    ),
    joins: {
      ...execution.joins,
      [joinId]: {
        ...join,
        status,
        mergedSourceLaneIds,
        validationDebtSourceLaneIds,
        validationEvidence,
        errorMessage:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : join.errorMessage,
        conflicts:
          patch.conflicts !== undefined ? patch.conflicts : join.conflicts,
        ...(patch.addResolvedConflict
          ? {
              resolvedConflicts: [
                ...(join.resolvedConflicts ?? []),
                patch.addResolvedConflict,
              ],
            }
          : {}),
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
