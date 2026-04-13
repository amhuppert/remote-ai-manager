import crypto from "node:crypto";
import type {
  ConversationState,
  ConversationRole,
  ForkedFrom,
  AgentSessionRef,
  AgentBackendId,
} from "@/types";
import {
  mutateSession as defaultMutateSession,
  readState as defaultReadState,
  getSession as defaultGetSession,
} from "./state";
import { createLogger } from "./logging";
import {
  copyTranscriptUpTo,
  getTranscriptPath,
  readConversationMessages,
  findLastAssistantUuid,
} from "./transcript";

const logger = createLogger("conversations");

// ============================================================
// Dependency Injection
// ============================================================

export interface ConversationsDeps {
  mutateSession: typeof defaultMutateSession;
  readState: typeof defaultReadState;
  getSession: typeof defaultGetSession;
}

export const defaultConversationsDeps: ConversationsDeps = {
  mutateSession: defaultMutateSession,
  readState: defaultReadState,
  getSession: defaultGetSession,
};

// ============================================================
// Factory
// ============================================================

export function createConversationService(
  deps: ConversationsDeps = defaultConversationsDeps,
) {
  const { mutateSession, readState, getSession } = deps;

  // ============================================================
  // Conversation CRUD
  // ============================================================

  /** Create a new empty conversation in a session and persist it */
  async function createConversation(
    projectPath: string,
    sessionName: string,
    opts?: { role?: ConversationRole; agentBackend?: AgentBackendId },
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
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: now,
          lastActivityAt: now,
          source: "cc",
          summary: null,
          archived: false,
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: null,
          pendingQuestionId: null,
          pendingQuestions: null,
          forkedFrom: null,
          role: opts?.role ?? null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: opts?.agentBackend ?? "claude",
          backendRef: null,
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
  async function getConversation(
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
  async function getSessionConversations(
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
  async function setConversationArchived(
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
  async function renameConversation(
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

  /** Create a forked conversation from an existing one at the given message index */
  async function forkConversation(
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

    const sourceBackendRef = resolveSourceBackendRef(source);
    if (!sourceBackendRef) {
      throw new Error("Cannot fork: conversation has no backend session");
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

    const forkLocator = await findLastAssistantUuid(
      source.transcriptPath,
      messageIndex,
    );

    const forkedFrom: ForkedFrom = {
      sourceConversationId,
      messageIndex,
      sourceBackend: sourceBackendRef.backend,
      sourceBackendRef,
      forkLocator,
    };

    const transcriptPath = await getTranscriptPath(newId);
    await copyTranscriptUpTo({
      sourceTranscriptPath: source.transcriptPath,
      targetConversationId: newId,
      upToMessageIndex: messageIndex,
      appendEditedMessage: editedText
        ? { text: editedText, timestamp: now }
        : undefined,
    });

    // --- Phase 3: State mutation (inside lock) ---
    await mutateSession(
      projectPath,
      sessionName,
      "forkConversation",
      (sess) => {
        const conversation: ConversationState = {
          id: newId,
          name: forkName,
          transcriptPath,
          status: "new",
          promptCount: 0,
          createdAt: now,
          lastActivityAt: now,
          source: "cc",
          summary: null,
          archived: false,
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: null,
          pendingQuestionId: null,
          pendingQuestions: null,
          forkedFrom,
          role: null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: source.agentBackend ?? "claude",
          backendRef: null,
        };

        sess.conversations.push(conversation);
      },
    );

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

  /** Finalize focus initialization: archive init conversation, create a new one */
  async function finalizeInitialization(
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
          throw new Error(
            "No initialization conversation found in this session",
          );
        }

        initConvo.archived = true;

        const now = new Date().toISOString();
        const sequenceNumber = session.conversations.length + 1;
        const newConvo: ConversationState = {
          id: crypto.randomUUID(),
          name: `${sessionName} ${sequenceNumber}`,
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: now,
          lastActivityAt: now,
          source: "cc",
          summary: null,
          archived: false,
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: null,
          pendingQuestionId: null,
          pendingQuestions: null,
          forkedFrom: null,
          role: null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: "claude",
          backendRef: null,
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

  return {
    createConversation,
    getConversation,
    getSessionConversations,
    setConversationArchived,
    renameConversation,
    forkConversation,
    finalizeInitialization,
  };
}

// ============================================================
// Types (exported for consumers)
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

export interface FinalizeInitializationResult {
  conversationId: string;
  name: string;
}

/** Resolve the backend session ref to use when forking */
function resolveSourceBackendRef(
  conversation: ConversationState,
): AgentSessionRef | null {
  return (
    conversation.backendRef ?? conversation.forkedFrom?.sourceBackendRef ?? null
  );
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultService = createConversationService();

export const createConversation = defaultService.createConversation;
export const getConversation = defaultService.getConversation;
export const getSessionConversations = defaultService.getSessionConversations;
export const setConversationArchived = defaultService.setConversationArchived;
export const renameConversation = defaultService.renameConversation;
export const forkConversation = defaultService.forkConversation;
export const finalizeInitialization = defaultService.finalizeInitialization;

// ============================================================
// Derived Session-Level Helpers (pure functions)
// ============================================================

// Re-export pure derive functions from client-safe module
export {
  deriveSessionStatus,
  deriveSessionPromptCount,
  deriveSessionLastActivity,
} from "./session-derived";
