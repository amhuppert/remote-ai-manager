/**
 * Prompt execution facade: resolves the conversation and sends its prompt
 * through the shared conversation core.
 */
import type { PromptStreamResult } from "@/lib/conversation-core/turn/turn-result";
import {
  coreCollaborationRefusal,
  sendCorePrompt,
  type CoreCollaborationRequest,
  type CoreConversationPromptDeps,
  type CorePromptOutcome,
  type CorePromptSend,
  type CorePromptMessage,
  type PromptRefusal,
} from "@/lib/conversation-core/prompt-route";
import {
  adoptCoreConversationBackend,
  composedSupervision,
  coreOwnsConversation,
} from "@/lib/supervision/handles";
import { commandAdmissionRefusal } from "@/lib/commands/route-admission";
import type { Logger } from "@/lib/logging";
import { clearConversationPendingPromptTextIfMatches } from "@/lib/state-store";

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import type { CollaborationAutonomousResolutionThreshold } from "@/lib/workflows/collaboration/schemas";
import type { CollaborationAgentTwoRequest } from "@/lib/workflows/collaboration/types";

import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";

import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";

import { dispatchConversationCommand as defaultDispatchConversationCommand } from "@/lib/conversation-commands/dispatch";
import { createLogger } from "@/lib/logging";
import {
  hasCollabPrefix,
  stripCollabPrefix,
} from "@/lib/conversation-commands/parse";

import {
  scopeRefFromStoreSessionName,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";
import {
  getConversation,
  createConversation,
  setConversationBackend,
} from "@/lib/conversations/service";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { readConfig } from "@/lib/config/loader";
import { getConversationBackendFactory } from "@/lib/agent-backends/registry";
import {
  admitExplicitModelSelection,
  ModelSelectionValidationError,
} from "@/lib/agent-backends/model-selection-admission";

const logger = createLogger("prompt");

// ============================================================
// Dependency Injection (simplified — facade only needs conversation CRUD)
// ============================================================

export interface PromptDeps {
  /** The conversation core admits and runs every executable conversation. */
  core: {
    owns(conversationId: string): boolean;
    send(input: CorePromptSend): Promise<CorePromptOutcome>;
    /** Why `/collab` cannot claim the conversation now, its backend adopted when it can; null when it may. */
    collaborationRefusal(
      input: CoreCollaborationRequest,
    ): Promise<PromptRefusal | null>;
  };
  getConversation: typeof getConversation;
  createConversation: typeof createConversation;
  setConversationBackend: typeof setConversationBackend;
  getProjectDisplayName: typeof getProjectDisplayName;
  readConfig: typeof readConfig;
  getConversationBackendFactory: typeof getConversationBackendFactory;

  /**
   * Dispatches a `/collab` prompt to the collaboration manager.
   *
   * `executePromptStream` calls this when it detects a /collab prefix instead
   * of running the normal conversation-turn flow. The dispatcher is responsible
   * for persisting the user's prompt to the conversation transcript and
   * starting the collaboration workflow. Returns the workflowId so the caller
   * can emit a `collab-started` SSE event.
   */
  dispatchCollabStart?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    brief: string;
    negotiationRounds?: number;
    autonomousResolutionThreshold?: CollaborationAutonomousResolutionThreshold;
    modelSelection?: BackendModelSelection;
    agentTwo?: CollaborationAgentTwoRequest;
    images?: ImagePayload[];
  }): Promise<{ workflowId: string }>;

  /**
   * Dispatches a `/commit` or `/merge` conversation command to the command
   * service. `executePromptStream` calls this when `parseConversationCommand`
   * matches, instead of running the normal conversation-turn flow. The dispatcher
   * is responsible for persisting the user's command message (`rawText`) to
   * the conversation transcript and running the command service to completion
   * — the route awaits the returned promise.
   */
  dispatchConversationCommand?(
    input: ConversationCommandDispatchInput,
  ): Promise<RunCommandOutcome>;
}

let _defaultPromptDeps: PromptDeps | null = null;

const DEFAULT_NEGOTIATION_ROUNDS = 3;
const DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD: CollaborationAutonomousResolutionThreshold =
  "major";

