/**
 * Pre-turn step: agent-capability cascade composition, seeding, and apply.
 *
 * Hides the scope decision for capability config around a turn: project
 * conversations compose from the project composer (fixed backend, no session
 * layer) with non-blocking diagnostics, session conversations compose from
 * the full cascade; a project seed composed for a different backend is
 * dropped with a warning rather than switching the conversation's backend.
 * Also owns persisting the runtime seed baseline and the turn-start /
 * idle-drain apply calls.
 */

import { createLogger } from "@/lib/logging";
import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { backendHasIdleLiveCapability } from "@/lib/agent-backends/conversation-policy";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation-actor");

export type CapabilitySeed =
  import("@/lib/agent-capabilities/default-deps").ComposedCapabilitySeed;
export type ProjectCapabilitySeed =
  import("@/lib/agent-capabilities/default-deps").ComposedProjectConversationCapabilitySeed;
export type RuntimeProjectCapabilitySeed = Exclude<
  ProjectCapabilitySeed,
  { kind: "diagnostics-only" }
>;

export function isRuntimeProjectCapabilitySeed(
  seed: ProjectCapabilitySeed | undefined,
): seed is RuntimeProjectCapabilitySeed {
  return seed !== undefined && seed.kind !== "diagnostics-only";
}

export interface CapabilityCascadeDeps {
  applyCapabilityAtTurnStart(
    input: ApplyConversationIdentity,
  ): Promise<unknown>;
  applyCapabilityWhenIdle(input: ApplyConversationIdentity): Promise<unknown>;
  composeCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<CapabilitySeed | undefined>;
  composeCapabilityConfigForProjectConversation(input: {
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<ProjectCapabilitySeed | undefined>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
}

export interface CapabilityTurnContext {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
  isProjectConversation: boolean;
  /** Non-blocking error surface toward the live prompt stream. */
  emitStreamError(message: string): void;
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

function emitProjectCapabilityDiagnostics(
  ctx: CapabilityTurnContext,
  diagnostics: readonly AgentCapabilityDiagnostic[] | undefined,
): void {
  if (!diagnostics || diagnostics.length === 0) return;

  for (const diagnostic of diagnostics) {
    logger.warn("prompt.project_conversation_capability_diagnostic", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      conversationScope: "project",
      backend: diagnostic.backend ?? ctx.backend,
      cascadeKind: diagnostic.cascadeKind,
      code: diagnostic.code,
      severity: diagnostic.severity,
      conversationId: ctx.conversationId,
      message: diagnostic.message,
    });
    ctx.emitStreamError(
      `Project conversation capability configuration issue: ${diagnostic.message}`,
    );
  }
}

async function composeProjectConversationCapabilitySeed(
  deps: Pick<
    CapabilityCascadeDeps,
    "composeCapabilityConfigForProjectConversation"
  >,
  ctx: CapabilityTurnContext,
): Promise<ProjectCapabilitySeed | undefined> {
  try {
    return await deps.composeCapabilityConfigForProjectConversation({
      projectPath: ctx.projectPath,
      projectName: ctx.projectName,
      conversationId: ctx.conversationId,
    });
  } catch (err) {
    const error = getErrorMessage(err);
    logger.warn("prompt.project_conversation_capability_compose_failed", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      conversationScope: "project",
      backend: ctx.backend,
      conversationId: ctx.conversationId,
      error,
    });
    ctx.emitStreamError(
      `Project conversation capability configuration could not be fully composed: ${error}`,
    );
    return undefined;
  }
}

/**
 * Compose the capability seed a new runtime is created with: a project seed
 * for a matching backend, else the session cascade for session conversations.
 * Project diagnostics are surfaced non-blocking; a project seed composed for
 * a different backend never switches the conversation's backend.
 */
export async function resolveCapabilitySeedForNewRuntime(
  deps: Pick<
    CapabilityCascadeDeps,
    | "composeCapabilityConfigForConversation"
    | "composeCapabilityConfigForProjectConversation"
  >,
  ctx: CapabilityTurnContext,
): Promise<CapabilitySeed | RuntimeProjectCapabilitySeed | undefined> {
  const projectCapabilitySeed = ctx.isProjectConversation
    ? await composeProjectConversationCapabilitySeed(deps, ctx)
    : undefined;
  emitProjectCapabilityDiagnostics(ctx, projectCapabilitySeed?.diagnostics);
  const projectRuntimeCapabilitySeed = isRuntimeProjectCapabilitySeed(
    projectCapabilitySeed,
  )
    ? projectCapabilitySeed
    : undefined;

  const capabilitySeed =
    projectRuntimeCapabilitySeed !== undefined &&
    projectRuntimeCapabilitySeed.backend === ctx.backend
      ? projectRuntimeCapabilitySeed
      : !ctx.isProjectConversation
        ? await deps.composeCapabilityConfigForConversation({
            projectPath: ctx.projectPath,
            projectName: ctx.projectName,
            sessionName: ctx.sessionName,
            conversationId: ctx.conversationId,
            worktreePath: ctx.worktreePath,
            backend: ctx.backend,
          })
        : undefined;

  if (projectCapabilitySeed && projectCapabilitySeed.backend !== ctx.backend) {
    logger.warn("prompt.project_conversation_capability_backend_mismatch", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      conversationScope: "project",
      conversationId: ctx.conversationId,
      actorBackend: ctx.backend,
      composedBackend: projectCapabilitySeed.backend,
    });
  }

  return capabilitySeed;
}

/**
 * Persist the runtime seed baseline so the apply service can compare
 * subsequent mutations against the state the runtime was seeded with.
 */
export async function seedRuntimeCapabilityState(
  deps: Pick<CapabilityCascadeDeps, "mutateConversation">,
  ctx: Pick<
    CapabilityTurnContext,
    "projectPath" | "sessionName" | "conversationId" | "backend"
  >,
  seed: AgentCapabilityRuntimeApplicationState,
): Promise<void> {
  await deps.mutateConversation(
    ctx.projectPath,
    ctx.sessionName,
    ctx.conversationId,
    "prompt.seedCapabilityRuntime",
    (conversation) => {
      conversation.agentCapabilitiesRuntime = seed;
    },
  );
  logger.info("prompt.capability_runtime_seeded", {
    ...scopeRefFromStoreSessionName(ctx.sessionName),
    backend: ctx.backend,
    conversationId: ctx.conversationId,
    seededCascadeKinds: Object.keys(seed.cascades),
  });
}

/**
 * Promote any seeded `staged-next-turn` cascades at the start of a turn.
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

/**
 * Drain any `staged-idle` capability cascades after a turn completes and the
 * conversation transitions running → idle. No-op for backends without
 * idle-live-apply semantics. Failures are logged, never rethrown.
 */
export async function drainCapabilityWhenIdle(
  deps: Pick<CapabilityCascadeDeps, "applyCapabilityWhenIdle">,
  ctx: CapabilityTurnContext,
): Promise<void> {
  if (!backendHasIdleLiveCapability(ctx.backend)) return;

  try {
    await deps.applyCapabilityWhenIdle(buildCapabilityApplyInput(ctx));
  } catch (err) {
    logger.error("prompt.capability_idle_drain_failed", {
      ...scopeRefFromStoreSessionName(ctx.sessionName),
      conversationId: ctx.conversationId,
      error: getErrorMessage(err),
    });
  }
}
