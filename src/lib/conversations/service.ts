import crypto from "node:crypto";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import { backendForkRefusal } from "@/lib/agent-backends/fork-admission";
import { isOrdinaryConversationRole } from "./schemas";
import { rm } from "node:fs/promises";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import type {
  ConversationState,
  ConversationRole,
  ConversationStatus,
  ForkedFrom,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import {
  mutateSession as defaultMutateSession,
  createSessionConversation as defaultCreateSessionConversation,
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
import { getErrorMessage } from "../shared/errors";
import { getBackendDescriptor } from "../agent-backends/registry";
import type { BackendContinuityAdapter } from "../agent-backends/continuity";
import { buildConversation } from "./build-conversation";
import { resolveConversationProfileSnapshot } from "./profile-resolution";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";

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
 * Typed error raised when fork creation cannot proceed because the backend's
 * continuity adapter produced no outcome (native fork and synthetic-seed
 * fallback both failed). The API route maps this to a 4xx — no conversation
 * is created.
 */
export class ForkCreationError extends Error {
  readonly kind: "fork_failed";
  readonly cause?: unknown;

  constructor(
    kind: "fork_failed",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ForkCreationError";
    this.kind = kind;
    this.cause = options.cause;
  }
}

export class ConversationDeletionConflictError extends Error {
  constructor(conversationId: string, status: ConversationStatus) {
    super(
      `Conversation "${conversationId}" must be idle before deletion; current status is "${status}"`,
    );
    this.name = "ConversationDeletionConflictError";
  }
}

const logger = createLogger("conversations");

// ============================================================
// Dependency Injection
// ============================================================

export interface ConversationsDeps {
  mutateSession: typeof defaultMutateSession;
  createSessionConversation: typeof defaultCreateSessionConversation;
  getSession: typeof defaultGetSession;
  getConversation: typeof defaultGetConversation;
  getSessionConversations: typeof defaultGetSessionConversations;
  setConversationPendingPromptText: typeof defaultSetConversationPendingPromptText;
  stopConversationActor?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    reason: string,
  ): Promise<void>;
  removeTranscript?(transcriptPath: string): Promise<void>;
  /**
   * Override config dir for transcript path resolution. When omitted, the
   * global config dir (resolved from CC_CONFIG_DIR / OS defaults) is used.
   * Test code injects an isolated directory here.
   */
  configDir?: string;
  /**
   * Resolves the continuity adapter owning a backend's session lifecycle
   * (fork at creation time). Tests substitute fakes; production resolves from
   * the backend registry.
   */
  getContinuityAdapter?(backend: AgentBackendId): BackendContinuityAdapter;
  /**
   * Resolve and compose the profile a new conversation runs under. Always
   * awaited BEFORE the row is written (and outside any write-queue callback):
   * resolution reads the library from disk, and the snapshot has to be durable
   * before a provider runtime could exist (R6).
   */
  resolveProfileSnapshot?(
    projectPath: string,
    ref?: AgentProfileRef | null,
  ): Promise<AgentProfileSnapshot>;
}

function defaultGetContinuityAdapter(
  backend: AgentBackendId,
): BackendContinuityAdapter {
  const conversation = getBackendDescriptor(backend).conversation;
  if (!conversation) {
    throw new Error(`Backend "${backend}" declares no conversation facet`);
  }
  return conversation.continuity;
}

const defaultConversationsDeps: ConversationsDeps = {
  mutateSession: defaultMutateSession,
  createSessionConversation: defaultCreateSessionConversation,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getSessionConversations: defaultGetSessionConversations,
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
  stopConversationActor: async (
    projectPath,
    sessionName,
    conversationId,
    reason,
  ) => {
    const { stopConversationActor } =
      await import("@/lib/workflows/conversation/manager");
    stopConversationActor(projectPath, sessionName, conversationId, reason);
  },
  removeTranscript: async (transcriptPath) => {
    await rm(transcriptPath, { force: true });
  },
  getContinuityAdapter: defaultGetContinuityAdapter,
  resolveProfileSnapshot: resolveConversationProfileSnapshot,
};

// ============================================================
// Factory
// ============================================================

export function createConversationService(
  deps: ConversationsDeps = defaultConversationsDeps,
) {
  const {
    mutateSession,
    createSessionConversation,
    getSession,
    getConversation,
    getSessionConversations,
    setConversationPendingPromptText: setPendingPromptTextDep,
    stopConversationActor = defaultConversationsDeps.stopConversationActor!,
    removeTranscript = defaultConversationsDeps.removeTranscript!,
    configDir,
    getContinuityAdapter = defaultGetContinuityAdapter,
    resolveProfileSnapshot = resolveConversationProfileSnapshot,
  } = deps;

  // ============================================================
  // Conversation CRUD
  // ============================================================

  /** Create a new empty conversation in a session and persist it */
  async function createConversation(
    projectPath: string,
    sessionName: string,
    opts?: {
      role?: ConversationRole;
      agentBackend?: AgentBackendId;
      /**
       * Omitting this yields the explicit Standard Agent snapshot, not an
       * absent profile — system creators (planner, lanes) simply do not pass
       * one (R7).
       */
      profile?: AgentProfileRef | null;
      /**
       * A snapshot the caller ALREADY resolved, persisted verbatim.
       *
       * The graph-workflow lane handoff (R4): an execution resolves every
       * assignment once at start, and a lane created minutes later must run
       * those bytes — not a re-resolution that could pick up a newer revision,
       * fall back to the Standard Agent, or fail on a profile deleted since.
       * Mutually exclusive with `profile`: a caller holding bytes has nothing
       * left to resolve, and honouring both would make it ambiguous which one
       * the conversation actually ran under.
       */
      profileSnapshot?: AgentProfileSnapshot;
    },
  ): Promise<ConversationState> {
    if (opts?.profile != null && opts.profileSnapshot !== undefined) {
      throw new Error(
        "createConversation accepts either a profile reference or a pre-resolved profileSnapshot, not both.",
      );
    }

    await assertBackendExecution(
      opts?.agentBackend ?? DEFAULT_AGENT_BACKEND_ID,
      {
        facet: "conversation",
        operation: "create-conversation",
        executionClass: isOrdinaryConversationRole(opts?.role ?? null)
          ? "ordinary-conversation"
          : "governed-execution",
      },
    );

    // Before the row exists: an unresolvable reference must refuse the creation
    // rather than leave a conversation running under a profile nobody chose.
    // A handed-over snapshot skips this entirely — resolution is the only way
    // a post-seed library edit or deletion could reach the conversation.
    const profileSnapshot =
      opts?.profileSnapshot ??
      (await resolveProfileSnapshot(projectPath, opts?.profile));

    const conversation = await createSessionConversation(
      projectPath,
      sessionName,
      (sequenceNumber) =>
        buildConversation({
          id: crypto.randomUUID(),
          scope: "session",
          name: `${sessionName} ${sequenceNumber}`,
          createdAt: new Date().toISOString(),
          agentBackend: opts?.agentBackend ?? DEFAULT_AGENT_BACKEND_ID,
          role: opts?.role ?? null,
          profileSnapshot,
        }),
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

  async function deleteConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void> {
    const conversation = await getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (conversation === null) {
      throw new Error(
        `Conversation "${conversationId}" not found in session "${sessionName}"`,
      );
    }
    if (conversation.status !== "new" && conversation.status !== "awaiting") {
      throw new ConversationDeletionConflictError(
        conversationId,
        conversation.status,
      );
    }

    await stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "conversation deleted",
    );
    await mutateSession(
      projectPath,
      sessionName,
      "deleteConversation",
      (session) => {
        const index = session.conversations.findIndex(
          (candidate) => candidate.id === conversationId,
        );
        if (index < 0) {
          throw new Error(
            `Conversation "${conversationId}" not found in session "${sessionName}"`,
          );
        }
        const current = session.conversations[index]!;
        if (current.status !== "new" && current.status !== "awaiting") {
          throw new ConversationDeletionConflictError(
            conversationId,
            current.status,
          );
        }
        session.conversations.splice(index, 1);
      },
    );

    let transcriptCleanup: "absent" | "removed" | "failed" = "absent";
    if (conversation.transcriptPath !== null) {
      try {
        await removeTranscript(conversation.transcriptPath);
        transcriptCleanup = "removed";
      } catch (error) {
        transcriptCleanup = "failed";
        logger.warn("conversation.transcript_remove_failure", {
          projectPath,
          sessionName,
          conversationId,
          transcriptPath: conversation.transcriptPath,
          error: getErrorMessage(error),
        });
      }
    }

    logger.info("conversation.deleted", {
      projectPath,
      sessionName,
      conversationId,
      transcriptCleanup,
    });
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
        // A user-chosen name: automatic naming must never overwrite it.
        conversation.nameOrigin = "manual";
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
    // needed. Cases 1 and 2 derive history from the source agent, so the
    // source must have a backend reference.
    const needsBackendRef = !(targetRole === "user" && messageIndex === 0);
    const sourceBackendRef = resolveSourceBackendRef(source);
    if (needsBackendRef && !sourceBackendRef) {
      throw new ForkValidationError(
        "no_backend_session",
        "Cannot fork: conversation has no backend session",
      );
    }

    if (needsBackendRef && sourceBackendRef) {
      const descriptor = getBackendDescriptor(sourceBackendRef.backend);
      const refusal = backendForkRefusal(
        {
          id: descriptor.id,
          label: descriptor.metadata.label,
          capabilities: descriptor.conversation?.capabilities ?? null,
        },
        messageIndex,
        targetRole,
      );
      if (refusal) {
        logger.warn("conversation.fork_unavailable", {
          sourceConversationId,
          ...refusal,
        });
        throw new BackendAdmissionError(refusal);
      }
    }

    // --- Phase 2: Compute role-aware fork parameters ---
    //
    // Three cases:
    //   (1) assistant fork at any index → inclusive copy + inclusive anchor.
    //       The new conversation keeps the assistant's response visible; the
    //       native backend fork anchors on that assistant UUID.
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

    // --- Phase 3: The fork's agent profile ---
    //
    // A session-derived fork inherits the SOURCE's snapshot verbatim — same
    // identity, same revision, no re-resolution — because the source's
    // instructions are already part of the context being carried forward, and
    // it is locked from creation for the same reason (R7/R8). A legacy source
    // hands down its absence of a profile, which is the honest record.
    //
    // An index-0 fork derives from no session: it is a fresh conversation and
    // follows the standard default, changeable until its first turn.
    const derivesFromSession = derivedSourceRef !== null;
    const profileSnapshot = derivesFromSession
      ? (source.profileSnapshot ?? null)
      : await resolveProfileSnapshot(projectPath, input.profile);
    const profileLockedAt =
      derivesFromSession && profileSnapshot !== null
        ? (source.profileLockedAt ?? now)
        : null;

    // --- Phase 4: Provisional row, BEFORE any provider continuity exists ---
    //
    // The snapshot's persist-before-provider guarantee (R6) has to hold on
    // every path that creates provider state, and this is the one path that
    // used to invert it: `continuity.fork()` ran with no row in existence, so a
    // crash in between left a forked backend session nothing referenced. The
    // row goes in first, marked pending, and is finalized or removed below.
    const forkedFrom: ForkedFrom = {
      sourceConversationId,
      messageIndex,
      sourceBackend: derivedSourceRef ? derivedSourceRef.backend : null,
      sourceBackendRef: derivedSourceRef,
      forkLocator,
      forkMode: null,
      forkPending: derivesFromSession,
    };

    await mutateSession(
      projectPath,
      sessionName,
      "forkConversation",
      (sess) => {
        sess.conversations.push(
          buildConversation({
            id: newId,
            scope: "session",
            name: forkName,
            createdAt: now,
            agentBackend: source.agentBackend ?? DEFAULT_AGENT_BACKEND_ID,
            transcriptPath,
            pendingPromptText,
            forkedFrom,
            profileSnapshot,
            profileLockedAt,
          }),
        );
      },
    );

    // --- Phase 5: Provider continuity, then finalize the row ---
    //
    // The adapter normalizes the outcome:
    // - native: an eagerly-forked backend session, persisted as backendRef.
    // - synthetic_seed: immutable history stored separately from the editable
    //   draft; backendRef stays null so the next prompt starts a fresh agent.
    // - unsupported: creation fails and provisional artifacts are removed.
    // If the adapter can produce no outcome it throws, and the provisional row
    // is removed — no conversation is created.
    let backendRef: AgentSessionRef | null = null;
    let forkMode: "native" | "synthetic" | null = null;
    let syntheticSeed: string | undefined;

    if (derivedSourceRef) {
      const continuity = getContinuityAdapter(derivedSourceRef.backend);
      let outcome: Awaited<ReturnType<BackendContinuityAdapter["fork"]>>;
      try {
        outcome = await continuity.fork(derivedSourceRef, {
          projectPath,
          anchorMessageId: forkLocator,
          sourceTranscriptPath: source.transcriptPath,
          messageIndex: targetRole === "user" ? messageIndex - 1 : messageIndex,
        });
        if (outcome.kind === "unsupported")
          throw new Error(
            "The backend cannot fork this conversation with its history.",
          );
      } catch (err) {
        const reason = getErrorMessage(err);
        await removeProvisionalFork(
          projectPath,
          sessionName,
          newId,
          transcriptPath,
        );
        logger.warn("conversation.fork.failed", {
          projectPath,
          sessionName,
          sourceConversationId,
          backend: derivedSourceRef.backend,
          sourceSessionRef: derivedSourceRef.ref,
          forkLocator,
          reason,
        });
        throw new ForkCreationError("fork_failed", reason, { cause: err });
      }

      if (outcome.kind === "native") {
        backendRef = outcome.ref;
        forkMode = "native";
        logger.info("conversation.fork.native", {
          projectPath,
          sessionName,
          sourceConversationId,
          sourceSessionRef: derivedSourceRef.ref,
          forkLocator,
          forkedSessionRef: outcome.ref.ref,
        });
      } else if (outcome.kind === "synthetic_seed") {
        syntheticSeed = outcome.seed;
        forkMode = "synthetic";
        logger.info("conversation.fork.synthetic", {
          projectPath,
          sessionName,
          sourceConversationId,
          sourceSessionRef: derivedSourceRef.ref,
          forkLocator,
          seedLength: outcome.seed.length,
        });
      }

      const settledPendingPromptText = pendingPromptText;
      await mutateSession(
        projectPath,
        sessionName,
        "finalizeForkConversation",
        (sess) => {
          const conversation = sess.conversations.find((c) => c.id === newId);
          if (!conversation) return;
          conversation.backendRef = backendRef;
          conversation.pendingPromptText = settledPendingPromptText;
          if (conversation.forkedFrom) {
            conversation.forkedFrom.forkMode = forkMode;
            conversation.forkedFrom.syntheticSeed = syntheticSeed;
            conversation.forkedFrom.forkPending = false;
          }
        },
      );
    }

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

  /**
   * Drop the row a failed fork left behind. Best-effort: the fork already
   * failed, and a removal failure must not replace the adapter's reason with a
   * cleanup error — the row is reported instead so it can be found.
   */
  async function removeProvisionalFork(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    transcriptPath: string | null,
  ): Promise<void> {
    if (transcriptPath) {
      try {
        await removeTranscript(transcriptPath);
      } catch (err) {
        logger.error("conversation.fork.transcript_cleanup_failed", {
          projectPath,
          sessionName,
          conversationId,
          error: getErrorMessage(err),
        });
      }
    }
    try {
      await mutateSession(
        projectPath,
        sessionName,
        "removeProvisionalFork",
        (sess) => {
          sess.conversations = sess.conversations.filter(
            (c) => c.id !== conversationId,
          );
        },
      );
    } catch (err) {
      logger.error("conversation.fork.provisional_cleanup_failed", {
        projectPath,
        sessionName,
        conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  /** Finalize focus initialization: archive init conversation, create a new one */
  async function finalizeInitialization(
    projectPath: string,
    sessionName: string,
  ): Promise<FinalizeInitializationResult> {
    // Resolved outside the lock: the library read is disk I/O, and the session
    // mutation below must not hold the write queue across it.
    const profileSnapshot = await resolveProfileSnapshot(projectPath);

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
        const newConvo = buildConversation({
          id: crypto.randomUUID(),
          scope: "session",
          name: `${sessionName} ${sequenceNumber}`,
          createdAt: now,
          agentBackend: DEFAULT_AGENT_BACKEND_ID,
          profileSnapshot,
        });

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
    deleteConversation,
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
  /**
   * Only an index-0 fork can carry one: it derives from no session, so it is a
   * fresh conversation with the standard selection rules. Every other fork
   * inherits the source's snapshot verbatim and offers no selection (R7.2).
   */
  profile?: AgentProfileRef | null;
}

export interface ForkConversationResult {
  conversationId: string;
  name: string;
  /**
   * "native": the continuity adapter eagerly forked a backend session, so
   *           `backendRef` is populated and no synthetic seed is needed.
   * "synthetic": pendingPromptText carries a transcript-derived seed and
   *              backendRef is null.
   * null: no backend continuity — case 3 (user fork at message index 0), or
   *       a backend whose adapter reports fork as unsupported.
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
export const deleteConversation = defaultService.deleteConversation;
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
