/** Plans saved preferences and turn-boundary delivery without mutating runtimes. */

import type { CapabilityApplyTiming } from "@/lib/agent-backends/descriptor";
import type {
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityMetadata,
} from "./schemas";

import { computeCascadeRuntimeHash } from "./runtime-hashes";

export interface PlanCascadeApplyInput {
  metadata: AgentCapabilityMetadata;
  applyTiming: CapabilityApplyTiming;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  attemptedHash: string;
  attemptedItemIds: readonly string[];
}

export type CascadeApplyPlan =
  | {
      disposition: "idempotent-no-op";
    }
  | {
      disposition: "unsupported";
    }
  | {
      disposition: "staged-next-turn";
    }
  | {
      disposition: "deferred-next-conversation";
    };

export function planCascadeApply(
  input: PlanCascadeApplyInput,
): CascadeApplyPlan {
  if (input.metadata.compositionSupport === "verification-gated") {
    return { disposition: "unsupported" };
  }

  if (
    input.previous?.appliedHash !== undefined &&
    input.previous.appliedHash === input.attemptedHash &&
    input.previous.lastApplyStatus === "applied"
  ) {
    return { disposition: "idempotent-no-op" };
  }

  switch (input.applyTiming) {
    case "next_conversation":
      return { disposition: "deferred-next-conversation" };
    case "next_turn":
      return { disposition: "staged-next-turn" };
    case "idle_live":
      return { disposition: "staged-next-turn" };
  }
}

interface ComposedCascadeAttempt {
  attemptedHash: string;
  attemptedItemIds: readonly string[];
}

type IdempotentNoOpReason =
  | "not-pending"
  | "not-turn-start-pending"
  | "missing-composed-cascade"
  | "hash-drift";

export type TurnStartCascadeApplyPlan =
  | {
      disposition: "idempotent-no-op";
      stateAction: "preserve" | "clear-obsolete";
      reason: IdempotentNoOpReason;
    }
  | {
      disposition: "deferred-next-conversation";
      stateAction: "preserve";
    }
  | {
      disposition: "try-turn-start-apply";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
    };

export interface PlanTurnStartCascadeApplyInput {
  applyTiming: CapabilityApplyTiming;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  composed: ComposedCascadeAttempt | undefined;
}

export function planTurnStartCascadeApply(
  input: PlanTurnStartCascadeApplyInput,
): TurnStartCascadeApplyPlan {
  const { applyTiming, previous, composed } = input;
  if (!previous) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "clear-obsolete",
      reason: "not-pending",
    };
  }

  if (applyTiming === "next_conversation") {
    return {
      disposition: "deferred-next-conversation",
      stateAction: "preserve",
    };
  }

  const isStaged =
    previous.lastApplyStatus === "staged-next-turn" ||
    previous.lastApplyStatus === "staged-idle";
  // A rejected delivery retries at a turn boundary while retaining its pending selection.
  const isNextTurnRetryableRejected =
    previous.lastApplyStatus === "rejected" &&
    previous.pendingHash !== undefined;

  if (!isStaged && !isNextTurnRetryableRejected) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "not-turn-start-pending",
    };
  }

  if (previous.pendingHash === undefined) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "not-pending",
    };
  }

  if (!composed) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "clear-obsolete",
      reason: "missing-composed-cascade",
    };
  }

  if (composed.attemptedHash !== previous.pendingHash) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "hash-drift",
    };
  }

  return {
    disposition: "try-turn-start-apply",
    attemptedHash: composed.attemptedHash,
    attemptedItemIds: composed.attemptedItemIds,
  };
}

export type MissingTargetCascadeAfterMutationPlan =
  | {
      disposition: "unsupported";
      stateAction: "preserve";
    }
  | {
      disposition: "rejected";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
      reason: "missing-target-cascade";
    };

export interface PlanMissingTargetCascadeAfterMutationInput {
  metadata: AgentCapabilityMetadata;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
}

export function planMissingTargetCascadeAfterMutation(
  input: PlanMissingTargetCascadeAfterMutationInput,
): MissingTargetCascadeAfterMutationPlan {
  if (input.metadata.compositionSupport === "verification-gated") {
    return {
      disposition: "unsupported",
      stateAction: "preserve",
    };
  }

  return {
    disposition: "rejected",
    attemptedHash:
      input.previous?.pendingHash ??
      input.previous?.appliedHash ??
      computeCascadeRuntimeHash({
        cascadeKind: input.metadata.cascadeKind,
        rows: [],
      }),
    attemptedItemIds: input.previous?.pendingItemIds ?? [],
    reason: "missing-target-cascade",
  };
}

type CascadeFailureKind = "compose-throw" | "failed-discovery";

export type CascadeFailurePlan =
  | {
      disposition: "unsupported";
      stateAction: "preserve";
      reason: "verification-gated";
    }
  | {
      disposition: "rejected";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
      reason: CascadeFailureKind;
    };

export interface PlanCascadeFailureInput {
  metadata: AgentCapabilityMetadata;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  failureKind: CascadeFailureKind;
}

export function planCascadeFailure(
  input: PlanCascadeFailureInput,
): CascadeFailurePlan {
  if (input.metadata.compositionSupport === "verification-gated") {
    return {
      disposition: "unsupported",
      stateAction: "preserve",
      reason: "verification-gated",
    };
  }

  return {
    disposition: "rejected",
    attemptedHash:
      input.previous?.pendingHash ??
      input.previous?.appliedHash ??
      computeCascadeRuntimeHash({
        cascadeKind: input.metadata.cascadeKind,
        rows: [],
      }),
    attemptedItemIds: input.previous?.pendingItemIds ?? [],
    reason: input.failureKind,
  };
}
