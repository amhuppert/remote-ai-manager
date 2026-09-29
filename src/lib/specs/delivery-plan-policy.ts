import {
  deliveryPlanDocumentSchema,
  finalizedDeliveryPlanPrelaunchSchema,
  postLaunchPathsSentence,
  type DeliveryPlanDocument,
  type FinalizedDeliveryPlanCandidateIdentity,
  type FinalizedDeliveryPlanPrelaunch,
} from "./delivery-plan";
import type { ActorProvenance, DeliveryPlanAttemptStatus } from "./schemas";

/**
 * An act asked for in a status that cannot serve it. Every message states the
 * act that IS available from here and the id it addresses, because a refusal
 * that only reports the status recreates the dead end one layer up.
 */
export class DeliveryPlanStatusConflictError extends Error {
  readonly code = "plan_status_conflict" as const;

  constructor(
    readonly attemptId: string,
    readonly status: DeliveryPlanAttemptStatus,
    readonly remedy: string,
  ) {
    super(
      `delivery plan attempt ${attemptId} is ${status}. Nothing was written. ${remedy}`,
    );
    this.name = "DeliveryPlanStatusConflictError";
  }
}

export class DeliveryPlanReaffirmationStateError extends Error {
  readonly code = "plan_status_conflict" as const;

  constructor(
    readonly attemptId: string,
    readonly criterionElementId: string,
  ) {
    super(
      `delivery plan attempt ${attemptId} has no pending reaffirmation for criterion ${criterionElementId}. Nothing was written. Read the draft with \`cctl spec plan get\` and reaffirm only a criterion marked pending_reaffirmation.`,
    );
    this.name = "DeliveryPlanReaffirmationStateError";
  }
}

export type DeliveryPlanTransition =
  | ({
      readonly kind: "park";
      readonly reason: string | null;
    } & FinalizedDeliveryPlanCandidateIdentity)
  | ({
      readonly kind: "launch";
      readonly executionId: string;
    } & FinalizedDeliveryPlanCandidateIdentity)
  | { readonly kind: "abandon"; readonly reason: string };

export interface DeliveryPlanAttemptLifecycle {
  readonly attemptId: string;
  readonly status: DeliveryPlanAttemptStatus;
  readonly launchedExecutionId: string | null;
}

export type DeliveryPlanTransitionDecision =
  | {
      readonly status: "parked";
      readonly prelaunch: FinalizedDeliveryPlanPrelaunch;
    }
  | { readonly status: "launched"; readonly executionId: string }
  | { readonly status: "abandoned" };

/**
 * The execution identity here is the internal spec execution row id, not an
 * address accepted by `--execution`. Refusals name the slug-addressed exits;
 * the service supplies the workflow execution identity when it has one.
 */
const POST_LAUNCH_PATHS = () => postLaunchPathsSentence({});

export function requireEditableDeliveryPlanDraft(
  attempt: DeliveryPlanAttemptLifecycle,
): void {
  if (attempt.status !== "draft") {
    throw new DeliveryPlanStatusConflictError(
      attempt.attemptId,
      attempt.status,
      attempt.status === "launched" && attempt.launchedExecutionId !== null
        ? POST_LAUNCH_PATHS()
        : attempt.status === "abandoned"
          ? "Open a fresh attempt with `cctl spec plan open`."
          : "Return it to draft with `cctl spec plan reopen` before editing it.",
    );
  }
}

export function requireReopenableDeliveryPlan(
  attempt: DeliveryPlanAttemptLifecycle,
  schemaVersion: DeliveryPlanDocument["schemaVersion"],
): void {
  if (attempt.status === "draft" && schemaVersion === 4) {
    throw new DeliveryPlanStatusConflictError(
      attempt.attemptId,
      attempt.status,
      "There is nothing to reopen. Author the graph with `cctl workflow replace <id> --file <plan.json>`.",
    );
  }
  if (attempt.status === "launched" && attempt.launchedExecutionId !== null) {
    throw new DeliveryPlanStatusConflictError(
      attempt.attemptId,
      attempt.status,
      POST_LAUNCH_PATHS(),
    );
  }
  if (attempt.status === "abandoned") {
    throw new DeliveryPlanStatusConflictError(
      attempt.attemptId,
      attempt.status,
      "Open a fresh attempt with `cctl spec plan open`.",
    );
  }
}

export function reaffirmDeliveryPlanCriteria(
  attemptId: string,
  document: DeliveryPlanDocument,
  criterionElementIds: readonly string[],
): DeliveryPlanDocument {
  for (const criterionElementId of criterionElementIds) {
    const disposition = document.binding.dispositions.find(
      (entry) => entry.criterionElementId === criterionElementId,
    );
    if (disposition?.disposition !== "pending_reaffirmation") {
      throw new DeliveryPlanReaffirmationStateError(
        attemptId,
        criterionElementId,
      );
    }
  }
  const targets = new Set(criterionElementIds);
  return deliveryPlanDocumentSchema.parse({
    ...document,
    binding: {
      ...document.binding,
      dispositions: document.binding.dispositions.map((entry) =>
        targets.has(entry.criterionElementId)
          ? { ...entry, disposition: "reaffirmed" as const }
          : entry,
      ),
    },
  });
}

/** Decide against the attempt reread by the caller's open write transaction. */
export function decideDeliveryPlanTransition(
  attempt: {
    readonly attemptId: string;
    readonly status: DeliveryPlanAttemptStatus;
    readonly hasApproval: boolean;
  },
  input: {
    readonly transition: DeliveryPlanTransition;
    readonly occurredAt: string;
    readonly actor: ActorProvenance;
  },
): DeliveryPlanTransitionDecision {
  const transition = input.transition;
  if (transition.kind === "park") {
    if (attempt.status !== "approved") {
      throw new DeliveryPlanStatusConflictError(
        attempt.attemptId,
        attempt.status,
        "Only a signed-off attempt can be parked for prelaunch review. Sign off the draft first.",
      );
    }
    return {
      status: "parked",
      prelaunch: finalizedDeliveryPlanPrelaunchSchema.parse({
        parkedAt: input.occurredAt,
        parkedBy: input.actor,
        reason: transition.reason,
        candidate: {
          candidateId: transition.candidateId,
          candidateHash: transition.candidateHash,
        },
      }),
    };
  }
  if (transition.kind === "launch") {
    if (
      (attempt.status !== "approved" && attempt.status !== "parked") ||
      !attempt.hasApproval
    ) {
      throw new DeliveryPlanStatusConflictError(
        attempt.attemptId,
        attempt.status,
        attempt.status === "launched" || attempt.status === "abandoned"
          ? "Open a fresh attempt with `cctl spec plan open`."
          : "Only a signed-off candidate launches. Sign off the draft first.",
      );
    }
    return { status: "launched", executionId: transition.executionId };
  }
  if (attempt.status === "abandoned") {
    throw new DeliveryPlanStatusConflictError(
      attempt.attemptId,
      attempt.status,
      "Open a fresh attempt with `cctl spec plan open`.",
    );
  }
  return { status: "abandoned" };
}
