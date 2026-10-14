import { assertCheckpointForkBackend } from "@/lib/conversation-checkpoints/fork-submission";
import type { PromptStreamResult } from "@/lib/conversation-core/turn/turn-result";
import { createLogger } from "@/lib/logging";
import { readConfig } from "@/lib/config/loader";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import {
  executePromptStream,
  BackendMismatchError,
} from "@/lib/prompt/sdk-driver";
import { hasCollabPrefix } from "@/lib/conversation-commands/parse";
import {
  getProjectConversation,
  mutateProjectConversation,
} from "@/lib/state-store";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { ExecutionTarget } from "@/lib/project-conversations/execution-target";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { publishEvent } from "@/lib/events/publication";
import { resolveProjectExecutionTarget } from "./execution-target";
import { createProjectConversationService } from "./service";
import { buildProjectConversationCreatedEvent } from "./events";
import { ProjectCollaborationUnsupportedError } from "./collaboration-refusal";

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

export interface ExecuteProjectPromptStreamInput {
  projectPath: string;
  /** Omitted ⇒ create the first project conversation and submit its first turn. */
  conversationId?: string;
  promptText: string;
  inputOrigin?: "user" | "generated";
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
          assertCheckpointForkBackend(conversation, backend);
          if (
            conversation.promptCount > 0 &&
            conversation.agentBackend !== backend
          ) {
            throw new BackendMismatchError(conversation.agentBackend, backend);
          }
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
 * and delegates the turn to the shared core prompt entry, which resolves the
 * durable project conversation and its repo-root workplace. Performs NO worktree creation, clean check,
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
    const config = await deps.readConfig();
    const command = parseConversationCommand(input.promptText);

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
      if (command)
        admitCommand(
          input.backend ?? existing.agentBackend,
          `/${command.command}`,
        );
    } else {
      if (command)
        admitCommand(
          input.backend ?? config.defaultAgentBackend,
          `/${command.command}`,
        );
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
    if (input.backend) assertCheckpointForkBackend(conversation, input.backend);
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

    return deps.executePromptStream(
      projectPath,
      sentinelSession,
      input.promptText,
      input.emit,
      conversation.id,
      input.modelSelection,
      input.images,
      {
        inputOrigin: input.inputOrigin,
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
import { admitCommand } from "@/lib/commands/admission";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
