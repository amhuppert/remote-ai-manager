import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import {
  planCascadeFailure,
  planMissingTargetCascadeAfterMutation,
} from "../apply-planner";
import { recordApplyOutcome, sanitizeApplyError } from "../runtime-hashes";
import type { AgentCapabilityMetadataRegistry } from "../metadata";

import {
  composeFailureDiagnostic,
  conversationIdentityForPorts,
  conversationOutcomeIdentity,
  conversationScopeOf,
  mutated,
  verificationGatedDiagnostic,
  type AffectedConversation,
  type ApplyContext,
  type ApplyOneCascadeResult,
  type ApplyTrigger,
  type CascadeApplyOutcome,
  type ConversationApplyOutcome,
} from "./helpers";
import { logCascadeOutcome, logCascadePlan } from "./logging";

const logger = createLogger("agent-capabilities.apply.outcome");

export function rejectForDiscoveryFailure(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  metadata: ReturnType<AgentCapabilityMetadataRegistry["get"]>;
}): ApplyOneCascadeResult {
  const { cascadeKind, conversation, previous, metadata } = input;
  const plan = planCascadeFailure({
    metadata,
    previous,
    failureKind: "failed-discovery",
  });

  if (plan.disposition === "unsupported") {
    return unsupportedVerificationGatedResult({
      cascadeKind,
      conversation,
      previous,
    });
  }

  const reason =
    "Upstream capability discovery failed for this cascade; recomposition was skipped";
  const sanitized = sanitizeApplyError(reason);
  logger.error("apply.discovery_failed", {
    cascadeKind,
    conversationId: conversation.conversationId,
    backend: conversation.backend,
  });
  return {
    outcome: {
      cascadeKind,
      disposition: "rejected",
      attemptedHash: plan.attemptedHash,
      error: sanitized,
    },
    nextState: recordApplyOutcome({
      previous,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
      outcome: { status: "rejected", error: reason },
    }),
    diagnostic: {
      severity: "error",
      code: "agent-capability-apply-failed",
      message: `Capability recomposition failed: ${sanitized}`,
      backend: conversation.backend,
      cascadeKind,
    },
  };
}

export function unsupportedVerificationGatedResult(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
}): ApplyOneCascadeResult {
  return {
    outcome: {
      cascadeKind: input.cascadeKind,
      disposition: "unsupported",
    },
    nextState: input.previous,
    diagnostic: verificationGatedDiagnostic({
      conversation: input.conversation,
      cascadeKind: input.cascadeKind,
    }),
  };
}

export function handleMissingTargetCascadeAfterMutation(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  conversation: AffectedConversation;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  metadata: ReturnType<AgentCapabilityMetadataRegistry["get"]>;
  operationId?: string;
}): ApplyOneCascadeResult {
  const { cascadeKind, conversation, previous, metadata, operationId } = input;
  const plan = planMissingTargetCascadeAfterMutation({
    metadata,
    previous,
  });
  logCascadePlan({
    trigger: "after-mutation",
    conversation,
    cascadeKind,
    previous,
    plannedDisposition: plan.disposition,
    attemptedHash:
      plan.disposition === "rejected" ? plan.attemptedHash : undefined,
    pendingItemCount:
      plan.disposition === "rejected"
        ? plan.attemptedItemIds.length
        : undefined,
    reason: plan.disposition === "rejected" ? plan.reason : undefined,
    operationId,
  });

  if (plan.disposition === "unsupported") {
    return {
      outcome: { cascadeKind, disposition: "unsupported" },
      nextState: previous,
    };
  }

  const reason = "Runtime composition did not emit the mutated target cascade";
  const sanitized = sanitizeApplyError(reason);
  logger.error("apply.missing_target_cascade", {
    cascadeKind,
    conversationId: conversation.conversationId,
    backend: conversation.backend,
    operationId,
  });
  return {
    outcome: {
      cascadeKind,
      disposition: "rejected",
      attemptedHash: plan.attemptedHash,
      error: sanitized,
    },
    nextState: recordApplyOutcome({
      previous,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
      outcome: { status: "rejected", error: reason },
    }),
    diagnostic: {
      severity: "error",
      code: "agent-capability-apply-failed",
      message: `Capability recomposition failed: ${sanitized}`,
      backend: conversation.backend,
      cascadeKind,
    },
  };
}

