/**
 * Apply planner — pure disposition logic for a single cascade attempt.
 *
 * Given a cascade's neutral apply timing (from the backend descriptor's
 * `capabilityKinds`), the runtime state before the attempt, the attempted
 * hash + item set, and the current backend liveness signals, the planner
 * decides how the apply service must record the attempt:
 *
 *   - `compositionSupport === "verification-gated"` → `unsupported`. The apply
 *     service must not call the backend port; the cascade is present so the UI
 *     can render diagnostics, but no runtime config is emittable yet.
 *   - `applyTiming === "next_conversation"` → `deferred-next-conversation`.
 *     The backend binding (e.g. Claude's `canUseTool`) is fixed at session
 *     creation, so a mutation against an active conversation can only stage.
 *   - `applyTiming === "next_turn"` → `staged-next-turn`. The backend
 *     rebuilds its options each turn; the apply service promotes the staged
 *     payload to `applied` at the next turn start.
 *   - `applyTiming === "idle_live"` →
 *       * `idle` mode: `try-live-apply` so the orchestrator can call the
 *         backend port and record `applied` / `rejected` based on the result.
 *       * `turn-active` mode: `staged-idle` so the apply service can drain on
 *         the running-to-idle transition without interrupting the turn.
 *
 * The planner is intentionally separated from the orchestrator so the
 * disposition table is exercised exhaustively by unit tests without spinning
 * up runtime ports or state stores. It never branches on backend identity —
 * every disposition is a read of the declared per-kind timing.
 *
 * Hash drift handling: when the attempted hash equals the previously applied
 * hash, the planner returns `idempotent-no-op` so the orchestrator can short-
 * circuit without writing pending state or calling the backend.
 */

import type { CapabilityApplyTiming } from "@/lib/agent-backends/descriptor";
import type {
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityMetadata,
} from "./schemas";

import { computeCascadeRuntimeHash } from "./runtime-hashes";

export type ApplyTriggerMode =
  /** Backend conversation is currently between turns and accepting work. */
  | "idle"
  /** A backend turn is in flight; live-apply paths must defer. */
  | "turn-active";

export interface PlanCascadeApplyInput {
  metadata: AgentCapabilityMetadata;
  applyTiming: CapabilityApplyTiming;
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

  switch (input.applyTiming) {
    case "next_conversation":
      return { disposition: "deferred-next-conversation" };
    case "next_turn":
      return { disposition: "staged-next-turn" };
    case "idle_live":
      if (input.triggerMode === "turn-active") {
        return { disposition: "staged-idle" };
      }
      return { disposition: "try-live-apply" };
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

  if (previous.lastApplyStatus === "deferred-next-conversation") {
    return {
      disposition: "deferred-next-conversation",
      stateAction: "preserve",
    };
  }

  const isStaged = previous.lastApplyStatus === "staged-next-turn";
  // Next-turn cascades are the only ones whose rejected records retry at turn
  // start — the backend re-ingests options at the turn boundary, so the
  // pending payload gets a fresh chance without interrupting anything.
  const isNextTurnRetryableRejected =
    applyTiming === "next_turn" &&
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

  if (applyTiming === "next_turn") {
    // The staged payload must actually reach the runtime before the upcoming
    // turn ingests options, so the orchestrator calls the apply port.
    return {
      disposition: "try-turn-start-apply",
      attemptedHash: composed.attemptedHash,
      attemptedItemIds: composed.attemptedItemIds,
    };
  }

  // Non-next-turn cascades staged at conversation start were already
  // delivered at session creation; turn start merely promotes the record.
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
