import type {
  GraphWorkflowAbandonment,
  GraphWorkflowDefinitionApproval,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowHaltReason,
  GraphWorkflowLeaseIncumbent,
  GraphWorkflowLeaseRemedy,
  GraphWorkflowLifecycleDecision,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowAbandonmentSchema,
  graphWorkflowHaltReasonSchema,
} from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowStatusSchema,
  type GraphWorkflowStatus,
} from "@/lib/workflow-graph/definition-schemas";
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

/**
 * THE lifecycle contract (design §10): terminality for every execution status,
 * decided here and nowhere else. Before this table the rule was restated per
 * call site and had already diverged — the start guard treated `halted` as
 * freely replaceable while the validation resolver failed closed on it — so
 * any consumer keeping a local copy is the defect this module exists to
 * prevent.
 *
 * What the table deliberately does NOT decide is tenure. `terminal` says the
 * run has ENDED; whether it still holds the session's one lease depends on the
 * halt reason and the abandonment record, which no status column can see —
 * that is `holdsExecutionLease`. D7 removed the status-only slot-ownership,
 * replacement, and archive-eligibility columns that approximated it: each was
 * a status set standing in for tenure, and the lease answers all three.
 */
const LIFECYCLE_CONTRACT: Record<
  GraphWorkflowStatus,
  GraphWorkflowLifecycleDecision
> = {
  pending: {
    status: "pending",
    terminal: false,
  },
  running: {
    status: "running",
    terminal: false,
  },
  paused: {
    status: "paused",
    terminal: false,
  },
  halted: {
    status: "halted",
    terminal: true,
  },
  completed: {
    status: "completed",
    terminal: true,
  },
  aborted: {
    status: "aborted",
    terminal: true,
  },
};

/** The whole contract row for a status. */
export function graphWorkflowLifecycleDecision(
  status: GraphWorkflowStatus,
): GraphWorkflowLifecycleDecision {
  return LIFECYCLE_CONTRACT[status];
}

/** Whether the run has ended. Says nothing about the lease. */
export function isTerminalStatus(status: GraphWorkflowStatus): boolean {
  return LIFECYCLE_CONTRACT[status].terminal;
}

export type ContextLifecycle = "frozen" | "unstarted" | "started";

export function isLiveTaskLocked(
  execution: GraphWorkflowExecution,
  taskId: string,
): boolean {
  const status = execution.taskStates[taskId]?.status;
  return status === "completed" || status === "running";
}

export type ExecutionEditability =
  | { kind: "editable"; quiescent: boolean }
  | {
      kind: "not-editable";
      reason:
        | "completed"
        | "aborted"
        | "halt-not-resumable"
        | "awaiting-definition-approval";
    };

/**
 * Whether the run is parked awaiting a human definition decision — the one
 * state approve and reject act on (D7 decision D17).
 *
 * Owned here because it decides two things at once: which act the lease remedy
 * names, and whether the snapshot is editable. Approve and reject address the
 * EXECUTION alone, which is sound only while the bytes under review cannot
 * change between the read and the decision, so the park has to freeze the
 * snapshot — and a predicate restated per call site would let one surface
 * freeze while another kept editing.
 */
export function awaitsDefinitionApproval(
  status: GraphWorkflowStatus,
  definitionApproval: GraphWorkflowDefinitionApproval | null,
): boolean {
  return (
    status === "pending" &&
    definitionApproval !== null &&
    definitionApproval.approvedAt === null
  );
}

export type GraphWorkflowSessionDeliveryDecision =
  | { allowed: true }
  | {
      allowed: false;
      executionId: string;
      status: GraphWorkflowExecution["status"];
      remedy: GraphWorkflowLeaseRemedy;
      message: string;
    };

/**
 * The operator-facing half of each canonical remedy, phrased for delivery. The
 * remedy token is the decision; this is only its sentence, so the two surfaces
 * that refuse a merge cannot word one blocker two ways.
 */
