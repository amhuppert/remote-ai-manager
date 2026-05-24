import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
} from "../schemas";

import {
  planCascadeApply,
  planIdleDrainCascadeApply,
  planTurnStartCascadeApply,
  type ApplyTriggerMode,
  type CascadeApplyPlan,
} from "../apply-planner";
import { recordApplyOutcome, sanitizeApplyError } from "../runtime-hashes";
import type { ClaudeRuntimeCapabilityConfig } from "../claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "../codex-runtime-translator";

import type {
  AffectedConversation,
  ApplyContext,
  ApplyOneCascadeResult,
  ApplyTrigger,
  ClaudeApplyPortResult,
  CodexApplyPortResult,
  ComposedCascadeInfo,
} from "./helpers";
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
  claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
  codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
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
    claudeRuntimeConfig,
    codexRuntimeConfig,
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
      claudeRuntimeConfig,
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
      codexRuntimeConfig,
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

  const liveTurnActive = deps.isTurnActive({
    projectPath: conversation.projectPath,
    sessionName: conversation.sessionName,
    conversationId: conversation.conversationId,
  });
  const triggerMode: ApplyTriggerMode = liveTurnActive ? "turn-active" : "idle";

  const plan = planCascadeApply({
    metadata,
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
    claudeRuntimeConfig,
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
  claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    plan,
    cascadeKind,
    conversation,
    composed,
    claudeRuntimeConfig,
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
      return executeClaudeLiveApply({
        context,
        cascadeKind,
        conversation,
        composed,
        claudeRuntimeConfig,
        previous,
        operationId,
      });
  }
}

async function executeClaudeLiveApply(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo;
  claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composed,
    claudeRuntimeConfig,
    previous,
    operationId,
  } = input;
  const port = context.deps.applyClaudeRuntime;
  if (!port || !claudeRuntimeConfig) {
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
          "Claude live-apply port unavailable; change staged for idle drain",
        backend: "claude",
        cascadeKind,
      },
    };
  }

  let result: ClaudeApplyPortResult;
  try {
    result = await port({
      conversationId: conversation.conversationId,
      config: claudeRuntimeConfig,
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
        message: `Claude apply failed: ${sanitizeApplyError(message)}`,
        backend: "claude",
        cascadeKind,
      },
    };
  }

  if (result.status === "skipped-turn-active") {
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
        message: `Claude apply rejected: ${sanitizeApplyError(result.error)}`,
        backend: "claude",
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
  claudeRuntimeConfig: ClaudeRuntimeCapabilityConfig | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  operationId?: string;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composed,
    claudeRuntimeConfig,
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

  return executeClaudeLiveApply({
    context,
    cascadeKind,
    conversation,
    composed: {
      cascadeKind,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
    },
    claudeRuntimeConfig,
    previous,
    operationId,
  });
}

async function handleTurnStart(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  composed: ComposedCascadeInfo | undefined;
  codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    composed,
    codexRuntimeConfig,
    previous,
  } = input;
  const plan = planTurnStartCascadeApply({
    backend: conversation.backend,
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
      return executeCodexTurnStartApply({
        context,
        cascadeKind,
        conversation,
        codexRuntimeConfig,
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

async function executeCodexTurnStartApply(input: {
  context: ApplyContext;
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  codexRuntimeConfig: CodexRuntimeCapabilityConfig | undefined;
  attemptedHash: string;
  attemptedItemIds: readonly string[];
  previous: AgentCapabilityCascadeRuntimeState;
}): Promise<ApplyOneCascadeResult> {
  const {
    context,
    cascadeKind,
    conversation,
    codexRuntimeConfig,
    attemptedHash,
    attemptedItemIds,
    previous,
  } = input;
  const port = context.deps.applyCodexRuntime;
  if (!port || !codexRuntimeConfig) {
    const reason = !port
      ? "codex runtime apply port unavailable"
      : "codex runtime composition missing";
    logger.error("apply.codex_turn_start_unavailable", {
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
        message: `Codex turn-start apply failed: ${sanitizeApplyError(reason)}`,
        backend: "codex",
        cascadeKind,
      },
    };
  }

  let result: CodexApplyPortResult;
  try {
    result = await port({
      conversationId: conversation.conversationId,
      config: codexRuntimeConfig,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const sanitized = sanitizeApplyError(message);
    logger.error("apply.codex_turn_start_failed", {
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
        message: `Codex apply failed: ${sanitizeApplyError(message)}`,
        backend: "codex",
        cascadeKind,
      },
    };
  }

  if (result.status === "rejected") {
    const sanitized = sanitizeApplyError(result.error);
    logger.error("apply.codex_turn_start_rejected", {
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
        message: `Codex apply rejected: ${sanitizeApplyError(result.error)}`,
        backend: "codex",
        cascadeKind,
      },
    };
  }

  logger.info("apply.codex_turn_start_succeeded", {
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
