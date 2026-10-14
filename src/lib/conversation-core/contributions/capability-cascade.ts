/**
 * Pre-turn step: the agent-capability seed a new runtime is created with.
 *
 * Hides the scope decision for capability config: project conversations
 * compose from the project composer (fixed backend, no session layer) with
 * non-blocking diagnostics, session conversations compose from the full
 * cascade; a project seed composed for a different backend is dropped with a
 * warning rather than switching the conversation's backend.
 */

import { createLogger } from "@/lib/logging";
import type { AgentCapabilityDiagnostic } from "@/lib/agent-capabilities/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation-actor");

export type CapabilitySeed =
  import("@/lib/agent-capabilities/runtime-seed").ComposedCapabilitySeed;
export type ProjectCapabilitySeed =
  import("@/lib/agent-capabilities/runtime-seed").ComposedProjectConversationCapabilitySeed;
export type RuntimeProjectCapabilitySeed = Exclude<
  ProjectCapabilitySeed,
  { kind: "diagnostics-only" }
>;

export function isRuntimeProjectCapabilitySeed(
  seed: ProjectCapabilitySeed | undefined,
): seed is RuntimeProjectCapabilitySeed {
  return seed !== undefined && seed.kind !== "diagnostics-only";
}

/** The two capability composers a new runtime's seed comes from. */
export interface CapabilitySeedComposers {
  composeCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<CapabilitySeed | undefined>;
  composeCapabilityConfigForProjectConversation(input: {
    backend: AgentBackendId;
    worktreePath: string;
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<ProjectCapabilitySeed | undefined>;
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
    CapabilitySeedComposers,
    "composeCapabilityConfigForProjectConversation"
  >,
  ctx: CapabilityTurnContext,
): Promise<ProjectCapabilitySeed | undefined> {
  try {
    return await deps.composeCapabilityConfigForProjectConversation({
      backend: ctx.backend,
      worktreePath: ctx.worktreePath,
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
  deps: CapabilitySeedComposers,
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
