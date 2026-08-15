import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { assertNever } from "@/lib/shared/assert-never";
import { specExecutionCleanupPhaseSchema } from "./schemas";
import type { SpecExecutionCleanupPhase } from "./schemas";

/**
 * The abandon coordinator's pure transition table (design §10).
 *
 * `spec abandon --execution` used to touch spec state only, stranding the
 * workflow it launched: the run kept the session's execution slot and every
 * `cctl validate` call in that session stayed refused until an operator called
 * raw API routes (ticket #47 note 9e5ba960). The fix is a durable, idempotent
 * three-phase coordinator, and this module is its decision half — pure so the
 * phase progression, the skip-forward cases, and the "never report success
 * while the run is live" invariant are table-testable without a database.
 *
 * Terminality and slot ownership are NOT decided here: every such question
 * delegates to the lifecycle contract in
 * `@/lib/workflow-graph/lifecycle-classifier`, which is the single authority.
 */

/** The ordered cleanup phases. Progression is forward-only. */
export const SPEC_EXECUTION_CLEANUP_PHASES =
  specExecutionCleanupPhaseSchema.options;

/** Where every abandonment starts; earlier phases skip forward when moot. */
export const INITIAL_ABANDON_CLEANUP_PHASE: SpecExecutionCleanupPhase =
  "abort_workflow";

/**
 * What the coordinator observed about the run it is cleaning up, resolved
 * fresh at every phase so a retry sees the world as it is now rather than as
 * the previous attempt left it.
 *
 * `leaseHeld` — not the row's physical position — is what says the run is
 * still live work. A terminal record sitting in the active row holds nothing
 * and is normalized into History by the next launch, so the coordinator has
 * no act to perform on it; the lease is the only thing that can still block a
 * clean abandonment.
 */
export type LinkedWorkflowObservation =
  | { kind: "never_launched" }
  | { kind: "missing"; workflowExecutionId: string }
  | {
      kind: "archived";
      workflowExecutionId: string;
      status: GraphWorkflowStatus;
    }
  | {
      kind: "active";
      workflowExecutionId: string;
      status: GraphWorkflowStatus;
      leaseHeld: boolean;
    };

/**
 * The act a phase calls for. `skip` records an audit note instead of doing
 * work (nothing left holding the lease); `blocked` is the refusal that keeps
 * the coordinator from ever reporting success over a run that still holds the
 * session's lease, and carries the exact verb that unblocks it.
 *
 * Two ways to end a run, chosen by how it holds the lease — never a second
 * release step. Abort drives a live run to `aborted`, which releases the lease
 * on its own; abandon ends a resumable halt's tenure while preserving the halt
 * reason under an audit (R4). Both leave nothing half-done.
 */
export type AbandonCleanupAct =
  | { kind: "abort_workflow"; workflowExecutionId: string }
  | { kind: "abandon_workflow"; workflowExecutionId: string }
  | { kind: "finalize" }
  | { kind: "skip"; note: string }
  | { kind: "blocked"; reason: string; remedy: string };

export interface AbandonCleanupStep {
  act: AbandonCleanupAct;
  /**
   * The phase to persist once the act succeeds — `null` only for `finalize`,
   * which leaves the cleanup machine entirely. A `blocked` act repeats its own
   * phase, so a retry re-enters exactly where it stopped.
   */
  nextPhase: SpecExecutionCleanupPhase | null;
}

/** `abandoned` is reachable from the final phase and nowhere else. */
export function abandonFinalizationAllowed(
  phase: SpecExecutionCleanupPhase,
): boolean {
  return phase === "finalize";
}

export function nextAbandonCleanupStep(input: {
  phase: SpecExecutionCleanupPhase;
  linkedWorkflow: LinkedWorkflowObservation;
}): AbandonCleanupStep {
  switch (input.phase) {
    case "abort_workflow":
      return abortWorkflowStep(input.linkedWorkflow);
    case "finalize":
      return finalizeStep(input.linkedWorkflow);
    default:
      return assertNever(
        input.phase,
        `unhandled cleanup phase: ${input.phase}`,
      );
  }
}

function abortWorkflowStep(
  linked: LinkedWorkflowObservation,
): AbandonCleanupStep {
  const skip = (note: string): AbandonCleanupStep => ({
    act: { kind: "skip", note },
    nextPhase: "finalize",
  });
  switch (linked.kind) {
    case "never_launched":
      return skip(
        "No graph workflow execution was ever launched for this run.",
      );
    case "missing":
      return skip(
        `Linked graph workflow execution ${linked.workflowExecutionId} no longer exists.`,
      );
    case "archived":
      return skip(
        `Linked graph workflow execution ${linked.workflowExecutionId} is already archived (${linked.status}).`,
      );
    case "active":
      // Lease-free means History already owns it, whatever row it physically
      // occupies — ending it would be a no-op the coordinator would then have
      // to record as a completed phase.
      if (!linked.leaseHeld) {
        return skip(
          `Linked graph workflow execution ${linked.workflowExecutionId} no longer holds this session's execution lease (${linked.status}).`,
        );
      }
      return {
        act: {
          // A halt that still holds the lease is resumable by definition, and
          // R4 makes abandon the one act that ends that tenure: aborting it
          // would rewrite the run's final engine state to `aborted` and lose
          // both the halt reason and the abandonment audit History renders.
          kind:
            linked.status === "halted" ? "abandon_workflow" : "abort_workflow",
          workflowExecutionId: linked.workflowExecutionId,
        },
        nextPhase: "finalize",
      };
    default:
      return assertNever(linked, "unhandled linked-workflow observation");
  }
}

function finalizeStep(linked: LinkedWorkflowObservation): AbandonCleanupStep {
  // Re-checked at the last moment rather than trusted from the previous phase:
  // between the abort and the finalize the session's lease can be taken again
  // (a resume, a replay of an older attempt), and finalizing then would report
  // a clean abandonment over live work.
  if (linked.kind === "active" && linked.leaseHeld) {
    return {
      act: liveRunRefusal(linked.workflowExecutionId, linked.status),
      nextPhase: "finalize",
    };
  }
  return { act: { kind: "finalize" }, nextPhase: null };
}

/**
 * The refusal, naming the act that actually applies to the blocker. A halted
 * run keeps the lease because its halt is resumable, and abandon is the one
 * act that ends that tenure while preserving the halt reason; everything else
 * still holding the lease is ended by abort, which releases automatically.
 */
function liveRunRefusal(
  workflowExecutionId: string,
  status: GraphWorkflowStatus,
): Extract<AbandonCleanupAct, { kind: "blocked" }> {
  return {
    kind: "blocked",
    reason: `Graph workflow execution ${workflowExecutionId} still holds this session's execution lease (${status}).`,
    remedy:
      status === "halted"
        ? "Abandon it with 'cctl workflow abandon --reason <reason>', then retry this command."
        : "Abort it with 'cctl workflow live abort --reason <reason>', then retry this command.",
  };
}
