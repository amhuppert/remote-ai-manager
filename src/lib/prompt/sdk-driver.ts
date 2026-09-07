import type { PromptStreamResult } from "@/lib/workflows/conversation/turn-result";
import { z } from "zod";
import { conversationTurnRequestSchema } from "@/lib/workflows/conversation/turn-spec";
import { queuedMessageNeedsReview } from "@/lib/conversations/message-queue-schemas";
/**
 * Prompt execution facade — delegates to the conversation lifecycle module.
 *
 * Keeps the same export signatures (`executePromptStream`, `createPromptExecutor`)
 * so callers (prompt-route-handlers.ts) don't need changes.
 * The lifecycle module hides its state-machine implementation and returns a
 * stable turn projection.
 */

import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type {
  ConversationBackendFactory,
  WorkflowLaneIdentity,
} from "@/lib/agent-backends/conversation";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { ModelSelectionPolicyError } from "@/lib/agent-backends/model-selection";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import type { CollaborationAutonomousResolutionThreshold } from "@/lib/workflow-graph/collaboration-schemas";
import type { CollaborationAgentTwoRequest } from "@/lib/workflows/collaboration/types";
import type {
  ConversationBinding,
  ConversationTurnSubmission,
  TurnAdmission,
} from "@/lib/workflows/conversation/turn-spec";
import { toPromptStreamResult } from "@/lib/workflows/conversation/turn-result";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";
import { ticketCommandFallbackMessage } from "@/lib/conversation-commands/ticket-confirmation";
import { dispatchConversationCommand as defaultDispatchConversationCommand } from "@/lib/conversation-commands/dispatch";
import { createLogger } from "@/lib/logging";
import {
  hasCollabPrefix,
  parseConversationCommand,
  stripCollabPrefix,
} from "@/lib/conversation-commands/parse";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
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
import { randomUUID } from "node:crypto";

const logger = createLogger("prompt");

// ============================================================
// Constants (imported by actor-implementations.ts)
// ============================================================

/** Appended to the system prompt when session.tddEnabled is true. */
export const TDD_INSTRUCTIONS =
  "<methodology>Use red-green-refactor TDD. Write a failing behavior-level test first and run it to confirm it fails for the right reason — the assertion on the missing behavior, not an import error or broken setup; scaffold the minimal module skeleton first when the test could only fail on a missing import. Make it pass with the minimum code, then refactor with tests green. Bug fixes always start from a failing reproduction test. Skip test-first only where there is no behavior to pin — pure scaffolding, type or config changes, mechanical renames or wiring, throwaway spikes, visual-only UI tweaks — and say so when you skip. In the TDD loop, run the registered test command scoped explicitly to the single test file you are iterating on (e.g. `cctl validate run test --queue-if-busy -- path/to/file.test.ts`) — a file path, never a directory path. Wider runs such as `--scope changed` remain available but are not part of the TDD loop; use them strategically at checkpoints.</methodology>";

/** Appended to every system prompt to orient the agent about its CC environment. */
export const CC_CONTEXT =
  "<command-center>You are running inside Command Center (CC), a web-based control plane for managing remote Claude Code sessions. Your session runs in an isolated git worktree with its own branch. CC provides the `cctl` CLI (on your PATH) for session actions — e.g. `cctl notify` to send push notifications to the user's phone when warranted (long tasks complete, user asked to be notified); see the `cc-cli` skill for the full command reference. Stay within your worktree — CC manages merging, dev servers, and session lifecycle.\n\nDev servers: before driving Playwright, browser, visual, or Next.js MCP tools, run `cctl dev ensure` to obtain the correct localUrl/remoteUrl for THIS session's worktree. Never assume ports like 3000 or 6006 belong to you — parallel sessions live on different ports. Use `cctl dev list` to inspect current status. Only ask the user to start a server from the UI if `cctl dev ensure` reports NO_DEV_SERVERS_CONFIGURED or an unrecoverable start failure.\n\nBackground tasks: to let a long-running command (test suite, build, watcher) outlive your turn, use the Bash tool's run_in_background option — never detach with nohup/&/disown. Tracked background tasks keep your agent session alive until they settle and re-invoke you on completion; a detached process is invisible to that machinery, so nothing holds the session open for it, nothing wakes you when it finishes, and it dies silently with the session.</command-center>";

/**
 * Appended to every CC agent's system prompt (session and project
 * conversations alike) to encourage asking the user at real forks — via
 * `cctl ask` — instead of guessing on consequential choices, and to pin the
 * async protocol's end-turn discipline (docs/design/cc-cli/03 §7). Flag
 * details and examples live in the cc-cli skill, loaded on demand.
 */