const DELIVERY_REMEDY_SENTENCE: Record<GraphWorkflowLeaseRemedy, string> = {
  approve_or_abort: "Approve or abort it before merging this session.",
  inspect_or_pause: "Complete or abort it before merging this session.",
  resume_or_abandon: "Resume or abandon it before merging this session.",
};

/**
 * The delivery gate asks the ONE lease question, not a status question. A
 * status-only gate blocked every `halted` execution, so a non-resumable or
 * abandoned halt — a run that can never continue — refused the merge forever
 * with no act available to clear it. Tenure is what makes work "still in
 * flight", and tenure is `holdsExecutionLease`.
 *
 * The refusal carries the SAME remedy a launch refusal would (decision D6).
 * Derived rather than fixed because the one sentence this used to print —
 * complete or abort — names acts a halted run does not admit, while abandoning
 * it is precisely what admits the merge (R13.1).
 */
export function evaluateGraphWorkflowSessionDelivery(
  execution: Pick<
    GraphWorkflowExecution,
    "id" | "status" | "haltReason" | "abandonment" | "definitionApproval"
  > | null,
): GraphWorkflowSessionDeliveryDecision {
  if (execution === null) return { allowed: true };

  if (
    !holdsExecutionLease(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    )
  ) {
    return { allowed: true };
  }

  const remedy = leaseRemedyFor(execution);
  return {
    allowed: false,
    executionId: execution.id,
    status: execution.status,
    remedy,
    message: `Graph workflow execution ${execution.id} is ${execution.status}. ${DELIVERY_REMEDY_SENTENCE[remedy]}`,
  };
}

/**
 * Resumability allowlist over every halt reason type (doc 06, D6). Written as an
 * exhaustive `Record` so adding a halt reason type to
 * `graphWorkflowHaltReasonSchema` fails to compile here until it is deliberately
 * classified — the fail-safe the design requires (a new, unclassified halt is
 * not silently treated as resumable). Only `aborted` and `recovery_error` are
 * non-resumable today.
 */
const HALT_RESUMABILITY: Record<GraphWorkflowHaltReason["type"], boolean> = {
  infrastructure_blocked: true,
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
  // A refused CONTRACT is resumable for the same reason it reopens nothing: the
  // reviewed work is intact and the remedy is a repair of the plan the defect
  // names — plan repair's edit, or an operator's — followed by resume.
  plan_defect: true,
  // A candidate that would not hold still is resumable on the same terms as
  // `ownership_violation`: nothing about the reviewed work is terminal, the
  // remedy lives outside it (the lane, the worktree, or the placement that
  // keeps moving the tree), and resume starts the budget fresh.
  candidate_unstable: true,
  aborted: false,
  recovery_error: false,
};

export function isResumableHalt(reason: GraphWorkflowHaltReason): boolean {
  return HALT_RESUMABILITY[reason.type];
}

/**
 * THE lease predicate (D7 decision D14): whether this run still owns the
 * session's one execution slot. Admission, resume, the Current/History split,
 * ambient signals, validation caller-ownership, the delivery gate, and the
 * `lease_held` persistence projection all consume this one decision, so a
 * consumer keeping a local status set is the defect this replaces — a set
 * cannot see halt resumability or abandonment, the two facts that decide a
 * halted run's tenure.
 *
 * The status-only slot-ownership rule this supersedes reported every `halted`
 * run as slot-owning, because a status is all it had.
 */
