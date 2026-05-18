/**
 * Apply planner — pure disposition logic for a single cascade attempt.
 *
 * Given a cascade's metadata, the runtime state before the attempt, the
 * attempted hash + item set, and the current backend liveness signals, the
 * planner decides how the apply service must record the attempt:
 *
 *   - `compositionSupport === "verification-gated"` → `unsupported`. The apply
 *     service must not call the backend port; the cascade is present so the UI
 *     can render diagnostics, but no runtime config is emittable yet.
 *   - `applySemantics === "next-conversation"` → `deferred-next-conversation`.
 *     The backend binding (e.g. Claude's `canUseTool`) is fixed at session
 *     creation, so a mutation against an active conversation can only stage.
 *   - `applySemantics === "next-turn"` → `staged-next-turn`. The backend
 *     rebuilds its options each turn; the apply service promotes the staged
 *     payload to `applied` at the next turn start.
 *   - `applySemantics === "idle-live-apply"` →
 *       * `idle` mode: `try-live-apply` so the orchestrator can call the
 *         backend port and record `applied` / `rejected` based on the result.
 *       * `turn-active` mode: `staged-idle` so the apply service can drain on
 *         the running-to-idle transition without interrupting the turn.
 *
 * The planner is intentionally separated from the orchestrator so the
 * disposition table is exercised exhaustively by unit tests without spinning
 * up runtime ports or state stores.
 *
 * Hash drift handling: when the attempted hash equals the previously applied
 * hash, the planner returns `idempotent-no-op` so the orchestrator can short-
 * circuit without writing pending state or calling the backend.
 */

import type {
  AgentBackendId,
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityMetadata,
} from "@/lib/schemas";

import { computeCascadeRuntimeHash } from "./runtime-hashes";

export type ApplyTriggerMode =
  /** Backend conversation is currently between turns and accepting work. */
  | "idle"
  /** A backend turn is in flight; live-apply paths must defer. */
  | "turn-active";

export interface PlanCascadeApplyInput {
  metadata: AgentCapabilityMetadata;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  attemptedHash: string;
  attemptedItemIds: readonly string[];
  triggerMode: ApplyTriggerMode;
}

export type CascadeApplyPlan =
  | {
      disposition: "idempotent-no-op";
    }
  | {
      disposition: "unsupported";
    }
  | {
      disposition: "staged-idle";
    }
  | {
      disposition: "staged-next-turn";
    }
  | {
      disposition: "deferred-next-conversation";
    }
  | {
      disposition: "try-live-apply";
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

  switch (input.metadata.applySemantics) {
    case "next-conversation":
      return { disposition: "deferred-next-conversation" };
    case "next-turn":
      return { disposition: "staged-next-turn" };
    case "idle-live-apply":
      if (input.triggerMode === "turn-active") {
        return { disposition: "staged-idle" };
      }
      return { disposition: "try-live-apply" };
  }
}

export interface ComposedCascadeAttempt {
  attemptedHash: string;
  attemptedItemIds: readonly string[];
}

export type IdempotentNoOpReason =
  | "not-pending"
  | "not-turn-start-pending"
  | "missing-composed-cascade"
  | "hash-drift";

export type IdleDrainCascadeApplyPlan =
  | {
      disposition: "idempotent-no-op";
      stateAction: "preserve" | "clear-obsolete";
      reason: IdempotentNoOpReason;
    }
  | {
      disposition: "try-live-apply";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
    };

export interface PlanIdleDrainCascadeApplyInput {
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  composed: ComposedCascadeAttempt | undefined;
}

export function planIdleDrainCascadeApply(
  input: PlanIdleDrainCascadeApplyInput,
): IdleDrainCascadeApplyPlan {
  const { previous, composed } = input;
  const hasRetryablePending =
    previous !== undefined &&
    previous.pendingHash !== undefined &&
    (previous.lastApplyStatus === "staged-idle" ||
      previous.lastApplyStatus === "rejected");

  if (!previous || !hasRetryablePending) {
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
    disposition: "try-live-apply",
    attemptedHash: composed.attemptedHash,
    attemptedItemIds: composed.attemptedItemIds,
  };
}

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
      disposition: "applied";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
    }
  | {
      disposition: "try-turn-start-apply";
      attemptedHash: string;
      attemptedItemIds: readonly string[];
    };

export interface PlanTurnStartCascadeApplyInput {
  backend: AgentBackendId;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  composed: ComposedCascadeAttempt | undefined;
}

export function planTurnStartCascadeApply(
  input: PlanTurnStartCascadeApplyInput,
): TurnStartCascadeApplyPlan {
  const { backend, previous, composed } = input;
  if (!previous) {
    return {
      disposition: "idempotent-no-op",
      stateAction: "clear-obsolete",
      reason: "not-pending",
    };
  }

  if (previous.lastApplyStatus === "deferred-next-conversation") {
    return {
      disposition: "deferred-next-conversation",
      stateAction: "preserve",
    };
  }

  const isStaged = previous.lastApplyStatus === "staged-next-turn";
  const isCodexRetryableRejected =
    backend === "codex" &&
    previous.lastApplyStatus === "rejected" &&
    previous.pendingHash !== undefined;

  if (!isStaged && !isCodexRetryableRejected) {
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

  if (backend === "codex") {
    return {
      disposition: "try-turn-start-apply",
      attemptedHash: composed.attemptedHash,
      attemptedItemIds: composed.attemptedItemIds,
    };
  }

  return {
    disposition: "applied",
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

export type CascadeFailureKind = "compose-throw" | "failed-discovery";

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
