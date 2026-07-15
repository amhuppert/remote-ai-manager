import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  ResolvedCapabilityCascade,
  RuntimeConfigApplyResult,
} from "@/lib/agent-backends/runtime-config";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
} from "../schemas";

import { applyTimingForCascade } from "../metadata";
import {
  planCascadeApply,
  planIdleDrainCascadeApply,
  planTurnStartCascadeApply,
  type ApplyTriggerMode,
  type CascadeApplyPlan,
} from "../apply-planner";
import { recordApplyOutcome, sanitizeApplyError } from "../runtime-hashes";

import type {
  AffectedConversation,
  ApplyContext,
  ApplyOneCascadeResult,
  ApplyTrigger,
  ComposedCascadeInfo,
} from "./helpers";
import { conversationIdentityForPorts } from "./helpers";
import { logCascadePlan } from "./logging";
import {
  handleMissingTargetCascadeAfterMutation,
  rejectForDiscoveryFailure,
  unsupportedVerificationGatedResult,
} from "./outcome";

const logger = createLogger("agent-capabilities.apply.cascade");

export async function applyOneCascade(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composedCascades: Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>;
  failedCascadeKinds: ReadonlySet<AgentCapabilityCascadeKind>;
  resolved: ResolvedCapabilityCascade | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  trigger: ApplyTrigger;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composedCascades,
    failedCascadeKinds,
    resolved,
    previous,
    trigger,
    operationId,
  } = input;
  const { deps, metadataRegistry } = context;
  const metadata = metadataRegistry.get(cascadeKind);

  if (metadata.backend !== conversation.backend) {
    logCascadePlan({
      trigger,
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: "unsupported",
      operationId,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "unsupported",
      },
      nextState: previous,
    };
  }

  if (failedCascadeKinds.has(cascadeKind)) {
    logCascadePlan({
      trigger,
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: "rejected",
      operationId,
    });
    return rejectForDiscoveryFailure({
      cascadeKind,
      conversation,
      previous,
      metadata,
    });
  }

  if (metadata.compositionSupport === "verification-gated") {
    logCascadePlan({
      trigger,
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: "unsupported",
      operationId,
    });
    return unsupportedVerificationGatedResult({
      cascadeKind,
      conversation,
      previous,
    });
  }

  const composed = composedCascades.get(cascadeKind);

  if (trigger === "idle-drain") {
    return handleIdleDrain({
      context,
      cascadeKind,
      conversation,
      composed,
      resolved,
      previous,
      operationId,
    });
  }

  if (trigger === "turn-start") {
    return handleTurnStart({
      context,
      cascadeKind,
      conversation,
      composed,
      resolved,
      previous,
    });
  }

  if (!composed) {
    return handleMissingTargetCascadeAfterMutation({
      cascadeKind,
      conversation,
      previous,
      metadata,
      operationId,
    });
  }

  const liveTurnActive = deps.isTurnActive(
    conversationIdentityForPorts(conversation),
  );
  const triggerMode: ApplyTriggerMode = liveTurnActive ? "turn-active" : "idle";

  const plan = planCascadeApply({
    metadata,
    applyTiming: applyTimingForCascade(cascadeKind),
    previous,
    attemptedHash: composed.attemptedHash,
    attemptedItemIds: composed.attemptedItemIds,
    triggerMode,
  });
  logCascadePlan({
    trigger,
    conversation,
    cascadeKind,
    previous,
    plannedDisposition: plan.disposition,
    attemptedHash: composed.attemptedHash,
    pendingItemCount: composed.attemptedItemIds.length,
    operationId,
  });

  return executePlan({
    context,
    plan,
    cascadeKind,
    conversation,
    composed,
    resolved,
    previous,
    operationId,
  });
}

async function executePlan(input: {
  context: ApplyContext;
  plan: CascadeApplyPlan;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo;
  resolved: ResolvedCapabilityCascade | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    plan,
    cascadeKind,
    conversation,
    composed,
    resolved,
    previous,
    operationId,
  } = input;
  switch (plan.disposition) {
    case "idempotent-no-op":
      return {
        outcome: { cascadeKind, disposition: "idempotent-no-op" },
        nextState: previous,
      };
    case "unsupported":
      return {
        outcome: { cascadeKind, disposition: "unsupported" },
        nextState: previous,
      };
    case "staged-idle":
      return {
        outcome: {
          cascadeKind,
          disposition: "staged-idle",
          attemptedHash: composed.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "staged-idle" },
        }),
      };
    case "staged-next-turn":
      return {
        outcome: {
          cascadeKind,
          disposition: "staged-next-turn",
          attemptedHash: composed.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "staged-next-turn" },
        }),
      };
    case "deferred-next-conversation":
      return {
        outcome: {
          cascadeKind,
          disposition: "deferred-next-conversation",
          attemptedHash: composed.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: composed.attemptedHash,
          attemptedItemIds: composed.attemptedItemIds,
          outcome: { status: "deferred-next-conversation" },
        }),
      };
    case "try-live-apply":
      return executeLiveApply({
        context,
        cascadeKind,
        conversation,
        composed,
        resolved,
        previous,
        operationId,
      });
  }
}

