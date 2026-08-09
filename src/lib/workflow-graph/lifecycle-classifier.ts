import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowHaltReason,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import { assertNever } from "@/lib/shared/assert-never";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "./execution-state";

/**
 * The single source of truth for graph-workflow live-edit editability (doc 06,
 * D2/D6). Pure and table-testable by design — the edit guard, the live-outline
 * projection, and the UI all consume these verdicts, so keeping the policy in
 * one pure function is what makes CLI/UI/server parity free. (The design mandates
 * purity here; the consuming edit core/route own the structured logging.)
 */

export type ContextLifecycle = "frozen" | "unstarted" | "started";

export type ExecutionEditability =
  | { kind: "editable"; quiescent: boolean }
  | {
      kind: "not-editable";
      reason: "completed" | "aborted" | "halt-not-resumable";
    };

/**
 * Resumability allowlist over every halt reason type (doc 06, D6). Written as an
 * exhaustive `Record` so adding a halt reason type to
 * `graphWorkflowHaltReasonSchema` fails to compile here until it is deliberately
 * classified — the fail-safe the design requires (a new, unclassified halt is
 * not silently treated as resumable). Only `aborted` and `recovery_error` are
 * non-resumable today.
 */
const HALT_RESUMABILITY: Record<GraphWorkflowHaltReason["type"], boolean> = {
  delivery_gate_failed: true,
  circuit_breaker: true,
  max_iterations: true,
  merge_failure: true,
  join_failure: true,
  merge_precondition_failed: true,
  script_validator_missing_command: true,
  script_validator_unknown_command: true,
  validator_infra_error: true,
  validation_candidate_unavailable: true,
  agent_turn_failed: true,
  worktree_creation_dirty: true,
  execution_loop_failed: true,
  collaboration_failure: true,
  // Both routing halts are resumable by construction (D4 R2.4/R3.1): their
  // sanctioned remedy is a quiescent live edit of the guard set on the
  // unstarted target's incoming edges, followed by resume.
  routing_cardinality: true,
  routing_invariant: true,
  // The three loop halts are resumable too (D4 R9.6/R10): a skipped or
  // unreadable exit is repaired by a quiescent live edit of the offending pass
  // instance, and an exhausted budget by an audited amendment to the pass cap
  // or the exit predicate — both followed by resume.
  loop_exit_skipped: true,
  loop_invariant: true,
  loop_limit_reached: true,
  // Drift on a shared lane is resumable by design (lightweight parallelism R8):
  // the remedy is a live edit that widens a member's ownership to cover the
  // write, or removal of the write, and then resume. Nothing about the halt is
  // terminal — the lane worktree and every member's work are intact.
  ownership_violation: true,
  aborted: false,
  recovery_error: false,
};

export function isResumableHalt(reason: GraphWorkflowHaltReason): boolean {
  return HALT_RESUMABILITY[reason.type];
}

/**
 * Classify a context's editability lifecycle (doc 06, "Editability policy"):
 * `frozen` (completed — never editable), `unstarted` (proven to sit in its
 * initial state — fully editable, structural ops still require quiescence), or
 * `started` (everything else non-completed — editable only when quiescent).
 *
 * `unstarted` is initial-state EQUIVALENCE, not status: the context must be
 * absent from `activeContextIds` and its context state plus every one of its
 * task states must deep-equal the canonical initial state recomputed from the
 * CURRENT working definition. Comparing against the builders (rather than
 * enumerating fields) means any runtime-evidence field added later tightens the
 * predicate automatically, and seed-derived fields like `totalTaskCount`
 * compare correctly after in-batch task adds.
 */
export function classifyContextLifecycle(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextLifecycle {
  return classifyContextLifecycleFromPin(
    execution,
    contextId,
    pinContextInitialState(execution, contextId),
  );
}

/**
 * The DEFINITION-derived half of the classification above: a context's canonical
 * initial state and its tasks'. Deriving it walks the whole task list, so a
 * caller that has already fenced the definition (the mutation staging seam, which
 * must re-classify inside the write queue) pins this once outside the lock and
 * re-classifies against it in O(this context's tasks) — no scan.
 *
 * `null` means the context has no definition entry.
 */
export interface ContextInitialStatePin {
  readonly contextState: GraphWorkflowExecutionContextState;
  readonly taskStates: Readonly<Record<string, GraphWorkflowTaskState>>;
}

export function pinContextInitialState(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextInitialStatePin | null {
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  if (!context) return null;

  const taskStates: Record<string, GraphWorkflowTaskState> = {};
  for (const task of execution.workingDefinition.tasks) {
    if (task.contextId === contextId) {
      taskStates[task.id] = buildInitialTaskState(task);
    }
  }
  return {
    contextState: buildInitialContextState(
      context,
      execution.workingDefinition.tasks,
    ),
    taskStates,
  };
}

/**
 * The RUNTIME half: compare the execution's current state against a pin. Same
 * verdict as {@link classifyContextLifecycle}, which is defined in terms of it —
 * there is one lifecycle policy, not two.
 */
export function classifyContextLifecycleFromPin(
  execution: GraphWorkflowExecution,
  contextId: string,
  pin: ContextInitialStatePin | null,
): ContextLifecycle {
  const contextState = execution.contextStates[contextId];

  // Completed takes precedence over every other signal.
  if (contextState?.status === "completed") {
    return "frozen";
  }

  // A context with no definition entry or no runtime state cannot be PROVEN to
  // sit in its initial state, so it is not editable as `unstarted` (fail-safe).
  if (pin === null || !contextState) {
    return "started";
  }

  const everyTaskInitial = Object.entries(pin.taskStates).every(
    ([taskId, initial]) => deepEqualJson(execution.taskStates[taskId], initial),
  );

  const isUnstarted =
    !execution.activeContextIds.includes(contextId) &&
    deepEqualJson(contextState, pin.contextState) &&
    everyTaskInitial;

  return isUnstarted ? "unstarted" : "started";
}

/**
 * The execution-level gate (doc 06, "Execution-level gate"). `quiescent` (paused
 * or resumably-halted) unlocks the full policy surface including structural ops;
 * a `running` execution is editable but only for ops whose every target is
 * `unstarted`. Terminal (`completed`/`aborted`) and non-resumably-halted
 * executions are read-only.
 */
export function classifyExecutionEditability(
  execution: GraphWorkflowExecution,
): ExecutionEditability {
  switch (execution.status) {
    case "running":
      return { kind: "editable", quiescent: false };
    case "pending":
    case "paused":
      return { kind: "editable", quiescent: true };
    case "halted":
      if (execution.haltReason && isResumableHalt(execution.haltReason)) {
        return { kind: "editable", quiescent: true };
      }
      return { kind: "not-editable", reason: "halt-not-resumable" };
    case "completed":
      return { kind: "not-editable", reason: "completed" };
    case "aborted":
      return { kind: "not-editable", reason: "aborted" };
    default:
      return assertNever(
        execution.status,
        `unhandled execution status: ${String(execution.status)}`,
      );
  }
}