export const ASK_QUESTION_INSTRUCTIONS =
  "<asking-questions>To ask the user a question, run `cctl ask` (see the cc-cli skill) — it renders your questions as a rich multiple-choice panel the user answers in a couple of clicks, so asking is far cheaper than guessing wrong on a consequential, hard-to-reverse, or genuinely ambiguous decision; default to asking at real forks instead of silently deciding for the user. Batch related questions into one call (a single batch pends at a time), and give options substance: each option can carry a description, a recommended flag (rendered as a Suggested badge), and a tradeoff with pro/con — author the batch as JSON and pass it with --file to use them (shape in the skill). Asking is ASYNC: after `cctl ask` succeeds, write a brief handoff note (what you asked, what you'll do with each possible answer) and END YOUR TURN — do not start new work. The answers arrive as a <cc-question-answers> block in your next user message; an answer with `skipped: true` means the user declined that question — proceed with best judgment. Skip asking for trivial, reversible, or easily-inferred choices — make a sensible call and keep moving. (Asking is denied for autonomous turns; use your best judgment there.)</asking-questions>";

/**
 * The workflow-lane variant of {@link ASK_QUESTION_INSTRUCTIONS}, selected when
 * a graph-workflow context resolves its ask-user-questions toggle on AND the
 * lane holds a real CC conversation (see `selectAskQuestionInstructions`). It
 * tells the lane agent the tool IS available and states the full protocol,
 * including that the workflow PAUSES this context until the user answers — so
 * asking is a real, non-free action, not a throwaway. Unlike the default
 * variant it omits the autonomous-denied disclaimer.
 */
export const ASK_QUESTION_INSTRUCTIONS_ENABLED =
  "<asking-questions>The `cctl ask` tool IS available on this turn to ask the user a question (see the cc-cli skill) — it renders your questions as a rich multiple-choice panel the user answers in a couple of clicks. Ask ONLY at a consequential, hard-to-reverse, or genuinely ambiguous decision point where a wrong guess would send this context and its downstream dependents down the wrong path; do not ask about trivial, reversible, or easily-inferred choices — make a sensible call and keep moving. Batch related questions into ONE `cctl ask` invocation (a single batch pends at a time), and give options substance: each option can carry a description, a recommended flag (rendered as a Suggested badge), and a tradeoff with pro/con — author the batch as JSON and pass it with --file to use them (shape in the skill). After `cctl ask` succeeds, write a brief handoff note (what you asked, what you'll do with each possible answer) and END YOUR TURN — do not start new work. The workflow PAUSES this context until the user answers, so asking is not a lightweight or free action — the whole context waits. The answers arrive as a <cc-question-answers> block when this context RESUMES; an answer with `skipped: true` means the user declined that question — proceed with your best judgment.</asking-questions>";

/**
 * Chooses the asking-questions session-instruction block for a turn. Workflow
 * lanes whose effective toggle is on (resolved toggle AND lane-can-ask) get the
 * enabled variant; every other turn (non-workflow conversations, disabled
 * lanes, Codex validator lanes) keeps the default autonomous-denied guidance.
 */
export function selectAskQuestionInstructions(
  askUserQuestionsEnabled: boolean | undefined,
): string {
  return askUserQuestionsEnabled === true
    ? ASK_QUESTION_INSTRUCTIONS_ENABLED
    : ASK_QUESTION_INSTRUCTIONS;
}

/**
 * One-line nudge (docs/design/cc-cli/01 §7) pointing every CC agent at the
 * cctl CLI; detail lives in the command-center:cc-cli skill, loaded on demand.
 */
export const CC_CLI_INSTRUCTIONS =
  "Command Center actions (notifications, questions, documents, dev servers, workflows) go through the `cctl` CLI — see the cc-cli skill.";

// ============================================================
// Dependency Injection (simplified — facade only needs conversation CRUD)
// ============================================================

export interface PromptDeps {
  getConversation: typeof getConversation;
  createConversation: typeof createConversation;
  setConversationBackend: typeof setConversationBackend;
  getProjectDisplayName: typeof getProjectDisplayName;
  readConfig: typeof readConfig;
  getConversationBackendFactory: typeof getConversationBackendFactory;

