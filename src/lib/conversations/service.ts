import crypto from "node:crypto";
import { forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type {
  ConversationState,
  ConversationRole,
  ForkedFrom,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  mutateSession as defaultMutateSession,
  getSession as defaultGetSession,
  getConversation as defaultGetConversation,
  getSessionConversations as defaultGetSessionConversations,
  setConversationPendingPromptText as defaultSetConversationPendingPromptText,
} from "../state-store";
import { createLogger } from "../logging";
import {
  copyTranscriptUpTo,
  getTranscriptPath,
  readConversationMessages,
  findForkAnchorUuid,
  type CopyTranscriptMode,
} from "../prompt/transcript";
import { buildSyntheticForkSeed } from "../sessions/synthetic-fork-seed";
import { getErrorMessage } from "../shared/errors";

/** Subset of @anthropic-ai/claude-agent-sdk's forkSession API used at fork creation. */
interface SdkForkSession {
  (
    sessionId: string,
    options?: { dir?: string; upToMessageId?: string },
  ): Promise<{ sessionId: string }>;
}

/**
 * Typed error raised for client-correctable fork preconditions: missing
 * source conversation, no transcript yet, out-of-range messageIndex,
 * missing backend ref. The API route maps this to 4xx.
 */
export class ForkValidationError extends Error {
  readonly kind:
    | "source_not_found"
    | "no_transcript"
    | "invalid_message_index"
    | "no_backend_session";

  constructor(kind: ForkValidationError["kind"], message: string) {
    super(message);
    this.name = "ForkValidationError";
    this.kind = kind;
  }
}

/**
 * Typed error raised when fork creation cannot proceed because both the SDK
 * `forkSession()` call and the synthetic-seed fallback have failed. The API
 * route maps this to a 4xx — no conversation is created.
 */
export class ForkCreationError extends Error {
  readonly kind: "fork_failed";
  readonly cause?: unknown;
  readonly syntheticFallbackError?: string;

  constructor(
    kind: "fork_failed",
    message: string,
    options: { cause?: unknown; syntheticFallbackError?: string } = {},
  ) {
    super(message);
    this.name = "ForkCreationError";
    this.kind = kind;
    this.cause = options.cause;
    this.syntheticFallbackError = options.syntheticFallbackError;
  }
}

const logger = createLogger("conversations");

// ============================================================
// Dependency Injection
// ============================================================

export interface ConversationsDeps {
  mutateSession: typeof defaultMutateSession;
  getSession: typeof defaultGetSession;
  getConversation: typeof defaultGetConversation;
  getSessionConversations: typeof defaultGetSessionConversations;
  setConversationPendingPromptText: typeof defaultSetConversationPendingPromptText;
  /**
   * Override config dir for transcript path resolution. When omitted, the
   * global config dir (resolved from CC_CONFIG_DIR / OS defaults) is used.
   * Test code injects an isolated directory here.
   */
  configDir?: string;
  /** SDK forkSession injection point (tests substitute a fake). */
  forkSession?: SdkForkSession;
}

const defaultConversationsDeps: ConversationsDeps = {
  mutateSession: defaultMutateSession,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getSessionConversations: defaultGetSessionConversations,
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
  forkSession: sdkForkSession,
};

// ============================================================
// Factory
// ============================================================

export function createConversationService(
  deps: ConversationsDeps = defaultConversationsDeps,
) {
  const {
    mutateSession,
    getSession,
    getConversation,
    getSessionConversations,
    setConversationPendingPromptText: setPendingPromptTextDep,
    configDir,
    forkSession = sdkForkSession,
  } = deps;

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
          pendingPromptText: null,
          forkedFrom: null,
          role: opts?.role ?? null,
          activeTurnSource: null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: opts?.agentBackend ?? "claude",
          backendRef: null,
          unread: false,
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
  async function getConversationById(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null> {
    return getConversation(projectPath, sessionName, conversationId);
  }

  /** Get all conversations for a session, ordered by most recently active first */
  async function getSessionConversationsList(
    projectPath: string,
    sessionName: string,
  ): Promise<ConversationState[]> {
    return getSessionConversations(projectPath, sessionName);
  }

  /** Update the agent backend for a conversation that has no prompts yet */
  async function setConversationBackend(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    backend: AgentBackendId,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setConversationBackend",
      (session) => {
        const conversation = session.conversations.find(
          (c) => c.id === conversationId,
        );
        if (!conversation) {
          throw new Error(
            `Conversation "${conversationId}" not found in session "${sessionName}"`,
          );
        }
        if (conversation.promptCount > 0) {
          throw new Error(
            `Cannot change backend after prompts have been sent (conversation "${conversationId}")`,
          );
        }

        conversation.agentBackend = backend;
      },
    );

    logger.info("conversation.backend_changed", {
      projectPath,
      sessionName,
      conversationId,
      backend,
    });
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

  /** Set or clear the persisted in-progress prompt text for a conversation */
  async function setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    await setPendingPromptTextDep(
      projectPath,
      sessionName,
      conversationId,
      text,
    );

    logger.info("conversation.pending_prompt_updated", {
      projectPath,
      sessionName,
      conversationId,
      hasText: text !== null && text.length > 0,
    });
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
    const { projectPath, sessionName, sourceConversationId, messageIndex } =
      input;

    // --- Phase 1: Read source data and validate (outside lock) ---
    const session = await getSession(projectPath, sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found in project`);
    }

    const source = session.conversations.find(
      (c) => c.id === sourceConversationId,
    );
    if (!source) {
      throw new ForkValidationError(
        "source_not_found",
        `Source conversation not found: ${sourceConversationId}`,
      );
    }

    if (!source.transcriptPath) {
      throw new ForkValidationError(
        "no_transcript",
        "Cannot fork: conversation has no transcript",
      );
    }

    const messages = await readConversationMessages(source.transcriptPath);
    if (messageIndex < 0 || messageIndex >= messages.length) {
      throw new ForkValidationError(
        "invalid_message_index",
        `Invalid messageIndex: ${messageIndex} (conversation has ${messages.length} messages)`,
      );
    }

    const targetMessage = messages[messageIndex]!;
    const targetRole = targetMessage.role;

    // Case 3 (user fork at index 0) is a "start over" — no backend derivation
    // needed. Cases 1 and 2 carry forward the source SDK session, so the
    // source must have one.
    const needsBackendRef = !(targetRole === "user" && messageIndex === 0);
    const sourceBackendRef = resolveSourceBackendRef(source);
    if (needsBackendRef && !sourceBackendRef) {
      throw new ForkValidationError(
        "no_backend_session",
        "Cannot fork: conversation has no backend session",
      );
    }

    // --- Phase 2: Compute role-aware fork parameters ---
    //
    // Three cases:
    //   (1) assistant fork at any index → inclusive copy + inclusive anchor.
    //       The new conversation keeps the assistant's response visible; the
    //       SDK fork (next task) will anchor on that assistant UUID.
    //   (2) user fork at index N > 0 → exclusive copy + exclusive anchor.
    //       The new conversation copies messages 0..N-1; the user's text at
    //       N becomes pendingPromptText for re-prompting after edit.
    //   (3) user fork at index 0 → "edit and start over". No transcript copy,
    //       no SDK anchor, no derived backend ref. pendingPromptText holds
    //       the user's first-message text. The new conversation is brand-new
    //       except for the forkedFrom reference back to the source.
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const turnNumber = Math.floor(messageIndex / 2) + 1;
    const sourceName = source.name ?? "Unnamed";
    const forkName = `Fork of ${sourceName} @ turn ${turnNumber}`;

    let copyMode: CopyTranscriptMode | null;
    let anchorMode: CopyTranscriptMode | null;
    let pendingPromptText: string | null;
    let derivedSourceRef: AgentSessionRef | null;

    if (targetRole === "assistant") {
      copyMode = "inclusive";
      anchorMode = "inclusive";
      pendingPromptText = null;
      derivedSourceRef = sourceBackendRef;
    } else if (messageIndex > 0) {
      copyMode = "exclusive";
      anchorMode = "exclusive";
      pendingPromptText = extractUserText(targetMessage);
      derivedSourceRef = sourceBackendRef;
    } else {
      copyMode = null;
      anchorMode = null;
      pendingPromptText = extractUserText(targetMessage);
      derivedSourceRef = null;
    }

    let forkLocator: string | null = null;
    let transcriptPath: string | null = null;

    if (copyMode && anchorMode) {
      forkLocator = await findForkAnchorUuid(source.transcriptPath, {
        atMessageIndex: messageIndex,
        mode: anchorMode,
      });
      transcriptPath = await getTranscriptPath(newId, configDir);
      await copyTranscriptUpTo({
        sourceTranscriptPath: source.transcriptPath,
        targetConversationId: newId,
        upToMessageIndex: messageIndex,
        mode: copyMode,
        configDir,
      });
    }

    // Eagerly materialize the Claude SDK fork so the new conversation owns
    // a session file from the moment it's created (decoupling it from any
    // later mutation of the source — auto-compaction, deletion, etc.).
    // Cases 1 and 2 only; case 3 has no derived source ref.
    //
    // When forkSession() throws (e.g., the anchor UUID has been compacted
    // away on disk), or when no anchor UUID could be located in the local
    // transcript (legacy transcripts without uuid fields), fall back to a
    // synthetic seed built from the local CC transcript and leave
    // backendRef null so the next prompt creates a brand-new SDK session.
    // Calling forkSession() without upToMessageId would silently fork from
    // the latest source state — the visible transcript would be truncated
    // but the SDK session would carry the full source history.
    // If the synthetic seed can't be built either, surface a typed error —
    // the fork must NOT be created in that case.
    let backendRef: AgentSessionRef | null = null;
    let forkMode: "native" | "synthetic" | null = null;
    const needsSyntheticFallback =
      derivedSourceRef !== null &&
      derivedSourceRef.backend === "claude" &&
      copyMode !== null &&
      forkLocator === null;

    if (
      derivedSourceRef &&
      derivedSourceRef.backend === "claude" &&
      !needsSyntheticFallback
    ) {
      try {
        const { sessionId: forkedSdkSessionId } = await forkSession(
          derivedSourceRef.sessionId,
          {
            dir: projectPath,
            upToMessageId: forkLocator!,
          },
        );
        backendRef = { backend: "claude", sessionId: forkedSdkSessionId };
        forkMode = "native";
        logger.info("conversation.fork.native", {
          projectPath,
          sessionName,
          sourceConversationId,
          sourceSessionId: derivedSourceRef.sessionId,
          forkLocator,
          forkedSdkSessionId,
        });
      } catch (err) {
        const reason = getErrorMessage(err);
        logger.warn("conversation.fork.native_failed", {
          projectPath,
          sessionName,
          sourceConversationId,
          sourceSessionId: derivedSourceRef.sessionId,
          forkLocator,
          reason,
        });

        const seed = await buildSyntheticForkSeed(
          source.transcriptPath,
          messageIndex,
        );
        if (!seed) {
          throw new ForkCreationError(
            "fork_failed",
            `Fork creation failed: SDK forkSession threw (${reason}) and the local transcript could not be read for synthetic fallback`,
            {
              cause: err,
              syntheticFallbackError:
                "buildSyntheticForkSeed returned null (transcript unreadable or empty)",
            },
          );
        }

        pendingPromptText =
          pendingPromptText && pendingPromptText.length > 0
            ? `${seed}\n\n---\n\n${pendingPromptText}`
            : seed;
        forkMode = "synthetic";
        logger.info("conversation.fork.synthetic_fallback", {
          projectPath,
          sessionName,
          sourceConversationId,
          sourceSessionId: derivedSourceRef.sessionId,
          forkLocator,
          reason,
          seedLength: seed.length,
        });
      }
    } else if (
      needsSyntheticFallback &&
      derivedSourceRef &&
      derivedSourceRef.backend === "claude"
    ) {
      const seed = await buildSyntheticForkSeed(
        source.transcriptPath,
        messageIndex,
      );
      if (!seed) {
        throw new ForkCreationError(
          "fork_failed",
          "Fork creation failed: no fork anchor UUID in the local transcript and the synthetic seed could not be built",
          {
            syntheticFallbackError:
              "buildSyntheticForkSeed returned null (transcript unreadable or empty)",
          },
        );
      }

      pendingPromptText =
        pendingPromptText && pendingPromptText.length > 0
          ? `${seed}\n\n---\n\n${pendingPromptText}`
          : seed;
      forkMode = "synthetic";
      logger.info("conversation.fork.synthetic_no_anchor", {
        projectPath,
        sessionName,
        sourceConversationId,
        sourceSessionId: derivedSourceRef.sessionId,
        seedLength: seed.length,
      });
    }

    const forkedFrom: ForkedFrom = {
      sourceConversationId,
      messageIndex,
      sourceBackend: derivedSourceRef ? derivedSourceRef.backend : null,
      sourceBackendRef: derivedSourceRef,
      forkLocator,
      forkMode,
    };

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
          pendingPromptText,
          forkedFrom,
          role: null,
          activeTurnSource: null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: source.agentBackend ?? "claude",
          backendRef,
          unread: false,
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
      targetRole,
      mode: copyMode ?? "edit-and-start-over",
    });

    return { conversationId: newId, name: forkName, forkMode };
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
          pendingPromptText: null,
          forkedFrom: null,
          role: null,
          activeTurnSource: null,
          contextTokens: null,
          contextWindowMax: null,
          debugMode: null,
          machineSnapshot: null,
          agentBackend: "claude",
          backendRef: null,
          unread: false,
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
    getConversation: getConversationById,
    getSessionConversations: getSessionConversationsList,
    setConversationBackend,
    setConversationArchived,
    setConversationPendingPromptText,
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
}

export interface ForkConversationResult {
  conversationId: string;
  name: string;
  /**
   * "native": the SDK forkSession() returned a forked session id eagerly,
   *           so `backendRef` is populated and no synthetic seed is needed.
   * "synthetic": SDK forkSession() failed; pendingPromptText carries a
   *              synthetic seed and backendRef is null.
   * null: case 3 (user fork at message index 0) — no source SDK continuity,
   *       behaves like a brand-new conversation.
   */
  forkMode: "native" | "synthetic" | null;
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

/** Concatenate text blocks from a message's content with newlines. */
function extractUserText(message: TranscriptMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultService = createConversationService();

export const createConversation = defaultService.createConversation;
export const getConversation = defaultService.getConversation;
export const getSessionConversations = defaultService.getSessionConversations;
export const setConversationBackend = defaultService.setConversationBackend;
export const setConversationArchived = defaultService.setConversationArchived;
export const setConversationPendingPromptText =
  defaultService.setConversationPendingPromptText;
export const renameConversation = defaultService.renameConversation;
export const forkConversation = defaultService.forkConversation;
export const finalizeInitialization = defaultService.finalizeInitialization;

// ============================================================
// Derived Session-Level Helpers (pure functions)
// ============================================================

// Re-export pure derive functions from client-safe module
export { deriveSessionStatus } from "../sessions/derived";