/**
 * The core's prompt deps over the composed run supervision: one composition
 * for the routes that address a conversation and this server-side entry.
 */
export function productionCorePromptDeps(
  log: Pick<Logger, "info" | "warn">,
): CoreConversationPromptDeps {
  const core = () => {
    const supervision = composedSupervision();
    if (supervision === undefined)
      throw new Error("Run supervision is not running");
    return supervision.core;
  };
  return {
    sendUserMessage: (message) => core().sendUserMessage(message),
    admission: (conversationId, turn) => core().admission(conversationId, turn),
    adoptBackend: adoptCoreConversationBackend,
    clearPendingPromptText: clearConversationPendingPromptTextIfMatches,
    dispatchCommand: defaultDispatchConversationCommand,
    commandRefusal: commandAdmissionRefusal,
    async admitCommandModel({ projectPath, backend, selection }) {
      try {
        return {
          ok: true,
          selection: await admitExplicitModelSelection({
            projectPath,
            backend,
            selection,
            factory: getConversationBackendFactory(backend),
          }),
        };
      } catch (error) {
        if (!(error instanceof ModelSelectionValidationError)) throw error;
        return {
          ok: false,
          refusal: {
            status: error.statusCode,
            body: { error: error.message, code: error.code },
          },
        };
      }
    },
    log,
  };
}

async function getDefaultPromptDeps(): Promise<PromptDeps> {
  if (_defaultPromptDeps) return _defaultPromptDeps;
  const collabModule = await import("@/lib/workflows/collaboration/manager");
  _defaultPromptDeps = {
    core: {
      owns: coreOwnsConversation,
      send: (input) => sendCorePrompt(productionCorePromptDeps(logger), input),
      collaborationRefusal: (input) =>
        coreCollaborationRefusal(productionCorePromptDeps(logger), input),
    },
    getConversation,
    createConversation,
    setConversationBackend,
    getProjectDisplayName,
    readConfig,
    getConversationBackendFactory,
    async dispatchCollabStart(input) {
      const collabManager = collabModule.getDefaultCollaborationManager();
      const startInput: Parameters<typeof collabManager.start>[0] = {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        brief: input.brief,
        negotiationRounds:
          input.negotiationRounds ?? DEFAULT_NEGOTIATION_ROUNDS,
        autonomousResolutionThreshold:
          input.autonomousResolutionThreshold ??
          DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD,
        ...(input.modelSelection !== undefined
          ? { modelSelection: input.modelSelection }
          : {}),
        ...(input.agentTwo !== undefined ? { agentTwo: input.agentTwo } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      };
      const result = await collabManager.start(startInput);
      return { workflowId: result.workflowId };
    },
    dispatchConversationCommand: defaultDispatchConversationCommand,
  };
  return _defaultPromptDeps;
}

/**
 * Create a prompt executor with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createPromptExecutor(deps: PromptDeps) {
  return {
    executePromptStream: (
      projectPath: string,
      session: SessionState,
      promptText: string,
      emit: (event: string, data: unknown) => void,
      conversationId?: string,
      modelSelection?: BackendModelSelection,
      images?: ImagePayload[],
      options?: PromptStreamOptions,
    ) =>
      executePromptStream(
        projectPath,
        session,
        promptText,
        emit,
        conversationId,
        modelSelection,
        images,
        options,
        deps,
      ),
  };
}

export interface PromptStreamOptions extends Pick<
  CorePromptMessage,
  | "backend"
  | "autonomous"
  | "inputOrigin"
  | "documentFeedback"
  | "notepadFeedback"
> {
  /** Runs only after the core accepts the submitted prompt. */
  onAccepted?: () => void | Promise<void>;
  profile?: AgentProfileRef;
  collab?: CollabPromptConfig;
}

