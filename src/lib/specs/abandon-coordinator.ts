import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  explicitArchiveEligibility,
  isTerminalStatus,
} from "@/lib/workflow-graph/lifecycle-classifier";
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
 * `active` means the execution is still the session's live row (it owns the
 * slot regardless of status); `archived` means it has already been moved out
 * and owns nothing. The two are deliberately distinct from `status`, because
 * an `aborted` run that failed to auto-release is still slot-owning.
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
    };

/**
 * The act a phase calls for. `skip` records an audit note instead of doing
 * work (nothing to abort, nothing to release); `blocked` is the refusal that
 * keeps the coordinator from ever reporting success over a live or
 * slot-owning run, and carries the exact verb that unblocks it.
 */
export type AbandonCleanupAct =
  | { kind: "abort_workflow"; workflowExecutionId: string }
  | { kind: "release_slot"; workflowExecutionId: string }
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
    case "release_slot":
      return releaseSlotStep(input.linkedWorkflow);
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
    nextPhase: "release_slot",
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
      return isTerminalStatus(linked.status)
        ? skip(
            `Linked graph workflow execution ${linked.workflowExecutionId} is already terminal (${linked.status}).`,
          )
        : {
            act: {
              kind: "abort_workflow",
              workflowExecutionId: linked.workflowExecutionId,
            },
            nextPhase: "release_slot",
          };
    default:
      return assertNever(linked, "unhandled linked-workflow observation");
  }
}

function releaseSlotStep(
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
      // The lifecycle contract decides archivability; a status it refuses is a
      // live run, and skipping it here is precisely the orphan this coordinator
      // exists to prevent — so it repeats the phase and names the abort verb.
      return explicitArchiveEligibility(linked.status) === "refused"
        ? {
            act: liveRunRefusal(linked.workflowExecutionId, linked.status),
            nextPhase: "release_slot",
          }
        : {
            act: {
              kind: "release_slot",
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
  // between release and finalize the slot can be re-taken (a resume, a replay
  // of an older attempt), and finalizing then would report a clean abandonment
  // over a run that still owns the session.
  if (linked.kind === "active") {
    return {
      act:
        explicitArchiveEligibility(linked.status) === "refused"
          ? liveRunRefusal(linked.workflowExecutionId, linked.status)
          : {
              kind: "blocked",
              reason: `Graph workflow execution ${linked.workflowExecutionId} still owns this session's execution slot (${linked.status}).`,
              remedy:
                "Release the slot with 'cctl workflow live release --reason <reason>', then retry this command.",
            },
      nextPhase: "finalize",
    };
  }
  return { act: { kind: "finalize" }, nextPhase: null };
}

function liveRunRefusal(
  workflowExecutionId: string,
  status: GraphWorkflowStatus,
): Extract<AbandonCleanupAct, { kind: "blocked" }> {
  return {
    kind: "blocked",
    reason: `Graph workflow execution ${workflowExecutionId} is still live (${status}).`,
    remedy:
      "Abort it with 'cctl workflow live abort --reason <reason>', then retry this command.",
  };
}