export function holdsExecutionLease(
  status: GraphWorkflowStatus,
  haltReason: GraphWorkflowHaltReason | null,
  abandonment: GraphWorkflowAbandonment | null,
): boolean {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return true;
    case "halted":
      // Abandon is the explicit, audited end of a resumable halt's tenure; the
      // status stays `halted` because the engine state is a fact, so the record
      // is what releases the lease.
      if (abandonment !== null) return false;
      // Held IFF the reason is a resumable one. A run halted with NO recorded
      // reason is therefore lease-free: `isResumableHalt` is a claim about a
      // reason, and there is none to resume from. `classifyExecutionEditability`
      // and `workflowExecutionAmendmentRefusalInstruction` already draw the line
      // here, so the alternative — holding the lease for an unproven halt —
      // produced a run that was Current and launch-blocking yet neither
      // editable, resumable, nor amendable.
      return haltReason !== null && isResumableHalt(haltReason);
    case "completed":
    case "aborted":
      return false;
    default:
      return assertNever(
        status,
        `unhandled execution status: ${String(status)}`,
      );
  }
}

/**
 * The lease predicate over a RAW stored record — a row read straight out of
 * SQLite, or a legacy-shaped blob mid-upgrade, before anything has validated it
 * as a {@link GraphWorkflowExecution}.
 *
 * Two callers need tenure before a record is parseable: the schema backfill that
 * projects `lease_held` onto existing rows, and the legacy upgrade deciding
 * whether a stored status may be reinterpreted. Both must reach the same verdict
 * as every parsed consumer, so the decoding lives here rather than being
 * restated at each site.
 *
 * Every unreadable input resolves to lease-HELD: a wrongly-held lease refuses a
 * launch and is recoverable by abandoning the run, while a wrongly-free one
 * admits a second Current run for the session.
 */
export function rawRecordHoldsExecutionLease(record: {
  status?: unknown;
  haltReason?: unknown;
  abandonment?: unknown;
}): boolean {
  const status = graphWorkflowStatusSchema.safeParse(record.status);
  if (!status.success) return true;
  const haltReason = graphWorkflowHaltReasonSchema
    .nullable()
    .safeParse(record.haltReason ?? null);
  const abandonment = graphWorkflowAbandonmentSchema
    .nullable()
    .safeParse(record.abandonment ?? null);
  if (!haltReason.success || !abandonment.success) return true;
  return holdsExecutionLease(status.data, haltReason.data, abandonment.data);
}

/**
 * Whether an interaction parked on a context — an approval gate, a user-input
 * question — can still be acted on.
 *
 * TWO facts, because two different things make a park dead. Tenure is the
 * first: a run that can never continue will never apply the answer, so a
 * non-resumably halted or abandoned gate is asking for a decision that changes
 * nothing. Having started is the second: a `pending` run holds the lease but is
 * still waiting for its own definition approval, so no context of it is
 * running and any park on one is a fixture, not a fact.
 *
 * One authority for both, because the five consumers — the Needs-Input feed,
 * the two browser standing hooks, the decision recorder, and the chat-open
 * guard — must agree. They previously kept five private status sets with
 * "keep in sync" comments, and they duly drifted: the browser rendered gates
 * the feed had dropped.
 */
export function holdsActionableGate(
  status: GraphWorkflowStatus,
  haltReason: GraphWorkflowHaltReason | null,
  abandonment: GraphWorkflowAbandonment | null,
): boolean {
  if (status === "pending") return false;
  return holdsExecutionLease(status, haltReason, abandonment);
}

/**
 * The incumbent an admission decision reads. A `Pick` rather than a whole
 * execution so the decision is provably a function of the lease-relevant
 * record — and so the serialized reservation can evaluate it against the row
 * it just read without inflating anything else.
 */
export type LeaseAdmissionIncumbent = Pick<
  GraphWorkflowExecution,
  | "id"
  | "status"
  | "haltReason"
  | "abandonment"
  | "origin"
  | "ownerConversationId"
  | "definitionApproval"
>;

/**
 * The three — and only three — outcomes of a launch meeting an incumbent
 * (R3.4). `admit-with-normalization` relocates an already-lease-free record
 * into History, where it stays fully reviewable; nothing here ever ends,
 * hides, or rewrites a run that still holds the lease.
 */
export type LeaseAdmissionDecision =
  | { kind: "admit" }
  | { kind: "admit-with-normalization"; incumbent: GraphWorkflowLeaseIncumbent }
  | {
      kind: "refuse";
      incumbent: GraphWorkflowLeaseIncumbent;
      remedy: GraphWorkflowLeaseRemedy;
    };

