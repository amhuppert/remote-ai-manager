import crypto from "node:crypto";
import type { ConversationState, ForkedFrom } from "@/types";
import { readState, writeState } from "./state";
import { createLogger } from "./logging";
import { copyTranscriptUpTo, getTranscriptPath } from "./transcript";
import { readConversationMessages } from "./transcript";

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
    metrics: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
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
// Fork Operations
// ============================================================

export interface ForkConversationInput {
  projectPath: string;
  sessionName: string;
  sourceConversationId: string;
  messageIndex: number;
  editedText?: string;
}

export interface ForkConversationResult {
  conversationId: string;
  name: string;
}

/** Resolve the Claude session ID to use for SDK resume when forking */
function resolveSourceClaudeSessionId(
  conversation: ConversationState,
): string | null {
  return (
    conversation.claudeSessionId ??
    conversation.forkedFrom?.sourceClaudeSessionId ??
    null
  );
}

/** Create a forked conversation from an existing one at the given message index */
export async function forkConversation(
  input: ForkConversationInput,
): Promise<ForkConversationResult> {
  const {
    projectPath,
    sessionName,
    sourceConversationId,
    messageIndex,
    editedText,
  } = input;

  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const source = session.conversations.find(
    (c) => c.id === sourceConversationId,
  );
  if (!source) {
    throw new Error(`Source conversation not found: ${sourceConversationId}`);
  }

  // Validate source has a resolvable Claude session ID
  const sourceClaudeSessionId = resolveSourceClaudeSessionId(source);
  if (!sourceClaudeSessionId) {
    throw new Error("Cannot fork: conversation has no history with Claude");
  }

  // Validate transcript exists
  if (!source.transcriptPath) {
    throw new Error("Cannot fork: conversation has no transcript");
  }

  // Validate messageIndex is in range by reading visible messages
  const messages = await readConversationMessages(source.transcriptPath);
  if (messageIndex < 0 || messageIndex >= messages.length) {
    throw new Error(
      `Invalid messageIndex: ${messageIndex} (conversation has ${messages.length} messages)`,
    );
  }

  // Create the forked conversation
  const now = new Date().toISOString();
  const newId = crypto.randomUUID();
  const turnNumber = Math.floor(messageIndex / 2) + 1;
  const sourceName = source.name ?? "Unnamed";
  const forkName = `Fork of ${sourceName} @ turn ${turnNumber}`;

  const forkedFrom: ForkedFrom = {
    sourceConversationId,
    sourceClaudeSessionId,
    messageIndex,
  };

  // Copy transcript
  const transcriptPath = await getTranscriptPath(newId);
  await copyTranscriptUpTo({
    sourceTranscriptPath: source.transcriptPath,
    targetConversationId: newId,
    upToMessageIndex: editedText ? messageIndex : messageIndex,
    includeAssistantResponse: !editedText,
    appendEditedMessage: editedText
      ? { text: editedText, timestamp: now }
      : undefined,
  });

  const conversation: ConversationState = {
    id: newId,
    name: forkName,
    claudeSessionId: null,
    transcriptPath,
    status: "new",
    promptCount: 0,
    createdAt: now,
    lastActivityAt: now,
    source: "csm",
    summary: null,
    archived: false,
    metrics: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom,
  };

  session.conversations.push(conversation);
  await writeState(state);

  logger.info("conversation.forked", {
    projectPath,
    sessionName,
    sourceConversationId,
    newConversationId: newId,
    messageIndex,
    hasEditedText: !!editedText,
  });

  return { conversationId: newId, name: forkName };
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
