import crypto from "node:crypto";
import type { ConversationState, ConversationRole, ForkedFrom } from "@/types";
import { mutateSession } from "./state";
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
  opts?: { role?: ConversationRole },
): Promise<ConversationState> {
  const conversation = await mutateSession(
    projectPath,
    sessionName,
    "createConversation",
    (session) => {
      const now = new Date().toISOString();
      const sequenceNumber = session.conversations.length + 1;
      const conv: ConversationState = {
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
        pendingQuestionId: null,
        pendingQuestions: null,
        forkedFrom: null,
        role: opts?.role ?? null,
      };

      session.conversations.push(conv);
      return conv;
    },
  );

  logger.info("conversation.created", {
    projectPath,
    sessionName,
    conversationId: conversation.id,
  });

  return conversation;
}

/** Get a specific conversation by ID within a session */
export { getConversation, getSessionConversations };

async function getConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const { readState } = await import("./state");
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return null;

  const session = project.sessions[sessionName];
  if (!session) return null;

  return session.conversations.find((c) => c.id === conversationId) ?? null;
}

/** Get all conversations for a session, ordered by most recently active first */
async function getSessionConversations(
  projectPath: string,
  sessionName: string,
): Promise<ConversationState[]> {
  const { readState } = await import("./state");
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
  await mutateSession(
    projectPath,
    sessionName,
    "setConversationArchived",
    (session) => {
      const conversation = session.conversations.find(
        (c) => c.id === conversationId,
      );
      if (!conversation) {
        throw new Error(
          `Conversation "${conversationId}" not found in session "${sessionName}"`,
        );
      }

      conversation.archived = archived;
    },
  );
}

/** Rename a conversation */
export async function renameConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  name: string,
): Promise<void> {
  await mutateSession(
    projectPath,
    sessionName,
    "renameConversation",
    (session) => {
      const conversation = session.conversations.find(
        (c) => c.id === conversationId,
      );
      if (!conversation) {
        throw new Error(
          `Conversation "${conversationId}" not found in session "${sessionName}"`,
        );
      }

      conversation.name = name;
    },
  );
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

  // --- Phase 1: Read source data and validate (outside lock) ---
  const { getSession } = await import("./state");
  const session = await getSession(projectPath, sessionName);
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const source = session.conversations.find(
    (c) => c.id === sourceConversationId,
  );
  if (!source) {
    throw new Error(`Source conversation not found: ${sourceConversationId}`);
  }

  const sourceClaudeSessionId = resolveSourceClaudeSessionId(source);
  if (!sourceClaudeSessionId) {
    throw new Error("Cannot fork: conversation has no history with Claude");
  }

  if (!source.transcriptPath) {
    throw new Error("Cannot fork: conversation has no transcript");
  }

  const messages = await readConversationMessages(source.transcriptPath);
  if (messageIndex < 0 || messageIndex >= messages.length) {
    throw new Error(
      `Invalid messageIndex: ${messageIndex} (conversation has ${messages.length} messages)`,
    );
  }

  // --- Phase 2: I/O-heavy transcript copy (outside lock) ---
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

  // --- Phase 3: State mutation (inside lock) ---
  await mutateSession(projectPath, sessionName, "forkConversation", (sess) => {
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
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom,
      role: null,
    };

    sess.conversations.push(conversation);
  });

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
// Focus Initialization
// ============================================================

export interface FinalizeInitializationResult {
  conversationId: string;
  name: string;
}

/**
 * Finalize the focus initialization flow:
 * 1. Archive the initialization conversation
 * 2. Create a new regular conversation
 * Returns the new conversation.
 */
export async function finalizeInitialization(
  projectPath: string,
  sessionName: string,
): Promise<FinalizeInitializationResult> {
  const result = await mutateSession(
    projectPath,
    sessionName,
    "finalizeInitialization",
    (session) => {
      const initConvo = session.conversations.find(
        (c) => c.role === "initialization",
      );
      if (!initConvo) {
        throw new Error("No initialization conversation found in this session");
      }

      initConvo.archived = true;

      const now = new Date().toISOString();
      const sequenceNumber = session.conversations.length + 1;
      const newConvo: ConversationState = {
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
        pendingQuestionId: null,
        pendingQuestions: null,
        forkedFrom: null,
        role: null,
      };

      session.conversations.push(newConvo);

      logger.info("initialization.finalized", {
        projectPath,
        sessionName,
        archivedConversationId: initConvo.id,
        newConversationId: newConvo.id,
      });

      return { conversationId: newConvo.id, name: newConvo.name! };
    },
  );

  return result;
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