async function executeLiveApply(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo;
  resolved: ResolvedCapabilityCascade | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composed,
    resolved,
    previous,
    operationId,
  } = input;
  const port = context.deps.applyRuntimeConfig;
  if (!port || !resolved) {
    return {
      outcome: {
        cascadeKind,
        disposition: "staged-idle",
        attemptedHash: composed.attemptedHash,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: composed.attemptedHash,
        attemptedItemIds: composed.attemptedItemIds,
        outcome: { status: "staged-idle" },
      }),
      diagnostic: {
        severity: "info",
        code: "agent-capability-apply-failed",
        message:
          "Runtime-config apply port unavailable; change staged for idle drain",
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  let result: RuntimeConfigApplyResult;
  try {
    result = await port({
      conversation: conversationIdentityForPorts(conversation),
      resolved,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const sanitized = sanitizeApplyError(message);
    logger.error("apply.failed", {
      cascadeKind,
      conversationId: conversation.conversationId,
      operationId,
      error: sanitized,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash: composed.attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: composed.attemptedHash,
        attemptedItemIds: composed.attemptedItemIds,
        outcome: { status: "rejected", error: message },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Runtime-config apply failed: ${sanitizeApplyError(message)}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  if (result.status === "deferred") {
    return {
      outcome: {
        cascadeKind,
        disposition: "staged-idle",
        attemptedHash: composed.attemptedHash,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: composed.attemptedHash,
        attemptedItemIds: composed.attemptedItemIds,
        outcome: { status: "staged-idle" },
      }),
    };
  }

  if (result.status === "rejected") {
    const sanitized = sanitizeApplyError(result.error);
    logger.error("apply.failed", {
      cascadeKind,
      conversationId: conversation.conversationId,
      operationId,
      error: sanitized,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash: composed.attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash: composed.attemptedHash,
        attemptedItemIds: composed.attemptedItemIds,
        outcome: { status: "rejected", error: result.error },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Runtime-config apply rejected: ${sanitizeApplyError(result.error)}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  logger.info("apply.succeeded", {
    cascadeKind,
    conversationId: conversation.conversationId,
    operationId,
  });
  return {
    outcome: {
      cascadeKind,
      disposition: "applied",
      attemptedHash: composed.attemptedHash,
    },
    nextState: recordApplyOutcome({
      previous,
      attemptedHash: composed.attemptedHash,
      attemptedItemIds: composed.attemptedItemIds,
      outcome: { status: "applied" },
    }),
  };
}

async function handleIdleDrain(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo | undefined;
  resolved: ResolvedCapabilityCascade | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composed,
    resolved,
    previous,
    operationId,
  } = input;
  const plan = planIdleDrainCascadeApply({ previous, composed });
  logCascadePlan({
    trigger: "idle-drain",
    conversation,
    cascadeKind,
    previous,
    plannedDisposition: plan.disposition,
    attemptedHash:
      plan.disposition === "try-live-apply" ? plan.attemptedHash : undefined,
    pendingItemCount:
      plan.disposition === "try-live-apply"
        ? plan.attemptedItemIds.length
        : undefined,
    reason: plan.disposition === "idempotent-no-op" ? plan.reason : undefined,
    operationId,
  });

  if (plan.disposition === "idempotent-no-op") {
    if (plan.reason === "hash-drift" && composed && previous?.pendingHash) {
      // Drift between the hash recorded at staging time and what the composer
      // now emits (e.g., overrides changed again before the drain ran). The
      // staged record was for a different effective payload, so leave it in
      // place rather than overwriting `lastApplyError` / pending state for a
      // hash the operator never intended to drain. A subsequent
      // `applyAfterOverrideChange` will re-stage with the new hash.
      logger.info("apply.idle_drain_skipped_hash_drift", {
        cascadeKind,
        conversationId: conversation.conversationId,
        stagedHash: previous.pendingHash,
        composedHash: composed.attemptedHash,
      });
    }
    if (plan.stateAction === "clear-obsolete") {
      return {
        outcome: { cascadeKind, disposition: "idempotent-no-op" },
        nextState: undefined,
      };
    }
    return {
      outcome: { cascadeKind, disposition: "idempotent-no-op" },
      nextState: previous,
    };
  }

  return executeLiveApply({
    context,
    cascadeKind,
    conversation,
    composed: {
      cascadeKind,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
    },
    resolved,
    previous,
    operationId,
  });
}

async function handleTurnStart(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo | undefined;
  resolved: ResolvedCapabilityCascade | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
}): Promise<ApplyOneCascadeResult> {
  const { context, cascadeKind, conversation, composed, resolved, previous } =
    input;
  const plan = planTurnStartCascadeApply({
    applyTiming: applyTimingForCascade(cascadeKind),
    previous,
    composed,
  });
  logCascadePlan({
    trigger: "turn-start",
    conversation,
    cascadeKind,
    previous,
    plannedDisposition: plan.disposition,
    attemptedHash:
      plan.disposition === "try-turn-start-apply" ||
      plan.disposition === "applied"
        ? plan.attemptedHash
        : undefined,
    pendingItemCount:
      plan.disposition === "try-turn-start-apply" ||
      plan.disposition === "applied"
        ? plan.attemptedItemIds.length
        : undefined,
    reason: plan.disposition === "idempotent-no-op" ? plan.reason : undefined,
  });

  switch (plan.disposition) {
    case "idempotent-no-op":
      if (plan.reason === "hash-drift" && composed && previous?.pendingHash) {
        logger.info("apply.turn_start_skipped_hash_drift", {
          cascadeKind,
          conversationId: conversation.conversationId,
          stagedHash: previous.pendingHash,
          composedHash: composed.attemptedHash,
        });
      }
      return {
        outcome: { cascadeKind, disposition: "idempotent-no-op" },
        nextState: plan.stateAction === "clear-obsolete" ? undefined : previous,
      };
    case "deferred-next-conversation":
      return {
        outcome: { cascadeKind, disposition: "deferred-next-conversation" },
        nextState: previous,
      };
    case "try-turn-start-apply":
      if (!previous) {
        return {
          outcome: { cascadeKind, disposition: "idempotent-no-op" },
          nextState: undefined,
        };
      }
      return executeTurnStartApply({
        context,
        cascadeKind,
        conversation,
        resolved,
        attemptedHash: plan.attemptedHash,
        attemptedItemIds: plan.attemptedItemIds,
        previous,
      });
    case "applied":
      return {
        outcome: {
          cascadeKind,
          disposition: "applied",
          attemptedHash: plan.attemptedHash,
        },
        nextState: recordApplyOutcome({
          previous,
          attemptedHash: plan.attemptedHash,
          attemptedItemIds: plan.attemptedItemIds,
          outcome: { status: "applied" },
        }),
      };
  }
}

async function executeTurnStartApply(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  resolved: ResolvedCapabilityCascade | undefined;
  attemptedHash: string;
  attemptedItemIds: readonly string[];
  previous: AgentCapabilityCascadeRuntimeState;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    resolved,
    attemptedHash,
    attemptedItemIds,
    previous,
  } = input;
  const port = context.deps.applyRuntimeConfig;
  if (!port || !resolved) {
    const reason = !port
      ? "runtime-config apply port unavailable"
      : "runtime composition missing";
    logger.error("apply.turn_start_unavailable", {
      cascadeKind,
      conversationId: conversation.conversationId,
      reason,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash,
        error: sanitizeApplyError(reason),
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash,
        attemptedItemIds,
        outcome: { status: "rejected", error: reason },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Turn-start apply failed: ${sanitizeApplyError(reason)}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  let result: RuntimeConfigApplyResult;
  try {
    result = await port({
      conversation: conversationIdentityForPorts(conversation),
      resolved,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const sanitized = sanitizeApplyError(message);
    logger.error("apply.turn_start_failed", {
      cascadeKind,
      conversationId: conversation.conversationId,
      error: sanitized,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash,
        attemptedItemIds,
        outcome: { status: "rejected", error: message },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Turn-start apply failed: ${sanitizeApplyError(message)}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  if (result.status === "deferred") {
    // A turn began between staging and this apply; keep the payload staged so
    // the next turn boundary retries it.
    return {
      outcome: {
        cascadeKind,
        disposition: "staged-next-turn",
        attemptedHash,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash,
        attemptedItemIds,
        outcome: { status: "staged-next-turn" },
      }),
    };
  }

  if (result.status === "rejected") {
    const sanitized = sanitizeApplyError(result.error);
    logger.error("apply.turn_start_rejected", {
      cascadeKind,
      conversationId: conversation.conversationId,
      error: sanitized,
    });
    return {
      outcome: {
        cascadeKind,
        disposition: "rejected",
        attemptedHash,
        error: sanitized,
      },
      nextState: recordApplyOutcome({
        previous,
        attemptedHash,
        attemptedItemIds,
        outcome: { status: "rejected", error: result.error },
      }),
      diagnostic: {
        severity: "error",
        code: "agent-capability-apply-failed",
        message: `Turn-start apply rejected: ${sanitizeApplyError(result.error)}`,
        backend: conversation.backend,
        cascadeKind,
      },
    };
  }

  logger.info("apply.turn_start_succeeded", {
    cascadeKind,
    conversationId: conversation.conversationId,
  });
  return {
    outcome: {
      cascadeKind,
      disposition: "applied",
      attemptedHash,
    },
    nextState: recordApplyOutcome({
      previous,
      attemptedHash,
      attemptedItemIds,
      outcome: { status: "applied" },
    }),
  };
}
