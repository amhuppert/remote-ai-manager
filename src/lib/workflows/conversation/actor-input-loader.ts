/**
 * Load the input a conversation actor is constructed from, keyed the way every
 * out-of-band materialization addresses a conversation: by project path, STORE
 * session name, and conversation id.
 *
 * The store session name is the sentinel for a project conversation, so this
 * seam is where scope is recovered. Making it scope-aware here — rather than
 * requiring each caller to pass an explicit `actorInput` — is what serves answer
 * delivery, queue drain, enqueue and debug-mode at once (D5); the explicit-input
 * requirement is how the defect arose, because a caller that forgets it gets a
 * runtime failure rather than a type error.
 */

import type { AgentSessionRef, AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationScope,
  ConversationState,
} from "@/lib/conversations/schemas";
import type { ForkedFrom, ConversationRole } from "@/lib/conversations/schemas";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { DebugModeState } from "@/lib/debug-log/schemas";
import type { ConversationPersistenceMode } from "./types";

export interface EnsureActorInputData {
  /**
   * Required: an actor's scope is a decision its constructor must state, not one
   * the manager infers. An optional field with a session default is how a
   * project conversation silently materializes session-shaped.
   */
  conversationScope: ConversationScope;
  projectName: string;
  sessionWorktreePath: string;
  /**
   * Required construction-time persistence choice. `ephemeral` marks a
   * synthetic lane with no persisted `ConversationState` record (compaction,
   * workflow-graph validator): the injected ephemeral persistence adapter makes
   * every durable side effect inert and snapshot/queue-drain are skipped. Every
   * lane whose conversation exists in the state store passes `durable`.
   */
  persistence: ConversationPersistenceMode;
  conversation: {
    createdAt: string;
    forkedFrom: ForkedFrom;
    role: ConversationRole;
    transcriptPath: string | null;
    agentBackend: AgentBackendId;
    backendRef: AgentSessionRef | null;
    promptCount: number;
    debugMode: DebugModeState | null;
  };
}

/**
 * The repositories the loader reads. Method syntax so the production store's
 * own accessors assign without a signature dance.
 */
export interface ActorInputLoaderDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    worktreePath: string;
    conversations: ConversationState[];
  } | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getProjectDisplayName(projectPath: string): string;
}

function actorInputFor(
  deps: ActorInputLoaderDeps,
  scope: ConversationScope,
  projectPath: string,
  worktreePath: string,
  conversation: ConversationState,
): EnsureActorInputData {
  return {
    conversationScope: scope,
    projectName: deps.getProjectDisplayName(projectPath),
    sessionWorktreePath: worktreePath,
    // Loaded from the state store, so a real ConversationState record exists.
    persistence: "durable",
    conversation: {
      createdAt: conversation.createdAt,
      forkedFrom: conversation.forkedFrom ?? null,
      role: conversation.role ?? null,
      transcriptPath: conversation.transcriptPath ?? null,
      agentBackend: conversation.agentBackend ?? "claude",
      backendRef: conversation.backendRef ?? null,
      promptCount: conversation.promptCount ?? 0,
      debugMode: conversation.debugMode?.active ? conversation.debugMode : null,
    },
  };
}

export async function loadActorInput(
  deps: ActorInputLoaderDeps,
  projectPath: string,
  storeSessionName: string,
  conversationId: string,
): Promise<EnsureActorInputData> {
  if (isProjectSentinel(storeSessionName)) {
    const conversation = await deps.getProjectConversation(
      projectPath,
      conversationId,
    );
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    // A project conversation has no session worktree: it executes directly in
    // the project root, which is the same target the project prompt entry binds
    // explicitly.
    return actorInputFor(
      deps,
      "project",
      projectPath,
      projectPath,
      conversation,
    );
  }

  const session = await deps.getSession(projectPath, storeSessionName);
  if (!session) {
    throw new Error(`Session not found: ${storeSessionName}`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  return actorInputFor(
    deps,
    "session",
    projectPath,
    session.worktreePath,
    conversation,
  );
}