export async function handleComposeThrow(input: {
  context: ApplyContext;
  conversation: AffectedConversation;
  targetCascade: AgentCapabilityCascadeKind | undefined;
  trigger: ApplyTrigger;
  operationId?: string;
  error: unknown;
}): Promise<ConversationApplyOutcome> {
  const { context, conversation, targetCascade, trigger, operationId, error } =
    input;
  const rawMessage = getErrorMessage(error);
  const sanitized = sanitizeApplyError(rawMessage);
  logger.error("apply.compose_failed", {
    projectPath: conversation.projectPath,
    conversationScope: conversationScopeOf(conversation),
    ...("sessionName" in conversation
      ? { sessionName: conversation.sessionName }
      : {}),
    conversationId: conversation.conversationId,
    backend: conversation.backend,
    trigger,
    operationId,
    error: sanitized,
  });

  if (trigger === "after-mutation") {
    if (targetCascade === undefined) {
      return {
        ...conversationOutcomeIdentity(conversation),
        cascades: [],
        diagnostics: [composeFailureDiagnostic({ conversation, sanitized })],
      };
    }
    return persistTargetComposeFailure({
      context,
      conversation,
      targetCascade,
      rawMessage,
      sanitized,
    });
  }

  return persistLifecycleComposeFailure({
    context,
    conversation,
    trigger,
    rawMessage,
    sanitized,
  });
}

function isPendingForLifecycleComposeFailure(input: {
  trigger: "idle-drain" | "turn-start";
  conversation: AffectedConversation;
  previous: AgentCapabilityCascadeRuntimeState;
}): boolean {
  const { trigger, conversation, previous } = input;
  if (previous.pendingHash === undefined) return false;
  if (trigger === "idle-drain") {
    return (
      previous.lastApplyStatus === "staged-idle" ||
      previous.lastApplyStatus === "rejected"
    );
  }
  if (previous.lastApplyStatus === "staged-next-turn") return true;
  return (
    conversation.backend === "codex" && previous.lastApplyStatus === "rejected"
  );
}

async function persistLifecycleComposeFailure(input: {
  context: ApplyContext;
  conversation: AffectedConversation;
  trigger: "idle-drain" | "turn-start";
  rawMessage: string;
  sanitized: string;
}): Promise<ConversationApplyOutcome> {
  const { context, conversation, trigger, rawMessage, sanitized } = input;
  const { deps, metadataRegistry } = context;
  const existingState = (await deps.readRuntimeState(
    conversationIdentityForPorts(conversation),
  )) ?? { cascades: {} };

  const nextState: AgentCapabilityRuntimeApplicationState = {
    cascades: { ...existingState.cascades },
  };
  const cascades: CascadeApplyOutcome[] = [];
  const diagnostics: AgentCapabilityDiagnostic[] = [];

  for (const [rawKind, previous] of Object.entries(existingState.cascades)) {
    if (!previous) continue;
    const cascadeKind = rawKind as AgentCapabilityCascadeKind;
    const metadata = metadataRegistry.get(cascadeKind);
    if (metadata.backend !== conversation.backend) continue;
    if (
      !isPendingForLifecycleComposeFailure({
        trigger,
        conversation,
        previous,
      })
    ) {
      continue;
    }

    if (metadata.compositionSupport === "verification-gated") {
      const outcome: CascadeApplyOutcome = {
        cascadeKind,
        disposition: "unsupported",
      };
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "unsupported",
      });
      cascades.push(outcome);
      diagnostics.push(
        verificationGatedDiagnostic({ conversation, cascadeKind }),
      );
      logCascadeOutcome({ trigger, conversation, previous, outcome });
      continue;
    }

    const plan = planCascadeFailure({
      metadata,
      previous,
      failureKind: "compose-throw",
    });
    if (plan.disposition === "unsupported") {
      const outcome: CascadeApplyOutcome = {
        cascadeKind,
        disposition: "unsupported",
      };
      logCascadePlan({
        trigger,
        conversation,
        cascadeKind,
        previous,
        plannedDisposition: "unsupported",
      });
      cascades.push(outcome);
      diagnostics.push(
        verificationGatedDiagnostic({ conversation, cascadeKind }),
      );
      logCascadeOutcome({ trigger, conversation, previous, outcome });
      continue;
    }

    nextState.cascades[cascadeKind] = recordApplyOutcome({
      previous,
      attemptedHash: plan.attemptedHash,
      attemptedItemIds: plan.attemptedItemIds,
      outcome: { status: "rejected", error: rawMessage },
    });
    const outcome: CascadeApplyOutcome = {
      cascadeKind,
      disposition: "rejected",
      attemptedHash: plan.attemptedHash,
      error: sanitized,
    };
    logCascadePlan({
      trigger,
      conversation,
      cascadeKind,
      previous,
      plannedDisposition: "rejected",
      attemptedHash: plan.attemptedHash,
      pendingItemCount: plan.attemptedItemIds.length,
      reason: plan.reason,
    });
    cascades.push(outcome);
    diagnostics.push(
      composeFailureDiagnostic({ conversation, sanitized, cascadeKind }),
    );
    logCascadeOutcome({ trigger, conversation, previous, outcome });
    logger.error("apply.lifecycle_compose_failure_persisted", {
      trigger,
      conversationScope: conversationScopeOf(conversation),
      cascadeKind,
      conversationId: conversation.conversationId,
      backend: conversation.backend,
      attemptedHash: plan.attemptedHash,
      pendingItemCount: plan.attemptedItemIds.length,
      error: sanitized,
    });
  }

  if (cascades.length === 0) {
    return {
      ...conversationOutcomeIdentity(conversation),
      cascades: [],
      diagnostics: [composeFailureDiagnostic({ conversation, sanitized })],
    };
  }

  if (mutated(existingState, nextState)) {
    await deps.writeRuntimeState({
      ...conversationIdentityForPorts(conversation),
      state: nextState,
    });
  }

  return {
    ...conversationOutcomeIdentity(conversation),
    cascades,
    diagnostics,
  };
}