  // Lifecycle operations — injected to avoid vi.mock() on the manager module
  submitConversationTurn(
    input: ConversationTurnSubmission,
  ): Promise<TurnAdmission>;

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

async function getDefaultPromptDeps(): Promise<PromptDeps> {
  if (_defaultPromptDeps) return _defaultPromptDeps;
  const manager = await import("@/lib/workflows/conversation/manager");
  const collabModule = await import("@/lib/workflows/collaboration/manager");
  _defaultPromptDeps = {
    getConversation,
    createConversation,
    setConversationBackend,
    getProjectDisplayName,
    readConfig,
    getConversationBackendFactory,
    submitConversationTurn: manager.submitConversationTurn,
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

const promptStreamTurnOptionsSchema = conversationTurnRequestSchema
  .omit({
    kind: true,
    promptText: true,
    images: true,
    modelSelection: true,
    queuedDelivery: true,
  })
  .strip();

export interface PromptStreamOptions extends z.input<
  typeof promptStreamTurnOptionsSchema
> {
  /**
   * Called once the prompt, command, or collaboration request has been
   * accepted by its execution owner. Failures are logged without changing the
   * accepted execution's outcome.
   */
  onAccepted?: () => void | Promise<void>;
  tooling?: ConversationToolingOverrides;
  /**
   * Graph-workflow lane identity. Set only by the implementer runner; threaded
   * onto the conversation runtime state and into the session env so `cctl
   * workflow …` resolves its execution/context from env. Every other caller
   * leaves it unset, so non-lane sessions carry neither var.
   */
  workflowContext?: WorkflowLaneIdentity;
  /**
   * Profile for the conversation this call CREATES (no `conversationId` was
   * supplied). An existing conversation's profile is already resolved and
   * settles at admission, so this is ignored there.
   */
  profile?: AgentProfileRef;
  collab?: CollabPromptConfig;
  /**
   * When supplied, the conversation actor input uses this resolved target's
   * worktreePath instead of `session.worktreePath`. Solo-eligible graph
   * workflow contexts leave this undefined so behavior matches the
   * pre-parallelization session-worktree flow.
   */
  executionTarget?: ExecutionTarget;
  /**
   * Explicit lifecycle input that bypasses the manager's session-based loader.
   * The session-less project-conversation
   * entry supplies this (built from the project record + repo-root worktree)
   * because the conversation has no host session to load from.
   */
  binding?: ConversationBinding;
  signal?: AbortSignal;
  /**
   * Workflow-owned turns wait for an in-flight conversation continuation to
   * settle before dispatch. Interactive sends retain fail-fast busy semantics.
   */
  waitForConversationReady?: boolean;
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

export class ConversationCommandDispatcherUnavailableError extends Error {
  readonly statusCode = 500;
  readonly code = "CONVERSATION_COMMAND_DISPATCHER_UNAVAILABLE";
  constructor() {
    super(
      "Conversation command dispatcher is not configured for this prompt executor",
    );
    this.name = "ConversationCommandDispatcherUnavailableError";
  }
}

/**
 * Execute a prompt through the conversation lifecycle module.
 *
 * 1. Get-or-create conversation
 * 2. Ensure the conversation lifecycle is ready
 * 3. Execute one turn through its domain interface
 * 4. Emit the terminal stream event from the returned projection
 */
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

  const isCollab = hasCollabPrefix(promptText);
  const parsedCommand = parseConversationCommand(promptText);

  // Command model admission must precede the transcript-owning dispatcher and
  // the conversation/backend writes needed to address it.
  let resolvedBackend: AgentBackendId;
  let backendAdoption:
    | { conversationId: string; from: AgentBackendId; to: AgentBackendId }
    | undefined;
  let conversationCreation:
    | { agentBackend: AgentBackendId; profile?: AgentProfileRef }
    | undefined;
  if (conversationId) {
    const existing = await resolvedDeps.getConversation(
      projectPath,
      session.sessionName,
      conversationId,
    );
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    if (
      existing.pendingQueue.some((row) => queuedMessageNeedsReview(row.status))
    ) {
      logger.warn("queue.prompt_blocked_for_review", {
        ...scopeRef,
        conversationId,
      });
      throw new Error(
        "Review queued deliveries before sending another prompt.",
      );
    }
    // Backend is locked after the first prompt has been sent
    if (options?.backend && options.backend !== existing.agentBackend) {
      if (existing.promptCount > 0) {
        const err = new BackendMismatchError(
          existing.agentBackend,
          options.backend,
        );
        logger.warn("prompt.backend_mismatch", {
          conversationId,
          existingBackend: existing.agentBackend,
          requestedBackend: options.backend,
        });
        throw err;
      }
      backendAdoption = {
        conversationId,
        from: existing.agentBackend,
        to: options.backend,
      };
    }
    resolvedBackend = options?.backend ?? existing.agentBackend;
  } else {
    // New conversation: use explicit backend or config default
    if (options?.backend) {
      resolvedBackend = options.backend;
    } else {
      const config = await resolvedDeps.readConfig();
      resolvedBackend = config.defaultAgentBackend ?? DEFAULT_AGENT_BACKEND_ID;
    }
    conversationCreation = {
      agentBackend: resolvedBackend,
      ...(options?.profile !== undefined ? { profile: options.profile } : {}),
    };
  }

  if (parsedCommand || isCollab)
    admitCommand(
      resolvedBackend,
      isCollab ? "/collab" : `/${parsedCommand!.command}`,
    );

  const commandModelSelection = parsedCommand
    ? modelSelection === undefined
      ? undefined
      : await admitExplicitModelSelection({
          projectPath,
          backend: resolvedBackend,
          selection: modelSelection,
          factory: resolvedDeps.getConversationBackendFactory(resolvedBackend),
        })
    : undefined;

  if (backendAdoption !== undefined) {
    await resolvedDeps.setConversationBackend(
      projectPath,
      session.sessionName,
      backendAdoption.conversationId,
      backendAdoption.to,
    );
    logger.info("prompt.backend_adopted", backendAdoption);
  }
  if (conversationCreation !== undefined) {
    const conversation = await resolvedDeps.createConversation(
      projectPath,
      session.sessionName,
      conversationCreation,
    );
    conversationId = conversation.id;
  }
  if (conversationId === undefined) {
    throw new Error("Conversation resolution did not produce an id");
  }

  if (parsedCommand) {
    logger.info("prompt.command_detected", {
      entry: "prompt-stream",
      command: parsedCommand.command,
      hintLength: parsedCommand.hint.length,
      ...scopeRef,
      conversationId,
      modelSelection: commandModelSelection ?? null,
    });
    if (!resolvedDeps.dispatchConversationCommand) {
      logger.error("prompt.command_dispatcher_unavailable", {
        command: parsedCommand.command,
        ...scopeRef,
        conversationId,
      });
      throw new ConversationCommandDispatcherUnavailableError();
    }
    // The project-conversation entry synthesizes a sentinel session; the
    // service treats that as "no session worktree" (rejection 1.5) while the
    // sentinel still addresses the project scope for the rejection notice.
    const hasSessionWorktree = !isProjectSentinel(session.sessionName);
    try {
      const outcome = await resolvedDeps.dispatchConversationCommand({
        projectPath,
        projectName: resolvedDeps.getProjectDisplayName(projectPath),
        sessionName: hasSessionWorktree ? session.sessionName : null,
        ...(hasSessionWorktree
          ? {}
          : { noticeSessionName: session.sessionName }),
        conversationId,
        parsed: parsedCommand,
        rawText: promptText,
        ...(commandModelSelection !== undefined
          ? { modelSelection: commandModelSelection }
          : {}),
      });
      logger.info("prompt.command_complete", {
        command: parsedCommand.command,
        status: outcome.status,
        ...scopeRef,
        conversationId,
      });
      await notifyPromptAccepted(options, scopeRef, conversationId);
      const ticketFallback = ticketCommandFallbackMessage(outcome);
      if (ticketFallback !== null) {
        logger.warn("prompt.command_ticket_fallback", {
          command: parsedCommand.command,
          status: outcome.status,
          ...scopeRef,
          conversationId,
        });
        emit("error", {
          message: ticketFallback,
        });
      }
      emit("done", {});
      return {
        conversationId,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Conversation command failed";
      logger.error("prompt.command_failed", {
        command: parsedCommand.command,
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

  if (isCollab) {
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

  // Validate an explicit selection via the backend factory before execution.
  const factory = resolvedDeps.getConversationBackendFactory(resolvedBackend);
  const turnModelSelection =
    modelSelection === undefined
      ? undefined
      : await admitExplicitModelSelection({
          projectPath,
          backend: resolvedBackend,
          selection: modelSelection,
          factory,
        });

  const streamId = randomUUID();
  const streamedErrors = new Set<string>();
  const emitProgress = (event: string, data: unknown) => {
    if (
      event === "error" &&
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      streamedErrors.add(data.message);
    }
    emit(event, data);
  };

  logger.info("prompt.submit", {
    ...scopeRef,
    promptLength: promptText.length,
    modelSelection: turnModelSelection ?? null,
    backend: resolvedBackend,
    conversationId,
  });

  const admission = await resolvedDeps.submitConversationTurn({
    binding: options?.binding ?? {
      kind: "durable",
      address: {
        projectPath,
        target: targetFromStoreSessionName(
          resolvedDeps.getProjectDisplayName(projectPath),
          session.sessionName,
          conversationId,
        ),
      },
      ...(options?.executionTarget
        ? { worktreePath: options.executionTarget.worktreePath }
        : {}),
    },
    transport: { streamId, emit: emitProgress },
    executionContext: {
      tooling: options?.tooling,
      workflowContext: options?.workflowContext,
    },
    signal: options?.signal,
    waitUntilReady: options?.waitForConversationReady,
    turn: {
      ...promptStreamTurnOptionsSchema.parse(options ?? {}),
      promptText,
      images,
      backend: resolvedBackend,
      modelSelection: turnModelSelection,
    },
  });
  if (admission.kind === "refused") {
    logger.warn("prompt.submit_rejected", {
      conversationId,
      ...scopeRef,
      reason: admission.code,
    });
    emitErrorAndDone(emit, admission.message);
    return {
      conversationId,
      contextTokens: null,
      contextWindowMax: null,
      aborted: admission.code === "cancelled",
      compacted: false,
      error: admission.message,
    };
  }
  await notifyPromptAccepted(options, scopeRef, conversationId);
  const settled = await admission.turn.completed;
  const result = toPromptStreamResult(settled.outcome, conversationId);
  if (result.error && !streamedErrors.has(result.error))
    emit("error", { message: result.error });

  logger.info("prompt.complete", {
    ...scopeRef,
    conversationId,
    failed: Boolean(result.error),
    aborted: result.aborted ?? false,
  });

  emit("done", {});
  return result;
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

export interface ModelSelectionValidationErrorInput {
  code: string;
  message: string;
  modelId: string;
  parameterId?: string;
}

export class ModelSelectionValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  readonly modelId: string;
  readonly parameterId?: string;

  constructor(input: ModelSelectionValidationErrorInput) {
    super(input.message);
    this.name = "ModelSelectionValidationError";
    this.code = input.code;
    this.modelId = input.modelId;
    this.parameterId = input.parameterId;
  }
}

function modelSelectionErrorDetails(
  error: unknown,
  selection: BackendModelSelection,
): ModelSelectionValidationErrorInput {
  if (error instanceof ModelSelectionPolicyError) {
    const issue = error.issues[0];
    return {
      code: issue?.code ?? "selection_invalid",
      message: error.message,
      modelId: issue?.modelId ?? selection.modelId,
      ...(issue?.parameterId !== undefined
        ? { parameterId: issue.parameterId }
        : {}),
    };
  }

  return {
    code: "selection_invalid",
    message: getErrorMessage(error),
    modelId: selection.modelId,
  };
}

async function admitExplicitModelSelection(input: {
  projectPath: string;
  backend: AgentBackendId;
  selection: BackendModelSelection;
  factory: ConversationBackendFactory;
}): Promise<BackendModelSelection> {
  const { projectPath, backend, selection, factory } = input;

  if (factory.validateModelSelection) {
    try {
      factory.validateModelSelection(selection);
    } catch (error) {
      const details = modelSelectionErrorDetails(error, selection);
      logger.warn("model_selection.rejected", {
        backend,
        modelId: details.modelId,
        code: details.code,
        ...(details.parameterId !== undefined
          ? { parameterId: details.parameterId }
          : {}),
      });
      throw new ModelSelectionValidationError(details);
    }
  }

  let canonicalSelection = selection;
  if (factory.validateProjectModelSelection) {
    const validation = await factory.validateProjectModelSelection({
      projectPath,
      modelSelection: selection,
    });
    if (!validation.ok) {
      logger.warn("model_selection.rejected", {
        backend,
        modelId: validation.modelId,
        code: validation.code,
        ...(validation.parameterId !== undefined
          ? { parameterId: validation.parameterId }
          : {}),
      });
      throw new ModelSelectionValidationError(validation);
    }
    canonicalSelection = validation.modelSelection;
  }

  logger.debug("model_selection.resolved", {
    backend,
    modelId: canonicalSelection.modelId,
    parameterIds: Object.keys(canonicalSelection.parameters).sort(),
    sourceLayer: "request",
  });
  return canonicalSelection;
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
import { admitCommand } from "@/lib/commands/admission";
