/**
 * Pre-turn step: persisting a runtime's capability seed baseline and the
 * turn-start delivery of pending capability changes.
 */

import { createLogger } from "@/lib/logging";
import type { AgentCapabilityRuntimeApplicationState } from "@/lib/agent-capabilities/schemas";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import { getErrorMessage } from "@/lib/shared/errors";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { CapabilityTurnContext } from "@/lib/conversation-core/contributions/capability-cascade";
import type { ConversationPolicyState } from "@/lib/workflows/conversation/policy-state";

const logger = createLogger("conversation-actor");

export interface CapabilityCascadeDeps {
  applyCapabilityAtTurnStart(
    input: ApplyConversationIdentity,
  ): Promise<unknown>;
  state: ConversationPolicyState;
}

/**
 * Build the capability-apply identity for the turn: project conversations are
 * session-less and address the project scope directly.
 */
export function buildCapabilityApplyInput(
  ctx: Pick<
    CapabilityTurnContext,
    | "projectPath"
    | "projectName"
    | "sessionName"
    | "conversationId"
    | "worktreePath"
    | "backend"
    | "isProjectConversation"
  >,
): ApplyConversationIdentity {
  if (ctx.isProjectConversation) {
    return {
      conversationScope: "project",
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      conversationId: ctx.conversationId,
      worktreePath: ctx.worktreePath,
      backend: ctx.backend,
    };
  }
  return {
    projectPath: ctx.projectPath,
    projectName: ctx.projectName,
    sessionName: ctx.sessionName,
    conversationId: ctx.conversationId,
    worktreePath: ctx.worktreePath,
    backend: ctx.backend,
  };
}

/**
 * Persist the runtime seed baseline so the apply service can compare
 * subsequent mutations against the state the runtime was seeded with.
 */
export async function seedRuntimeCapabilityState(
  deps: Pick<CapabilityCascadeDeps, "state">,
  ctx: CapabilityTurnContext,
  seed: AgentCapabilityRuntimeApplicationState,
): Promise<void> {
  await deps.state.updateCapabilities(
    buildCapabilityApplyInput(ctx),
    () => seed,
  );
  logger.info("prompt.capability_runtime_seeded", {
    ...scopeRefFromStoreSessionName(ctx.sessionName),
    backend: ctx.backend,
    conversationId: ctx.conversationId,
    seededCascadeKinds: Object.keys(seed.cascades),
  });
}

/**
 * Attempt delivery of pending capability changes at the start of a turn.
 * Failures never block the turn: they are logged and the turn proceeds.
 */
export async function applyCapabilityCascadeAtTurnStart(
  deps: Pick<CapabilityCascadeDeps, "applyCapabilityAtTurnStart">,
  ctx: CapabilityTurnContext,
  extra: { isNewRuntime: boolean },
): Promise<void> {
  try {
    logger.info("prompt.capability_turn_start_apply", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      backend: ctx.backend,
      conversationId: ctx.conversationId,
      isNewRuntime: extra.isNewRuntime,
    });
    await deps.applyCapabilityAtTurnStart(buildCapabilityApplyInput(ctx));
  } catch (err) {
    logger.error("prompt.capability_turn_start_failed", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      backend: ctx.backend,
      conversationId: ctx.conversationId,
      error: getErrorMessage(err),
    });
  }
}
