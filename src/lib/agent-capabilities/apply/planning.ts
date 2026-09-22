/** Save preferences immediately; attempt supported delivery at the next turn boundary. */

import { createLogger } from "@/lib/logging";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import { defaultAgentCapabilityMetadataRegistry } from "../metadata";
import { computeCascadeRuntimeHash } from "../runtime-hashes";
import type { ComposeConversationStartResult } from "../runtime-composer";

import {
  conversationIdentityForPorts,
  conversationOutcomeIdentity,
  conversationScopeOf,
  mutated,
  mergeRuntimeOutcomes,
  type AffectedConversation,
  type ApplyAfterMutationInput,
  type ApplyAfterMutationResult,
  type ApplyAtConversationInput,
  type ApplyContext,
  type ApplyServiceDeps,
  type ApplyTrigger,
  type CapabilityRuntimeApplyService,
  type CascadeApplyOutcome,
  type ComposedCascadeInfo,
  type ConversationApplyOutcome,
} from "./helpers";
import { applyOneCascade } from "./cascade";
import { logCascadeOutcome } from "./logging";
import { handleComposeThrow } from "./outcome";

const logger = createLogger("agent-capabilities.apply.planning");

export function createCapabilityRuntimeApplyService(
  deps: ApplyServiceDeps,
): CapabilityRuntimeApplyService {
  const context: ApplyContext = {
    deps,
    metadataRegistry:
      deps.metadataRegistry ?? defaultAgentCapabilityMetadataRegistry,
  };

  async function applyAfterOverrideChange(
    input: ApplyAfterMutationInput,
  ): Promise<ApplyAfterMutationResult> {
    const affected = await deps.listAffectedConversations({
      scope: input.scope,
      cascadeKind: input.cascadeKind,
      changedItemIds: input.changedItemIds,
    });
    logger.info("apply.planned", {
      cascadeKind: input.cascadeKind,
      operationId: input.operationId,
      affectedCount: affected.length,
      changedCount: input.changedItemIds.length,
    });

    const outcomes: ConversationApplyOutcome[] = [];
    for (const conversation of affected) {
      const outcome = await applyToConversation({
        context,
        conversation,
        targetCascade: input.cascadeKind,
        trigger: "after-mutation",
        operationId: input.operationId,
      });
      outcomes.push(outcome);
    }
    return { conversations: outcomes };
  }

  async function applyAtTurnStart(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome> {
    return applyToConversation({
      context,
      conversation: input,
      targetCascade: undefined,
      trigger: "turn-start",
    });
  }

  return {
    applyAfterOverrideChange,
    applyAtTurnStart,
  };
}

async function applyToConversation(input: {
  context: ApplyContext;
  conversation: AffectedConversation;
  targetCascade: AgentCapabilityCascadeKind | undefined;
  trigger: ApplyTrigger;
  operationId?: string;
}): Promise<ConversationApplyOutcome> {
  const { context, conversation, targetCascade, trigger, operationId } = input;
  const { deps } = context;
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  let composition: ComposeConversationStartResult;
  try {
    composition = await deps.composeForConversation(
      conversationIdentityForPorts(conversation),
    );
  } catch (err) {
    return handleComposeThrow({
      context,
      conversation,
      targetCascade,
      trigger,
      operationId,
      error: err,
    });
  }

  diagnostics.push(...composition.diagnostics);

  const existingState = (await deps.readRuntimeState(
    conversationIdentityForPorts(conversation),
  )) ?? { cascades: {} };

  const nextState: AgentCapabilityRuntimeApplicationState = {
    cascades: { ...existingState.cascades },
  };
  const outcomes: CascadeApplyOutcome[] = [];

  const composedCascades = collectComposedCascades(composition);
  const failedCascadeKinds = new Set<AgentCapabilityCascadeKind>(
    composition.failedCascadeKinds,
  );
  const cascadeKindsToProcess = determineCascadesToProcess({
    trigger,
    targetCascade,
    composedCascades,
    existingState,
    failedCascadeKinds,
  });
  logger.info("apply.conversation_planned", {
    trigger,
    projectPath: conversation.projectPath,
    conversationScope: conversationScopeOf(conversation),
    ...("sessionName" in conversation
      ? { sessionName: conversation.sessionName }
      : {}),
    conversationId: conversation.conversationId,
    backend: conversation.backend,
    targetCascade,
    cascadeCount: cascadeKindsToProcess.length,
    cascadeKinds: cascadeKindsToProcess,
    operationId,
  });

  for (const cascadeKind of cascadeKindsToProcess) {
    const previous = nextState.cascades[cascadeKind];
    const result = await applyOneCascade({
      context,
      cascadeKind,
      conversation,
      composedCascades,
      failedCascadeKinds,
      resolved: composition.capabilities,
      previous,
      trigger,
      operationId,
    });
    if (result.nextState !== undefined) {
      nextState.cascades[cascadeKind] = result.nextState;
    } else if (nextState.cascades[cascadeKind] !== undefined) {
      delete nextState.cascades[cascadeKind];
    }
    outcomes.push(result.outcome);
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
    }
    logCascadeOutcome({
      trigger,
      conversation,
      previous,
      outcome: result.outcome,
      operationId,
    });
  }

  if (mutated(existingState, nextState)) {
    await deps.updateRuntimeState(
      conversationIdentityForPorts(conversation),
      (current) => mergeRuntimeOutcomes(current, existingState, nextState),
    );
  }

  return {
    ...conversationOutcomeIdentity(conversation),
    cascades: outcomes,
    diagnostics,
  };
}

function collectComposedCascades(
  composition: ComposeConversationStartResult,
): Map<AgentCapabilityCascadeKind, ComposedCascadeInfo> {
  const out = new Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>();
  // composeConversationStartRuntime already seeded runtimeState for non-
  // verification-gated cascades. Reuse those entries directly so the apply
  // service shares one canonical hash with conversation-start seeding.
  for (const [rawCascadeKind, state] of Object.entries(
    composition.runtimeState.cascades,
  )) {
    const cascadeKind = rawCascadeKind as AgentCapabilityCascadeKind;
    if (!state) continue;
    const attemptedHash =
      state.pendingHash ??
      state.appliedHash ??
      computeCascadeRuntimeHash({ cascadeKind, rows: [] });
    out.set(cascadeKind, {
      cascadeKind,
      attemptedHash,
      attemptedItemIds: state.pendingItemIds ?? [],
    });
  }
  return out;
}

function determineCascadesToProcess(input: {
  trigger: ApplyTrigger;
  targetCascade: AgentCapabilityCascadeKind | undefined;
  composedCascades: Map<AgentCapabilityCascadeKind, ComposedCascadeInfo>;
  existingState: AgentCapabilityRuntimeApplicationState;
  failedCascadeKinds: ReadonlySet<AgentCapabilityCascadeKind>;
}): readonly AgentCapabilityCascadeKind[] {
  if (input.trigger === "after-mutation" && input.targetCascade) {
    return [input.targetCascade];
  }
  const kinds = new Set<AgentCapabilityCascadeKind>();
  for (const kind of input.composedCascades.keys()) kinds.add(kind);
  for (const kind of input.failedCascadeKinds) kinds.add(kind);
  for (const rawKind of Object.keys(input.existingState.cascades)) {
    kinds.add(rawKind as AgentCapabilityCascadeKind);
  }
  return [...kinds];
}
