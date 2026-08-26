import { createLogger } from "@/lib/logging";
import { readConfig } from "@/lib/config/loader";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import {
  executePromptStream,
  BackendMismatchError,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import { hasCollabPrefix } from "@/lib/conversation-commands/parse";
import {
  getProjectConversation,
  mutateProjectConversation,
} from "@/lib/state-store";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/manager";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { publishEvent } from "@/lib/events/publication";
import { resolveProjectExecutionTarget } from "./execution-target";
import { createProjectConversationService } from "./service";
import { buildProjectConversationCreatedEvent } from "./events";

const logger = createLogger("project-conversations.prompt-entry");

export interface ExecuteProjectPromptStreamDeps {
  resolveExecutionTarget(projectPath: string): Promise<ExecutionTarget>;
  executePromptStream: typeof executePromptStream;
  readConfig: typeof readConfig;
  getProjectDisplayName(projectPath: string): string;
  createProjectConversation(
    projectPath: string,
    opts?: {
      agentBackend?: AgentBackendId;
      creationRequestId?: string;
      profile?: AgentProfileRef;
    },
  ): Promise<ConversationState>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  adoptProjectConversationBackend(
    projectPath: string,
    conversationId: string,
    backend: AgentBackendId,
  ): Promise<void>;
  /**
   * Emits the scope=project `conversation-created` event when the entry creates
   * the first project conversation (so the first-prompt flow gets the same
   * real-time creation event the explicit create route emits).
   */
  broadcastConversationCreated(
    projectPath: string,
    conversation: ConversationState,
  ): void;
}

/**
 * Manual collaboration is session-scoped by decision, not by accident: a collab
 * workflow needs a session branch and worktree to negotiate and land changes in,
 * and a project conversation executes directly in the shared project root.
 *
 * The refusal has to be the project boundary's own, and explicit. Delegating a
 * `/collab` prompt to the shared driver instead reached the collaboration
 * manager with this entry's synthetic sentinel session, whose session lookup
 * failed with `Session "__project__" not found` — publishing the internal
 * sentinel in an SSE error and disguising a scope decision as a missing record.
 */
export class ProjectCollaborationUnsupportedError extends Error {
  readonly statusCode = 400;
  readonly code = "PROJECT_COLLABORATION_UNSUPPORTED";
  constructor() {
    super(
      "/collab is not available in a project conversation — manual collaboration needs a session branch and worktree. Start a session for this project and run /collab there.",
    );
    this.name = "ProjectCollaborationUnsupportedError";
  }
}

export interface ExecuteProjectPromptStreamInput {
  projectPath: string;
  /** Omitted ⇒ create the first project conversation and submit its first turn. */
  conversationId?: string;
  promptText: string;
  emit: (event: string, data: unknown) => void;
  modelSelection?: BackendModelSelection;
  images?: ImagePayload[];
  backend?: AgentBackendId;
  /**
   * Opaque token the posting client generated for this submission. Recorded on
   * the conversation this entry creates, so the client can identify its own
   * conversation from the project conversation list — which reports what exists,
   * not which submission caused it. Ignored when the turn targets an existing
   * conversation: the client already named that one.
   */
  creationRequestId?: string;
  /**
   * Profile for the conversation this entry creates. Ignored when the turn
   * targets an existing conversation — that one's profile is already resolved,
   * and changing it goes through the profile PATCH route while it is unlocked.
   */
  profile?: AgentProfileRef;
}

function defaultDeps(): ExecuteProjectPromptStreamDeps {
  const service = createProjectConversationService();
  return {
    resolveExecutionTarget: resolveProjectExecutionTarget,
    executePromptStream,
    readConfig,
    getProjectDisplayName,
    createProjectConversation: (projectPath, opts) =>
      service.createProjectConversation(projectPath, opts),
    getProjectConversation,
    adoptProjectConversationBackend: (projectPath, conversationId, backend) =>
      mutateProjectConversation(
        projectPath,
        conversationId,
        "adoptProjectConversationBackend",
        (conversation) => {
          conversation.agentBackend = backend;
        },
      ),
    broadcastConversationCreated: (projectPath, conversation) => {
      publishEvent(
        buildProjectConversationCreatedEvent(
          getProjectDisplayName(projectPath),
          conversation,
        ),
      );
    },
  };
}

/**
 * Session-less prompt entry for project conversations. Resolves the repo-root
 * execution target, get-or-creates the project conversation, enforces the
 * backend lock on the project record, synthesizes a sentinel `SessionState`,
 * and delegates the turn to the shared `executePromptStream` — supplying an
 * explicit `actorInput` so the conversation machine binds to the repo-root
 * worktree without a host session. Performs NO worktree creation, clean check,
 * init-script, dev-server, or pre-merge flow.
 */
export function createProjectPromptExecutor(
  deps: ExecuteProjectPromptStreamDeps = defaultDeps(),
) {
  async function executeProjectPromptStream(
    input: ExecuteProjectPromptStreamInput,
  ): Promise<PromptStreamResult> {
    const { projectPath } = input;
    // Refuse before any get-or-create: a refused command must not leave a new
    // project conversation behind.
    if (hasCollabPrefix(input.promptText)) {
      logger.info("project-conversation.collab_refused", {
        projectPath,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
      });
      throw new ProjectCollaborationUnsupportedError();
    }
    const executionTarget = await deps.resolveExecutionTarget(projectPath);
    // Read config so the synthetic session inherits global defaults; values not
    // overridden fall back to the session-schema defaults.
    await deps.readConfig();

    let conversation: ConversationState;
    if (input.conversationId !== undefined) {
      const existing = await deps.getProjectConversation(
        projectPath,
        input.conversationId,
      );
      if (!existing) {
        throw new Error(
          `Project conversation not found: ${input.conversationId}`,
        );
      }
      conversation = existing;
    } else {
      conversation = await deps.createProjectConversation(projectPath, {
        ...(input.backend ? { agentBackend: input.backend } : {}),
        ...(input.creationRequestId !== undefined
          ? { creationRequestId: input.creationRequestId }
          : {}),
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
      });
      logger.info("project-conversation.first_turn_created", {
        projectPath,
        conversationId: conversation.id,
      });
      // The client that posted this turn had no conversation id to attribute
      // its turn state to, so the entry that created one names it on that
      // client's own stream, ahead of any turn output. Without this the client
      // could only guess which conversation its turn belongs to from whichever
      // one surfaces first in the list — a guess that misattributes the turn
      // whenever two are created close together.
      input.emit("conversation", { conversationId: conversation.id });
      // First-prompt creation emits the same real-time creation event the
      // explicit create route emits, so downstream surfaces learn of the new
      // project conversation immediately.
      deps.broadcastConversationCreated(projectPath, conversation);
    }

    // Backend lock: fixed once a turn has been sent (mirrors the session path's
    // semantics, but enforced against the project repo since the session-based
    // `setConversationBackend` cannot address a session-less conversation).
    if (input.backend && input.backend !== conversation.agentBackend) {
      if (conversation.promptCount > 0) {
        throw new BackendMismatchError(
          conversation.agentBackend,
          input.backend,
        );
      }
      await deps.adoptProjectConversationBackend(
        projectPath,
        conversation.id,
        input.backend,
      );
      conversation = { ...conversation, agentBackend: input.backend };
    }

    const sentinelSession = sessionStateSchema.parse({
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: projectPath,
      branchName: executionTarget.branchName,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
    });

    const actorInput: EnsureActorInputData = {
      conversationScope: "project",
      projectName: deps.getProjectDisplayName(projectPath),
      sessionWorktreePath: projectPath,
      // A real project ConversationState record backs this lane.
      persistence: "durable",
      conversation: {
        createdAt: conversation.createdAt,
        forkedFrom: conversation.forkedFrom ?? null,
        role: conversation.role ?? null,
        transcriptPath: conversation.transcriptPath ?? null,
        agentBackend: conversation.agentBackend ?? "claude",
        backendRef: conversation.backendRef ?? null,
        promptCount: conversation.promptCount ?? 0,
        debugMode: conversation.debugMode?.active
          ? conversation.debugMode
          : null,
      },
    };

    return deps.executePromptStream(
      projectPath,
      sentinelSession,
      input.promptText,
      input.emit,
      conversation.id,
      input.modelSelection,
      input.images,
      {
        executionTarget,
        actorInput,
      },
    );
  }

  return { executeProjectPromptStream };
}

const defaultExecutor = createProjectPromptExecutor();

/** Production session-less prompt entry wired to default deps. */
export function executeProjectPromptStream(
  input: ExecuteProjectPromptStreamInput,
): Promise<PromptStreamResult> {
  return defaultExecutor.executeProjectPromptStream(input);
}