function describeLeaseIncumbent(
  incumbent: LeaseAdmissionIncumbent,
): GraphWorkflowLeaseIncumbent {
  return {
    executionId: incumbent.id,
    status: incumbent.status,
    origin: incumbent.origin,
    originConversationId: incumbent.ownerConversationId,
  };
}

/**
 * What the refused caller should do about the run that holds the lease
 * (D7 decision D6). Derived from the same record the refusal read, so the
 * remedy can never name an act the blocker's state does not admit.
 *
 * Shared by BOTH refusals — the launch admission and the delivery gate — because
 * they ask one question ("what releases this lease?"). A second copy is how the
 * merge refusal came to tell an operator to complete a run that had halted.
 */
function leaseRemedyFor(
  holder: Pick<GraphWorkflowExecution, "status" | "definitionApproval">,
): GraphWorkflowLeaseRemedy {
  if (awaitsDefinitionApproval(holder.status, holder.definitionApproval)) {
    return "approve_or_abort";
  }
  if (holder.status === "halted") return "resume_or_abandon";
  return "inspect_or_pause";
}

/**
 * THE launch admission decision (D7 decision D3), consumed by both start-guard
 * call sites: the manager's advisory pre-check and the repository's
 * authoritative reservation inside the serialized CAS. One decision function
 * for both is what keeps the single-winner race mechanical — the advisory
 * check can only ever agree with, or be corrected by, the same rule.
 *
 * Pure: it decides, and the caller performs. Normalization is a decision here
 * and a post-commit act there.
 */
export function evaluateLeaseAdmission(
  incumbent: LeaseAdmissionIncumbent | null,
): LeaseAdmissionDecision {
  if (incumbent === null) return { kind: "admit" };

  if (
    holdsExecutionLease(
      incumbent.status,
      incumbent.haltReason,
      incumbent.abandonment,
    )
  ) {
    return {
      kind: "refuse",
      incumbent: describeLeaseIncumbent(incumbent),
      remedy: leaseRemedyFor(incumbent),
    };
  }

  // Lease-free but still physically in the active row — the legacy position
  // R3.3 requires a launch to tolerate with no explicit clear act.
  return {
    kind: "admit-with-normalization",
    incumbent: describeLeaseIncumbent(incumbent),
  };
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

  // The reservation schema intentionally represents "unreserved" and "never
  // admitted" as either absent fields or null, so compare those claims
  // canonically.
  const currentContextState = {
    ...contextState,
    reservedByBatchId: contextState.reservedByBatchId ?? null,
    reservedOwnership: contextState.reservedOwnership ?? null,
  };
  const initialContextState = {
    ...pin.contextState,
    reservedByBatchId: pin.contextState.reservedByBatchId ?? null,
    reservedOwnership: pin.contextState.reservedOwnership ?? null,
  };

  const isUnstarted =
    !execution.activeContextIds.includes(contextId) &&
    deepEqualJson(currentContextState, initialContextState) &&
    everyTaskInitial;

  return isUnstarted ? "unstarted" : "started";
}

/**
 * The execution-level gate (doc 06, "Execution-level gate"). `quiescent` (paused
 * or resumably-halted) unlocks the full policy surface including structural ops;
 * a `running` execution is editable but only for ops whose every target is
 * `unstarted`. Terminal (`completed`/`aborted`) and non-resumably-halted
 * executions are read-only, and so is a run parked awaiting a definition
 * decision — the snapshot a human is reviewing must be the snapshot the
 * execution-addressed approval admits.
 */
export function classifyExecutionEditability(
  execution: GraphWorkflowExecution,
): ExecutionEditability {
  if (
    awaitsDefinitionApproval(execution.status, execution.definitionApproval)
  ) {
    return { kind: "not-editable", reason: "awaiting-definition-approval" };
  }
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
