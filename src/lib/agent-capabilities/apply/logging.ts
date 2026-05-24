import { createLogger } from "@/lib/logging";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
} from "../schemas";

import type {
  AffectedConversation,
  ApplyTrigger,
  CascadeApplyOutcome,
} from "./helpers";

const logger = createLogger("agent-capabilities.apply.logging");

export function logCascadePlan(input: {
  trigger: ApplyTrigger;
  conversation: AffectedConversation;
  cascadeKind: AgentCapabilityCascadeKind;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  plannedDisposition: string;
  attemptedHash?: string;
  pendingItemCount?: number;
  reason?: string;
  operationId?: string;
}): void {
  logger.info("apply.cascade_planned", {
    trigger: input.trigger,
    cascadeKind: input.cascadeKind,
    conversationId: input.conversation.conversationId,
    backend: input.conversation.backend,
    operationId: input.operationId,
    previousStatus: input.previous?.lastApplyStatus,
    plannedDisposition: input.plannedDisposition,
    attemptedHash: input.attemptedHash,
    pendingItemCount: input.pendingItemCount,
    reason: input.reason,
  });
}

export function logCascadeOutcome(input: {
  trigger: ApplyTrigger;
  conversation: AffectedConversation;
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  outcome: CascadeApplyOutcome;
  operationId?: string;
}): void {
  const fields = {
    trigger: input.trigger,
    cascadeKind: input.outcome.cascadeKind,
    conversationId: input.conversation.conversationId,
    backend: input.conversation.backend,
    operationId: input.operationId,
    previousStatus: input.previous?.lastApplyStatus,
    disposition: input.outcome.disposition,
    attemptedHash: input.outcome.attemptedHash,
    error: input.outcome.error,
  };

  if (
    input.previous?.lastApplyStatus === "rejected" &&
    input.outcome.disposition === "applied"
  ) {
    logger.info("apply.retry_recovered", fields);
  }
  if (
    input.previous?.lastApplyStatus === "rejected" &&
    input.outcome.disposition === "rejected"
  ) {
    logger.error("apply.retry_failed", fields);
  }

  if (input.outcome.disposition === "rejected") {
    logger.error("apply.cascade_outcome", fields);
    return;
  }
  if (input.outcome.disposition === "unsupported") {
    logger.warn("apply.cascade_outcome", fields);
    return;
  }
  logger.info("apply.cascade_outcome", fields);
}
