/**
 * Capability runtime apply service.
 *
 * Orchestrates the three lifecycle events that move a conversation's
 * per-cascade runtime apply state forward:
 *
 *   1. `applyAfterOverrideChange` — Override mutation just persisted. Fan
 *      out to every active conversation affected by the edited scope/cascade,
 *      compute a fresh runtime composition per conversation, and either live-
 *      apply (idle Claude), stage idle-drain (running Claude), stage next-turn
 *      (Codex), defer to next conversation (Claude sub-agents), or record
 *      unsupported (verification-gated cascades). Never mutates Codex live.
 *   2. `applyWhenConversationBecomesIdle` — Claude conversation transitioned
 *      from running to idle. Drain any cascades stored as `staged-idle`
 *      against the freshly-composed runtime payload through the Claude apply
 *      port. Records `applied` on success or `rejected` with sanitized error
 *      on failure; the previously-applied hash is preserved on failure via
 *      `recordApplyOutcome`. A previous `rejected` record with a preserved
 *      `pendingHash` is also retried here — that is the retry surface for
 *      transient Claude apply failures.
 *   3. `applyAtTurnStart` — A new turn is starting. Promote `staged-next-turn`
 *      entries to `applied` because the backend ingests the fresh options at
 *      turn boundary (Codex rebuilds SDK options per turn; Claude seeded
 *      `staged-next-turn` at session creation). A previous `rejected` Codex
 *      record with a preserved `pendingHash` is retried here — that is the
 *      retry surface for transient Codex apply failures. Deferred-next-
 *      conversation entries are left alone — only a fresh conversation
 *      runtime can apply those. Claude `rejected` records are not retried at
 *      turn-start; they wait for the next idle transition because Claude
 *      cannot be mutated at turn boundary.
 *
 * Failure isolation:
 *   - A discovery or composition failure for one cascade does not affect the
 *     other cascades on the same conversation; the outcome record carries a
 *     diagnostic and that cascade is recorded as `rejected`.
 *   - A live-apply failure for one conversation does not affect other
 *     conversations — each conversation gets its own outcome record.
 *   - The cached pending hash + items are preserved on `rejected` so retries
 *     can proceed without losing the operator's intent.
 *
 * Dependency boundaries: the service takes ports for conversation enumeration,
 * conversation runtime state I/O, fresh composition, and the Claude live-apply
 * adapter. Tests provide synchronous fakes; production wiring injects the real
 * state-store, the runtime registry, and the Claude `QuerySession` adapter.
 */

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

  async function applyWhenConversationBecomesIdle(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome> {
    return applyToConversation({
      context,
      conversation: {
        ...input,
        isTurnActive: false,
      },
      targetCascade: undefined,
      trigger: "idle-drain",
    });
  }

  async function applyAtTurnStart(
    input: ApplyAtConversationInput,
  ): Promise<ConversationApplyOutcome> {
    return applyToConversation({
      context,
      conversation: {
        ...input,
        isTurnActive: false,
      },
      targetCascade: undefined,
      trigger: "turn-start",
    });
  }

  return {
    applyAfterOverrideChange,
    applyWhenConversationBecomesIdle,
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
      claudeRuntimeConfig: composition.claudeRuntime,
      codexRuntimeConfig: composition.codexRuntime
        ? { config: composition.codexRuntime.config }
        : undefined,
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
    await deps.writeRuntimeState({
      ...conversationIdentityForPorts(conversation),
      state: nextState,
    });
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