async function persistTargetComposeFailure(input: {
  context: ApplyContext;
  conversation: AffectedConversation;
  targetCascade: AgentCapabilityCascadeKind;
  rawMessage: string;
  sanitized: string;
}): Promise<ConversationApplyOutcome> {
  const { context, conversation, targetCascade, rawMessage, sanitized } = input;
  const { deps, metadataRegistry } = context;
  const diagnostics: AgentCapabilityDiagnostic[] = [
    composeFailureDiagnostic({
      conversation,
      sanitized,
      cascadeKind: targetCascade,
    }),
  ];

  const metadata = metadataRegistry.get(targetCascade);
  if (metadata.backend !== conversation.backend) {
    logCascadePlan({
      trigger: "after-mutation",
      conversation,
      cascadeKind: targetCascade,
      previous: undefined,
      plannedDisposition: "unsupported",
    });
    logCascadeOutcome({
      trigger: "after-mutation",
      conversation,
      previous: undefined,
      outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
    });
    return {
      ...conversationOutcomeIdentity(conversation),
      cascades: [
        {
          cascadeKind: targetCascade,
          disposition: "unsupported",
        },
      ],
      diagnostics,
    };
  }

  const unsupportedPlan = planCascadeFailure({
    metadata,
    previous: undefined,
    failureKind: "compose-throw",
  });
  if (unsupportedPlan.disposition === "unsupported") {
    logCascadePlan({
      trigger: "after-mutation",
      conversation,
      cascadeKind: targetCascade,
      previous: undefined,
      plannedDisposition: "unsupported",
    });
    logCascadeOutcome({
      trigger: "after-mutation",
      conversation,
      previous: undefined,
      outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
    });
    return {
      ...conversationOutcomeIdentity(conversation),
      cascades: [
        {
          cascadeKind: targetCascade,
          disposition: "unsupported",
        },
      ],
      diagnostics: [
        verificationGatedDiagnostic({
          conversation,
          cascadeKind: targetCascade,
        }),
      ],
    };
  }

  const existingState = (await deps.readRuntimeState(
    conversationIdentityForPorts(conversation),
  )) ?? { cascades: {} };
  const previous = existingState.cascades[targetCascade];
  const plan = planCascadeFailure({
    metadata,
    previous,
    failureKind: "compose-throw",
  });
  if (plan.disposition === "unsupported") {
    logCascadePlan({
      trigger: "after-mutation",
      conversation,
      cascadeKind: targetCascade,
      previous,
      plannedDisposition: "unsupported",
    });
    logCascadeOutcome({
      trigger: "after-mutation",
      conversation,
      previous,
      outcome: { cascadeKind: targetCascade, disposition: "unsupported" },
    });
    return {
      ...conversationOutcomeIdentity(conversation),
      cascades: [
        {
          cascadeKind: targetCascade,
          disposition: "unsupported",
        },
      ],
      diagnostics: [
        verificationGatedDiagnostic({
          conversation,
          cascadeKind: targetCascade,
        }),
      ],
    };
  }

  const nextCascadeState = recordApplyOutcome({
    previous,
    attemptedHash: plan.attemptedHash,
    attemptedItemIds: plan.attemptedItemIds,
    outcome: { status: "rejected", error: rawMessage },
  });
  const nextState: AgentCapabilityRuntimeApplicationState = {
    cascades: {
      ...existingState.cascades,
      [targetCascade]: nextCascadeState,
    },
  };
  if (previous !== nextCascadeState) {
    await deps.writeRuntimeState({
      ...conversationIdentityForPorts(conversation),
      state: nextState,
    });
  }

  const outcome: CascadeApplyOutcome = {
    cascadeKind: targetCascade,
    disposition: "rejected",
    attemptedHash: plan.attemptedHash,
    error: sanitized,
  };
  logCascadePlan({
    trigger: "after-mutation",
    conversation,
    cascadeKind: targetCascade,
    previous,
    plannedDisposition: "rejected",
    attemptedHash: plan.attemptedHash,
    pendingItemCount: plan.attemptedItemIds.length,
    reason: plan.reason,
  });
  logCascadeOutcome({
    trigger: "after-mutation",
    conversation,
    previous,
    outcome,
  });

  return {
    ...conversationOutcomeIdentity(conversation),
    cascades: [outcome],
    diagnostics,
  };
}