async function notifyPromptAccepted(
  options: PromptStreamOptions | undefined,
  scopeRef: ConversationScopeRef,
  conversationId: string,
): Promise<void> {
  if (!options?.onAccepted) return;

  try {
    await options.onAccepted();
  } catch (error) {
    logger.warn("prompt.acceptance_callback_failed", {
      ...scopeRef,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface CollabPromptConfig {
  negotiationRounds?: number;
  autonomousResolutionThreshold?: CollaborationAutonomousResolutionThreshold;
  agentTwo?: CollaborationAgentTwoRequest;
}

export class CollabBriefRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = "COLLAB_BRIEF_REQUIRED";
  constructor() {
    super("/collab prompt must include a brief after the slash command");
    this.name = "CollabBriefRequiredError";
  }
}

export class CollabDispatcherUnavailableError extends Error {
  readonly statusCode = 500;
  readonly code = "COLLAB_DISPATCHER_UNAVAILABLE";
  constructor() {
    super(
      "Collaboration dispatcher is not configured for this prompt executor",
    );
    this.name = "CollabDispatcherUnavailableError";
  }
}

/** Resolves a conversation, then runs its prompt or command through the core. */
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
  conversationId?: string,
  modelSelection?: BackendModelSelection,
  images?: ImagePayload[],
  options?: PromptStreamOptions,
  deps?: PromptDeps,
): Promise<PromptStreamResult> {
  const resolvedDeps = deps ?? (await getDefaultPromptDeps());

  // Diagnostic identity for this prompt (R1.3). The project-conversation entry
  // synthesizes a sentinel `SessionState`, so `session.sessionName` is the
  // internal store key on every project turn — it may address the session-keyed
  // conversation/actor APIs below, but must never be logged as a session.
  const scopeRef = scopeRefFromStoreSessionName(session.sessionName);

  if (conversationId === undefined) {
    const backend =
      options?.backend ??
      (await resolvedDeps.readConfig()).defaultAgentBackend ??
      DEFAULT_AGENT_BACKEND_ID;
    const conversation = await resolvedDeps.createConversation(
      projectPath,
      session.sessionName,
      {
        agentBackend: backend,
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
      },
    );
    conversationId = conversation.id;
  }
  return routeToCore(resolvedDeps, resolvedDeps.core, {
    projectPath,
    session,
    promptText,
    emit,
    conversationId,
    modelSelection,
    images,
    options,
    scopeRef,
  });
}

/** `/collab`: the collaboration manager takes the conversation over and starts from the brief. */
async function startCollaboration(
  resolvedDeps: PromptDeps,
  input: {
    projectPath: string;
    session: SessionState;
    promptText: string;
    emit: (event: string, data: unknown) => void;
    conversationId: string;
    modelSelection: BackendModelSelection | undefined;
    images: ImagePayload[] | undefined;
    options: PromptStreamOptions | undefined;
    scopeRef: ConversationScopeRef;
  },
): Promise<PromptStreamResult> {
  const {
    projectPath,
    session,
    promptText,
    emit,
    conversationId,
    modelSelection,
    images,
    options,
    scopeRef,
  } = input;
  const brief = stripCollabPrefix(promptText).trim();
  if (brief.length === 0) {
    logger.warn("prompt.collab_brief_required", {
      ...scopeRef,
      conversationId,
    });
    throw new CollabBriefRequiredError();
  }
  if (!resolvedDeps.dispatchCollabStart) {
    logger.error("prompt.collab_dispatcher_unavailable", {
      ...scopeRef,
      conversationId,
    });
    throw new CollabDispatcherUnavailableError();
  }
  logger.info("prompt.collab_dispatch", {
    ...scopeRef,
    conversationId,
    briefLength: brief.length,
    imageCount: images?.length ?? 0,
  });
  try {
    const result = await resolvedDeps.dispatchCollabStart({
      projectPath,
      sessionName: session.sessionName,
      conversationId,
      brief,
      ...(options?.collab?.negotiationRounds !== undefined
        ? { negotiationRounds: options.collab.negotiationRounds }
        : {}),
      ...(options?.collab?.autonomousResolutionThreshold !== undefined
        ? {
            autonomousResolutionThreshold:
              options.collab.autonomousResolutionThreshold,
          }
        : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(options?.collab?.agentTwo !== undefined
        ? { agentTwo: options.collab.agentTwo }
        : {}),
      ...(images?.length ? { images } : {}),
    });
    await notifyPromptAccepted(options, scopeRef, conversationId);
    emit("collab-started", {
      workflowId: result.workflowId,
      conversationId,
    });
    emit("done", {});
    return {
      conversationId,
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Collaboration dispatch failed";
    logger.error("prompt.collab_dispatch_failed", {
      ...scopeRef,
      conversationId,
      error: errorMsg,
    });
    emitErrorAndDone(emit, errorMsg);
    return {
      conversationId,
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
      error: errorMsg,
    };
  }
}

/**
 * A prompt to a conversation the core runs: its turn or command there,
 * streamed to the caller until it settles, or `/collab` once the core admits
 * the collaboration's claim.
 */
async function routeToCore(
  resolvedDeps: PromptDeps,
  core: NonNullable<PromptDeps["core"]>,
  input: {
    projectPath: string;
    session: SessionState;
    conversationId: string;
    promptText: string;
    emit: (event: string, data: unknown) => void;
    modelSelection: BackendModelSelection | undefined;
    images: ImagePayload[] | undefined;
    options: PromptStreamOptions | undefined;
    scopeRef: ConversationScopeRef;
  },
): Promise<PromptStreamResult> {
  const { projectPath, session, conversationId, promptText, emit, options } =
    input;
  const conversation = await resolvedDeps.getConversation(
    projectPath,
    session.sessionName,
    conversationId,
  );
  if (!conversation)
    throw new Error(`Conversation not found: ${conversationId}`);
  const target = targetFromStoreSessionName(
    resolvedDeps.getProjectDisplayName(projectPath),
    session.sessionName,
    conversationId,
  );
  const refusedWith = (error: string): PromptStreamResult => {
    emitErrorAndDone(emit, error);
    return {
      conversationId,
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
      error,
    };
  };
  if (!core.owns(conversationId))
    return refusedWith("This historical conversation is read-only");
  if (hasCollabPrefix(promptText)) {
    const held = await core.collaborationRefusal({
      projectPath,
      target,
      conversation,
      text: promptText.trim(),
      ...(options?.backend !== undefined ? { backend: options.backend } : {}),
    });
    if (held !== null) return refusedWith(held.body.error);
    return startCollaboration(resolvedDeps, input);
  }
  const outcome = await core.send({
    projectPath,
    target,
    conversation,
    message: {
      text: promptText,
      ...(input.images !== undefined ? { images: input.images } : {}),
      ...(options?.documentFeedback !== undefined
        ? { documentFeedback: options.documentFeedback }
        : {}),
      ...(options?.notepadFeedback !== undefined
        ? { notepadFeedback: options.notepadFeedback }
        : {}),
      ...(input.modelSelection !== undefined
        ? { modelSelection: input.modelSelection }
        : {}),
      ...(options?.backend !== undefined ? { backend: options.backend } : {}),
      ...(options?.inputOrigin !== undefined
        ? { inputOrigin: options.inputOrigin }
        : {}),
      ...(options?.autonomous === true ? { autonomous: true } : {}),
    },
    sink: { emit },
  });
  if (outcome.kind === "refused")
    return refusedWith(outcome.refusal.body.error);
  await notifyPromptAccepted(options, input.scopeRef, conversationId);
  const settled = await outcome.settled;
  emit("done", {});
  return {
    conversationId,
    contextTokens: null,
    contextWindowMax: null,
    compacted: false,
    aborted: settled.aborted,
    error: settled.error,
  };
}

// ============================================================
// Error types for backend validation
// ============================================================

export class BackendMismatchError extends Error {
  readonly statusCode = 409;
  constructor(
    public readonly existingBackend: AgentBackendId,
    public readonly requestedBackend: AgentBackendId,
  ) {
    super(
      `Backend mismatch: conversation uses "${existingBackend}" but request specified "${requestedBackend}"`,
    );
    this.name = "BackendMismatchError";
  }
}

/**
 * Emit the terminal SSE pair for a failed prompt request so the client's
 * loading state always resolves.
 */
function emitErrorAndDone(
  emit: (event: string, data: unknown) => void,
  message: string,
): void {
  emit("error", { message });
  emit("done", {});
}
