import crypto from "node:crypto";
import type { ConversationState } from "@/types";
import { readState, writeState } from "./state";
import { createLogger } from "./logging";

const logger = createLogger("conversations");

// ============================================================
// Conversation CRUD
// ============================================================

/** Create a new empty conversation in a session and persist it */
export async function createConversation(
  projectPath: string,
  sessionName: string,
): Promise<ConversationState> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const now = new Date().toISOString();
  const sequenceNumber = session.conversations.length + 1;
  const conversation: ConversationState = {
    id: crypto.randomUUID(),
    name: `${sessionName} ${sequenceNumber}`,
    claudeSessionId: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: now,
    lastActivityAt: now,
    source: "csm",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
  };

  session.conversations.push(conversation);
  await writeState(state);

  logger.info("conversation.created", {
    projectPath,
    sessionName,
    conversationId: conversation.id,
  });

  return conversation;
}

/** Get a specific conversation by ID within a session */
export async function getConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return null;

  const session = project.sessions[sessionName];
  if (!session) return null;

  return session.conversations.find((c) => c.id === conversationId) ?? null;
}

/** Get all conversations for a session, ordered by most recently active first */
export async function getSessionConversations(
  projectPath: string,
  sessionName: string,
): Promise<ConversationState[]> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return [];

  const session = project.sessions[sessionName];
  if (!session) return [];

  return [...session.conversations].sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() -
      new Date(a.lastActivityAt).getTime(),
  );
}

/** Set a conversation's archived flag */
export async function setConversationArchived(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  archived: boolean,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(
      `Conversation "${conversationId}" not found in session "${sessionName}"`,
    );
  }

  conversation.archived = archived;
  await writeState(state);
}

/** Rename a conversation */
export async function renameConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  name: string,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(
      `Conversation "${conversationId}" not found in session "${sessionName}"`,
    );
  }

  conversation.name = name;
  await writeState(state);
}

// ============================================================
// Derived Session-Level Helpers (pure functions)
// ============================================================

// Re-export pure derive functions from client-safe module
export {
  deriveSessionStatus,
  deriveSessionPromptCount,
  deriveSessionLastActivity,
} from "./session-derived";
