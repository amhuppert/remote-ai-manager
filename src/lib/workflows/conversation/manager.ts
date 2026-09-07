import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { readRuntimeInstructions } from "./runtime-instructions";
import type { DesiredRuntimeConfiguration } from "./pre-turn/runtime-recreate";
import { conversationStoreIdentity } from "@/lib/conversations/conversation-target";
import { AgentProfileNotResolvableError } from "@/lib/agent-profiles/library-service";
import {
  conversationBindingSchema,
  normalizeTurn,
  type ConversationAddress,
  type ConversationBinding,
  type ConversationTurnSubmission,
  type TurnAdmission,
  type TurnAdmissionRefusal,
  type TurnCancelReason,
} from "./turn-spec";
import type { SettledConversationTurn } from "./turn-result";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import { TurnAttempt } from "./turn-attempt";
import { conversationTurnSpecSchema } from "./turn-spec";
import {
  registerAbortController,
  unregisterAbortController,
} from "@/lib/conversations/abort-registry";
import {
  targetFromStoreSessionName,
  conversationTargetStoreSessionName,
  conversationTargetLogFields,
} from "@/lib/conversations/conversation-target";

import { type ConversationActorRef } from "./machine";
import type { ConversationEvent } from "./types";
import { conversationRuntimeKey } from "./runtime-state";
import {
  type ConversationPersistenceAdapter,
  forgetConversationPersistence,
} from "./persistence-adapter";
import { createLogger } from "@/lib/logging";
import {
  ConversationBindingNotFoundError,
  type EnsureActorInputData,
} from "./actor-input-loader";

import { admitConversationProfileForTurn } from "@/lib/conversations/profile-admission";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import { drainConversationQueue } from "@/lib/conversations/message-queue-drain";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conversation-manager");
export {
  applySyncDerivedFields,
  deriveActiveTurnSource,
} from "./persistence-adapter";

export interface ActiveConversationTurnDescription {
  readonly autonomous: boolean;
  readonly originMessageId: string | null;
}

/** The outcome belongs to the admitted attempt; refusals contain no preceding turn result. */
export type ConversationTurnExecution =
  | TurnAdmissionRefusal
  | { kind: "settled"; turn: SettledConversationTurn };

interface ConversationQuestionBatch {
  questionId: string;
  questions: AskQuestionItem[];
}
type QuestionCommand =
  | ({ kind: "register_question" } & ConversationQuestionBatch)
  | { kind: "clear_question"; questionId: string };

export interface ConversationAdmissionDeps {
  readState(identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<{ found: boolean; requiresQueueReview: boolean }>;
}

class ConversationBindingMismatchError extends Error {}

export type ConversationCommandOutcome =
  | { kind: "applied" | "unchanged" }
  | {
      kind: "refused";
      code: "not_found" | "busy" | "invalid_state";
      message: string;
    };

export interface EnsureConversationActorDeps {
  loadActorInput(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<EnsureActorInputData>;
}

interface EnsureActorOptions {
  executionTarget?: Pick<ExecutionTarget, "worktreePath">;
}

function waitWithCancellation<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted)
    return Promise.reject(
      new DOMException("Turn admission cancelled", "AbortError"),
    );
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      reject(new DOMException("Turn admission cancelled", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

function waitForAcceptance(
  actor: ConversationActorRef,
  event: ConversationEvent,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(
      new DOMException("Turn admission cancelled", "AbortError"),
    );
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      subscription.unsubscribe();
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () =>
      finish(new DOMException("Turn admission cancelled", "AbortError"));
    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.status !== "active")
        return finish(new Error("Conversation lifecycle stopped"));
      if (snapshot.can(event)) finish();
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (actor.getSnapshot().can(event)) finish();
  });
}
import {
  readUsableSnapshot,
  isActorSettled,
  type ConversationActorHost,
} from "./actor-host";
import type { ConversationContext } from "./types";
import type { ConversationRuntimeState } from "./runtime-state";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import { createProductionConversationManagerDependencies } from "./production";

export interface ConversationManagerDependencies {
  readRuntimeInstructions(
    input: Parameters<typeof readRuntimeInstructions>[1],
  ): ReturnType<typeof readRuntimeInstructions>;
  rehydrate(host: ConversationActorHost): Promise<number>;
  createHost(callbacks: {
    executeDebugCommand(
      address: ConversationAddress,
      command: DebugCommand,
    ): Promise<ConversationCommandOutcome>;
    drainQueue(context: ConversationContext): void;
  }): ConversationActorHost;
  getRuntime(key: string): ConversationRuntimeState | undefined;
  loadActorInput(
    ...args: Parameters<EnsureConversationActorDeps["loadActorInput"]>
  ): ReturnType<EnsureConversationActorDeps["loadActorInput"]>;
  readAdmissionState(
    ...args: Parameters<ConversationAdmissionDeps["readState"]>
  ): ReturnType<ConversationAdmissionDeps["readState"]>;
  admitProfileForTurn(
    ...args: Parameters<typeof admitConversationProfileForTurn>
  ): ReturnType<typeof admitConversationProfileForTurn>;
  queue: ConversationQueueDeps;
  persistence(mode: "durable" | "ephemeral"): ConversationPersistenceAdapter;
  forgetPersistence(
    ...args: Parameters<typeof forgetConversationPersistence>
  ): ReturnType<typeof forgetConversationPersistence>;
  abortIndex: {
    register(
      ...args: Parameters<typeof registerAbortController>
    ): ReturnType<typeof registerAbortController>;
    unregister(
      ...args: Parameters<typeof unregisterAbortController>
    ): ReturnType<typeof unregisterAbortController>;
  };
}

export function createConversationManager(
  deps: ConversationManagerDependencies,
) {
  const host = deps.createHost({
    drainQueue: drainAfterTurn,
    executeDebugCommand: executeConversationCommand,
  });
  function restorePersistedConversations(): Promise<number> {
    return deps.rehydrate(host);
  }

  function describeActiveTurn(
    address: ConversationAddress,
  ): ActiveConversationTurnDescription | null {
    const identity = conversationStoreIdentity(address);
    const runtime = deps.getRuntime(
      conversationRuntimeKey(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      ),
    );
    if (!runtime) return null;
    return {
      autonomous: runtime.currentTurnAutonomous === true,
      originMessageId: runtime.currentTurnMessageId ?? null,
    };
  }

  function getConversationTooling(
    address: ConversationAddress,
  ):
    | Readonly<
        import("@/lib/agent-backends/types").ConversationToolingOverrides
      >
    | undefined {
    const identity = conversationStoreIdentity(address);
    return deps.getRuntime(
      conversationRuntimeKey(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      ),
    )?.tooling;
  }

  async function runConversationCommand(
    address: ConversationAddress,
    command: DebugCommand | QuestionCommand,
  ): Promise<ConversationCommandOutcome> {
    const identity = conversationStoreIdentity(address);
    if (command.kind === "retry_turn") {
      const accepted = await retryConversationTurn(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
      return accepted
        ? { kind: "applied" }
        : {
            kind: "refused",
            code: "invalid_state",
            message: "No failed turn is available to retry",
          };
    }
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const actor = getConversationActor(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const runtime = deps.getRuntime(key);
    if (!actor || !runtime)
      return {
        kind: "refused",
        code: "not_found",
        message: "Conversation host not found",
      };
    const previous = runtime.command ?? Promise.resolve();
    const completion = previous
      .catch(() => {})
      .then(async (): Promise<ConversationCommandOutcome> => {
        if (
          deps.getRuntime(key) !== runtime ||
          runtime.stopping ||
          runtime.disposing
        )
          return {
            kind: "refused",
            code: "busy",
            message: "Conversation host is stopping",
          };
        if (runtime.durabilityFailure) throw runtime.durabilityFailure.error;
        const before = actor.getSnapshot().context;
        if (
          command.kind === "set_recording" &&
          before.debugMode?.active &&
          before.debugMode.recording === command.recording
        )
          return { kind: "unchanged" };
        if (
          command.kind === "clear_question" &&
          before.pendingQuestion?.questionId !== command.questionId
        )
          return { kind: "unchanged" };
        if (
          command.kind === "register_question" &&
          before.pendingQuestion !== null
        )
          return {
            kind: "refused",
            code: "invalid_state",
            message: "A question batch is already pending",
          };
        const event: ConversationEvent =
          command.kind === "register_question"
            ? {
                type: "ASK_QUESTION",
                questionId: command.questionId,
                questions: command.questions,
              }
            : command.kind === "clear_question"
              ? {
                  type: "CLEAR_PENDING_QUESTION",
                  questionId: command.questionId,
                }
              : { type: "DEBUG_COMMAND", command };
        if (!actor.getSnapshot().can(event))
          return {
            kind: "refused",
            code: "invalid_state",
            message: "Command is not valid in the current conversation state",
          };
        actor.send(event);
        const context = actor.getSnapshot().context;
        try {
          if (command.kind === "exit")
            await Promise.allSettled(runtime.debugVerificationWork ?? []);
          await deps
            .persistence(context.transient ? "ephemeral" : "durable")
            .whenDurable(context);
        } catch (error) {
          runtime.durabilityFailure = { context, error };
          throw error;
        }
        logger.info("conversation.command_committed", {
          ...conversationTargetLogFields(address.target),
          command: command.kind,
        });
        return { kind: "applied" };
      });
    runtime.command = completion;
    void completion
      .finally(() => {
        if (runtime.command === completion) runtime.command = undefined;
      })
      .catch(() => {});
    return completion;
  }

  /** Queue admission waits for the admitted attempt to release ownership. */
  function drainAfterTurn(
    context: Parameters<typeof drainConversationQueue>[0],
  ): void {
    const key = conversationRuntimeKey(
      context.projectPath,
      conversationTargetStoreSessionName(context.target),
      context.target.conversationId,
    );
    const runtime = deps.getRuntime(key);
    if (
      !runtime ||
      runtime.stopping ||
      runtime.disposing ||
      runtime.durabilityFailure
    )
      return;
    const queueDeps = deps.queue;
    const drain = () => {
      if (runtime?.stopping || runtime?.disposing || runtime?.durabilityFailure)
        return;
      if (deps.getRuntime(key) !== runtime) return;
      return drainConversationQueue(context, queueDeps);
    };
    if (runtime?.attempt) {
      void runtime.attempt.completed.then(drain).catch((error) =>
        logger.error("queue.settlement_wait_failed", {
          ...scopeRefFromStoreSessionName(
            conversationTargetStoreSessionName(context.target),
          ),
          conversationId: context.target.conversationId,
          error: getErrorMessage(error),
        }),
      );
      return;
    }
    void drain();
  }

  /**
   * Get a running conversation actor.
   */
  function getConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): ConversationActorRef | undefined {
    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversationId,
    );
    return host.get(key);
  }

  /**
   * Whether a live conversation actor owns this conversation. The queue route
   * uses this to decide whether it must run abandoned-delivery recovery itself
   * (no live actor owns the in-flight attempt) before evaluating cancellation.
   */
  function hasLiveConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean {
    return host.has(
      conversationRuntimeKey(projectPath, sessionName, conversationId),
    );
  }

  /**
   * Ensure a conversation actor exists, creating one if needed.
   * Loads conversation state from the state file to build input.
   *
   * When `options.executionTarget` is supplied, the actor's input
   * `worktreePath` uses `executionTarget.worktreePath` instead of the session's
   * persisted worktreePath. If an actor for this conversation already exists
   * with a different worktreePath in its context, the function:
   *   - stops and recreates it when the actor is idle (safe transition); or
   *   - throws an infrastructure error when the actor is mid-turn (running),
   *     because rebinding a running turn to a different worktree would corrupt
   *     in-flight state.
   */
  async function ensureConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    options?: EnsureActorOptions,
  ): Promise<ConversationActorRef> {
    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversationId,
    );
    const pending = pendingActorStarts.get(key);
    if (pending) {
      await pending;
      return ensureConversationActor(
        projectPath,
        sessionName,
        conversationId,
        options,
      );
    }
    const start = ensureConversationActorUnserialized(
      projectPath,
      sessionName,
      conversationId,
      options,
    );
    pendingActorStarts.set(key, start);
    try {
      return await start;
    } finally {
      pendingActorStarts.delete(key);
    }
  }

  const pendingActorStarts = new Map<string, Promise<ConversationActorRef>>();

  async function ensureConversationActorUnserialized(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    options?: EnsureActorOptions,
  ): Promise<ConversationActorRef> {
    const existing = getConversationActor(
      projectPath,
      sessionName,
      conversationId,
    );

    // Diagnostic identity (R1.3): the actor registry is session-keyed, so
    // `sessionName` is the sentinel for a project conversation.
    const scopeRef = scopeRefFromStoreSessionName(sessionName);
    const requestedWorktreePath = options?.executionTarget?.worktreePath;

    // An entry that cannot answer for itself is not reusable at all: it cannot be
    // proven to match the requested target, and it cannot be shown to be
    // mid-turn. Discard it and fall through to a fresh build — the alternative is
    // a `TypeError` that halts the whole graph-workflow execution loop on a
    // dispatch the conversation record could have served.
    const existingSnapshot = existing ? readUsableSnapshot(existing) : null;
    if (existing && existingSnapshot === null) {
      logger.warn("conversation-manager.unusable_actor_rebuilt", {
        conversationId,
        ...scopeRef,
        requestedWorktreePath: requestedWorktreePath ?? null,
      });
      await stopConversationActor(
        projectPath,
        sessionName,
        conversationId,
        "unusable_actor",
      );
    } else if (existing && existingSnapshot !== null) {
      if (requestedWorktreePath === undefined) {
        return existing;
      }
      const currentWorktreePath = existingSnapshot.context.worktreePath;
      if (currentWorktreePath === requestedWorktreePath) {
        return existing;
      }
      const runtime = deps.getRuntime(
        conversationRuntimeKey(projectPath, sessionName, conversationId),
      );
      // A parked debug phase retains its retry spec; disposal drains its verifier.
      const parkedDebug =
        existingSnapshot.value === "debug" &&
        runtime?.attempt === undefined &&
        runtime?.admission === undefined;
      if (!isActorSettled(existing) && !parkedDebug) {
        logger.error("conversation-manager.execution_target_mismatch_running", {
          conversationId,
          ...scopeRef,
          currentWorktreePath,
          requestedWorktreePath,
        });
        throw new ConversationBindingMismatchError(
          `Conversation actor ${conversationId} is running with worktreePath=${currentWorktreePath}; cannot rebind to executionTarget worktreePath=${requestedWorktreePath}`,
        );
      }
      logger.info(
        "conversation-manager.execution_target_mismatch_idle_rebind",
        {
          conversationId,
          ...scopeRef,
          previousWorktreePath: currentWorktreePath,
          requestedWorktreePath,
        },
      );
      await stopConversationActor(
        projectPath,
        sessionName,
        conversationId,
        "execution_target_rebind",
      );
    }

    const data = await deps.loadActorInput(
      projectPath,
      sessionName,
      conversationId,
    );

    if (data.persistence === "durable") {
      await deps.queue.recoverAbandonedDeliveries({
        projectPath,
        sessionName,
        conversationId,
      });
    }

    const worktreePath = requestedWorktreePath ?? data.sessionWorktreePath;

    return host.start({
      target: targetFromStoreSessionName(
        data.projectName,
        sessionName,
        conversationId,
      ),

      projectPath,

      worktreePath,

      persistence: data.persistence,
      ...data.conversation,
    });
  }

  /** Ensure the lifecycle is ready without exposing its actor implementation. */
  async function ensureConversationLifecycle(
    binding: ConversationBinding,
  ): Promise<void> {
    const identity = conversationStoreIdentity(binding.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const runtime = deps.getRuntime(
      conversationRuntimeKey(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      ),
    );
    if (
      runtime &&
      (runtime.stopFailure ||
        runtime.durabilityFailure ||
        runtime.reconciliation)
    ) {
      const reconciliation = (runtime.reconciliation ??= Promise.resolve().then(
        async () => {
          if (runtime.stopFailure) {
            runtime.managed.reconcileClose();
            await closeHostedRuntime(key);
            await Promise.allSettled(runtime.debugVerificationWork ?? []);
          }
          if (runtime.durabilityFailure) {
            const failure = runtime.durabilityFailure;
            if (failure.attempt?.requiresCloseRetry)
              runtime.managed.reconcileClose();
            await failure.attempt?.reconcile();
            await deps
              .persistence(failure.context.transient ? "ephemeral" : "durable")
              .reconcile(failure.context);
            if (runtime.durabilityFailure === failure)
              runtime.durabilityFailure = undefined;
            logger.info("conversation.finalization_reconciled", {
              ...conversationTargetLogFields(binding.address.target),
            });
          }
          if (runtime.stopFailure) {
            runtime.stopFailure = undefined;
            runtime.stopping = undefined;
            runtime.disposing = false;
          }
        },
      ));
      try {
        await reconciliation;
      } finally {
        if (runtime.reconciliation === reconciliation)
          runtime.reconciliation = undefined;
      }
    }
    await runtime?.stopping;
    await ensureBinding(conversationBindingSchema.parse(binding));
  }

  async function ensureBinding(
    binding: ConversationBinding,
  ): Promise<ConversationActorRef> {
    const identity = conversationStoreIdentity(binding.address);
    if (binding.kind === "durable") {
      const actor = await ensureConversationActor(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
        binding.worktreePath
          ? { executionTarget: { worktreePath: binding.worktreePath } }
          : undefined,
      );
      if (
        actor.getSnapshot().context.transient ||
        actor.getSnapshot().context.target.projectName !==
          binding.address.target.projectName
      )
        throw new ConversationBindingMismatchError(
          "Conversation target does not belong to the requested project",
        );
      return actor;
    }
    const existing = getConversationActor(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    if (existing) {
      const context = existing.getSnapshot().context;
      if (
        !context.transient ||
        context.agentBackend !== binding.backend ||
        context.target.projectName !== binding.address.target.projectName
      )
        throw new ConversationBindingMismatchError(
          "Conversation binding does not match the hosted execution",
        );
      if (context.worktreePath === binding.worktreePath) return existing;
      const runtime = deps.getRuntime(
        conversationRuntimeKey(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
        ),
      );
      if (runtime?.attempt || runtime?.admission || !isActorSettled(existing))
        throw new ConversationBindingMismatchError(
          "An active conversation cannot be rebound",
        );
      await stopConversationActor(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
        "execution_target_rebind",
      );
    }
    const now = new Date().toISOString();
    return host.start({
      projectPath: binding.address.projectPath,
      target: binding.address.target,
      persistence: "ephemeral",
      worktreePath: binding.worktreePath,
      agentBackend: binding.backend,
      role: binding.role,
      transcriptPath: binding.transcriptPath ?? null,
      createdAt: now,
      lastActivityAt: now,
      promptCount: 0,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      forkedFrom: null,
      backendRef: null,
    });
  }

  /** Reserve the host before profile admission; install execution inputs only for the accepted attempt. */
  async function submitConversationTurn(
    input: ConversationTurnSubmission,
  ): Promise<TurnAdmission> {
    const binding = conversationBindingSchema.parse(input.binding);
    if (
      binding.kind === "ephemeral" &&
      "queuedDelivery" in input.turn &&
      input.turn.queuedDelivery
    ) {
      return {
        kind: "refused",
        code: "binding_mismatch",
        message: "Queued delivery requires a durable conversation",
      };
    }
    if (input.signal?.aborted)
      return {
        kind: "refused",
        code: "cancelled",
        message: "Turn admission cancelled",
      };
    const identity = conversationStoreIdentity(binding.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    let actor: ConversationActorRef;
    try {
      actor = await ensureBinding(binding);
    } catch (error) {
      if (error instanceof ConversationBindingNotFoundError)
        return { kind: "refused", code: "not_found", message: error.message };
      if (error instanceof ConversationBindingMismatchError)
        return {
          kind: "refused",
          code: "binding_mismatch",
          message: error.message,
        };
      throw error;
    }
    const turn =
      input.turn.kind === "task_run"
        ? normalizeTurn(input.turn, actor.getSnapshot().context.agentBackend)
        : normalizeTurn(input.turn, actor.getSnapshot().context.agentBackend);
    const makeEvent = (executionAttemptId?: string): ConversationEvent =>
      turn.kind === "task_run"
        ? { ...turn, type: "SUBMIT_TASK_RUN", executionAttemptId }
        : {
            ...turn,
            type: "SUBMIT_PROMPT",
            streamId: input.transport?.streamId ?? null,
            executionAttemptId,
          };

    while (true) {
      if (input.signal?.aborted)
        return {
          kind: "refused",
          code: "cancelled",
          message: "Turn admission cancelled",
        };
      const runtime = deps.getRuntime(key);
      if (
        !runtime ||
        getConversationActor(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
        ) !== actor
      ) {
        return {
          kind: "refused",
          code: "binding_mismatch",
          message: "Conversation host changed during admission",
        };
      }
      if (runtime.durabilityFailure)
        return {
          kind: "refused",
          code: "busy",
          message: "Conversation finalization requires reconciliation",
        };
      if (runtime.disposing)
        return {
          kind: "refused",
          code: "binding_mismatch",
          message: "Conversation host is being disposed",
        };
      if (
        runtime.stopping ||
        runtime.command ||
        runtime.admission ||
        runtime.attempt ||
        !actor.getSnapshot().can(makeEvent())
      ) {
        if (!input.waitUntilReady)
          return {
            kind: "refused",
            code: "busy",
            message: "Conversation is not ready to accept a turn",
          };
        try {
          if (runtime.stopping)
            await waitWithCancellation(runtime.stopping, input.signal);
          else if (runtime.command)
            await waitWithCancellation(runtime.command, input.signal);
          else if (runtime.admission)
            await waitWithCancellation(runtime.admission.settled, input.signal);
          else if (runtime.attempt)
            await waitWithCancellation(runtime.attempt.completed, input.signal);
          else await waitForAcceptance(actor, makeEvent(), input.signal);
        } catch (error) {
          if (input.signal?.aborted)
            return {
              kind: "refused",
              code: "cancelled",
              message: "Turn admission cancelled",
            };
          throw error;
        }
        continue;
      }
      let release!: () => void;
      const reservation = {
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
        token: Symbol("turn-admission"),
        settled: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release: () => release(),
      };
      runtime.admission = reservation;
      try {
        // Settle the agent profile BEFORE the prompt reaches the actor (R8/D21).
        // Awaited, and after the acceptance check so a rejected turn does not
        // lock a profile it never ran under. Readiness is checked again after
        // this await so another turn cannot claim the actor in the gap.
        if (binding.kind === "durable") {
          const state = await deps.readAdmissionState(identity);
          if (!state.found)
            return {
              kind: "refused",
              code: "not_found",
              message: "Conversation not found",
            };
          if (state.requiresQueueReview)
            return {
              kind: "refused",
              code: "queue_review_required",
              message: "Review queued deliveries before sending another prompt",
            };
        }
        if (input.signal?.aborted || reservation.cancelled)
          return {
            kind: "refused",
            code: "cancelled",
            message: "Turn admission cancelled",
          };
        if (
          deps.getRuntime(key) !== runtime ||
          runtime.admission !== reservation ||
          !actor.getSnapshot().can(makeEvent())
        )
          return {
            kind: "refused",
            code: "binding_mismatch",
            message: "Conversation host changed during admission",
          };
        const profile =
          binding.kind === "durable"
            ? await deps.admitProfileForTurn(identity)
            : undefined;
        if (binding.kind === "durable") {
          const state = await deps.readAdmissionState(identity);
          if (!state.found)
            return {
              kind: "refused",
              code: "not_found",
              message: "Conversation not found",
            };
          if (state.requiresQueueReview)
            return {
              kind: "refused",
              code: "queue_review_required",
              message: "Review queued deliveries before sending another prompt",
            };
        }
        if (input.signal?.aborted || reservation.cancelled)
          return {
            kind: "refused",
            code: "cancelled",
            message: "Turn admission cancelled",
          };
        if (
          deps.getRuntime(key) !== runtime ||
          runtime.admission !== reservation ||
          !actor.getSnapshot().can(makeEvent())
        ) {
          return {
            kind: "refused",
            code: "binding_mismatch",
            message: "Conversation host changed during profile admission",
          };
        }
        const attempt: TurnAttempt = new TurnAttempt({
          conversationId: identity.conversationId,
          executionContext: input.executionContext,
          profile,
          isCurrent: (): boolean =>
            deps.getRuntime(key) === runtime && runtime.attempt === attempt,
          onCancel: (reason, executionAttemptId) =>
            actor.send({ type: "ABORT_TURN", reason, executionAttemptId }),
          closeRuntime: () => closeHostedRuntime(key),
        });
        runtime.attempt = attempt;
        runtime.abortController = attempt.controller;
        runtime.tooling = input.executionContext?.tooling;
        runtime.workflowContext = input.executionContext?.workflowContext;
        runtime.streamEmit = input.transport?.emit;
        deps.abortIndex.register(identity.conversationId, attempt.controller);
        attempt.ownDisposer(() =>
          deps.abortIndex.unregister(
            identity.conversationId,
            attempt.controller,
          ),
        );
        const cancel = () => {
          void attempt.cancel("user");
        };
        input.signal?.addEventListener("abort", cancel, { once: true });
        attempt.ownDisposer(() =>
          input.signal?.removeEventListener("abort", cancel),
        );
        if (
          turn.kind === "task_run" &&
          turn.timeoutMs !== undefined &&
          turn.timeoutMs > 0
        ) {
          const timer = setTimeout(() => {
            void attempt.cancel("timeout");
          }, turn.timeoutMs);
          attempt.ownDisposer(() => clearTimeout(timer));
        }
        actor.send(makeEvent(attempt.attemptId));
        logger.info("conversation-manager.turn_admitted", {
          ...conversationTargetLogFields(binding.address.target),
          attemptId: attempt.attemptId,
          kind: turn.kind,
        });
        return { kind: "accepted", turn: attempt };
      } catch (error) {
        if (error instanceof AgentProfileNotResolvableError) {
          return {
            kind: "refused",
            code: "profile_refused",
            message: error.message,
            error,
          };
        }
        throw error;
      } finally {
        if (runtime.admission === reservation) runtime.admission = undefined;
        reservation.release();
      }
    }
  }

  /** Retry preserves the failed prompt and phase while acquiring a distinct attempt. */
  async function retryConversationTurn(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<boolean> {
    const actor = getConversationActor(
      projectPath,
      sessionName,
      conversationId,
    );
    const context = actor && readUsableSnapshot(actor)?.context;
    if (
      !context?.debugMode?.lastTurnFailed ||
      context.activeTurn?.kind !== "conversation_turn"
    )
      return false;
    const address = {
      projectPath,
      target: targetFromStoreSessionName(
        context.target.projectName,
        sessionName,
        conversationId,
      ),
    };
    const binding: ConversationBinding = context.transient
      ? {
          kind: "ephemeral",
          address,
          worktreePath: context.worktreePath,
          backend: context.agentBackend,
          role: context.role,
          transcriptPath: context.transcriptPath,
        }
      : { kind: "durable", address, worktreePath: context.worktreePath };
    const admission = await submitConversationTurn({
      binding,
      turn: conversationTurnSpecSchema.strip().parse(context.activeTurn),
    });
    return admission.kind === "accepted";
  }

  /** Execute one accepted attempt and return only that attempt's settlement. */
  async function executeConversationTurn(
    input: ConversationTurnSubmission,
  ): Promise<ConversationTurnExecution> {
    const admission = await submitConversationTurn(input);
    if (admission.kind === "refused") return admission;
    return { kind: "settled", turn: await admission.turn.completed };
  }

  /**
   * Ensure the conversation actor is running and deliver any pending queued
   * messages now. Used to route an out-of-band enqueued turn (e.g. the /align
   * authoring turn) into a conversation that may have no in-flight turn — without
   * this the row sits `pending` because in-turn delivery has no live runtime and
   * the next-turn drain only fires on a live actor's idle entry.
   *
   * A freshly started actor drains on its startup idle entry. An actor that was
   * already registered and idle does NOT re-enter idle, so its entry-action drain
   * will not re-fire — drain it explicitly. A busy actor drains when its current
   * turn settles, so it needs no nudge here. Draining is fire-and-forget and a
   * no-op when the queue is empty, so the explicit drain is safe.
   */
  async function ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void> {
    const existing = getConversationActor(
      projectPath,
      sessionName,
      conversationId,
    );
    const actor = await ensureConversationActor(
      projectPath,
      sessionName,
      conversationId,
    );
    const explicitDrain = Boolean(existing) && isActorSettled(actor);
    logger.info("conversation-manager.ensure_and_drain", {
      ...scopeRefFromStoreSessionName(sessionName),
      conversationId,
      hadExistingActor: Boolean(existing),
      explicitDrain,
    });
    if (explicitDrain) {
      drainAfterTurn(actor.getSnapshot().context);
    }
  }

  function executeConversationCommand(
    address: ConversationAddress,
    command: DebugCommand,
  ): Promise<ConversationCommandOutcome> {
    return runConversationCommand(address, command);
  }

  async function runQuestionCommand(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    command: QuestionCommand,
  ): Promise<boolean> {
    const actor = getConversationActor(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!actor) return false;
    // An answer may already be committed. An unusable host refuses and is
    // disposed so the next queue nudge can reconstruct the committed state.
    const snapshot = readUsableSnapshot(actor);
    if (!snapshot) {
      logger.error("conversation-manager.incompatible_snapshot", {
        conversationId,
        ...scopeRefFromStoreSessionName(sessionName),
        command: command.kind,
      });
      await stopConversationActor(
        projectPath,
        sessionName,
        conversationId,
        "incompatible_snapshot",
      );
      return false;
    }
    const outcome = await runConversationCommand(
      { projectPath, target: snapshot.context.target },
      command,
    );
    return outcome.kind !== "refused";
  }

  function registerConversationQuestion(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    question: ConversationQuestionBatch,
  ): Promise<boolean> {
    return runQuestionCommand(projectPath, sessionName, conversationId, {
      kind: "register_question",
      ...question,
    });
  }

  function clearConversationQuestion(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    question: { questionId: string },
  ): Promise<boolean> {
    return runQuestionCommand(projectPath, sessionName, conversationId, {
      kind: "clear_question",
      ...question,
    });
  }

  async function closeHostedRuntime(key: string): Promise<void> {
    await deps.getRuntime(key)?.managed.close();
  }

  async function flushRuntimeDurability(
    actor: ConversationActorRef,
    runtime: ConversationRuntimeState,
  ): Promise<void> {
    const context = actor.getSnapshot().context;
    try {
      await deps
        .persistence(context.transient ? "ephemeral" : "durable")
        .whenDurable(context);
    } catch (error) {
      runtime.durabilityFailure = { context, error };
      throw error;
    }
    if (runtime.durabilityFailure) throw runtime.durabilityFailure.error;
  }

  /** Request cancellation synchronously; settlement proves that owned work has unwound. */
  function requestConversationStop(
    address: ConversationAddress,
    reason: TurnCancelReason,
  ): { requested: boolean; settled: Promise<void> } {
    const identity = conversationStoreIdentity(address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const actor = getConversationActor(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const runtime = deps.getRuntime(key);
    if (!actor || !runtime)
      return { requested: false, settled: Promise.resolve() };
    if (runtime.stopping) return { requested: true, settled: runtime.stopping };
    runtime.admission?.cancel();
    const admission = runtime.admission;
    const attempt = runtime.attempt;
    const requested =
      runtime.admission !== undefined ||
      attempt !== undefined ||
      !isActorSettled(actor);
    logger.info("conversation.stop_requested", {
      ...conversationTargetLogFields(address.target),
      reason,
      attemptId: attempt?.attemptId ?? null,
    });
    const completion = attempt?.cancel(reason);
    if (!attempt) {
      runtime.abortController.abort(reason);
      if (readUsableSnapshot(actor)?.can({ type: "ABORT_TURN", reason }))
        actor.send({ type: "ABORT_TURN", reason });
    }
    runtime.debugCleanupVerification?.controller.abort();
    const settled = (async () => {
      const turn = await completion;
      if (
        turn?.outcome.kind === "settlement_failed" &&
        turn.outcome.code === "runtime_close"
      )
        throw new Error(turn.outcome.message);
      await admission?.settled;
      await runtime.command;
      await closeHostedRuntime(key);
      await Promise.allSettled(runtime.debugVerificationWork ?? []);
      await flushRuntimeDurability(actor, runtime);
      logger.info("conversation.stop_settled", {
        ...conversationTargetLogFields(address.target),
        reason,
        attemptId: attempt?.attemptId ?? null,
      });
    })();
    runtime.stopping = settled;
    void settled.then(
      () => {
        if (runtime.stopping === settled) runtime.stopping = undefined;
      },
      (error: unknown) => {
        runtime.stopFailure = error;
      },
    );
    return { requested, settled };
  }

  /** Drain a conversation's owned execution before evicting its host. */
  async function stopConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversationId,
    );
    const actor = host.get(key);
    if (!actor) return;
    const ownedRuntime = deps.getRuntime(key);
    if (ownedRuntime) ownedRuntime.disposing = true;
    logger.info("conversation-manager.stopping_actor", {
      conversationId,
      reason,
    });
    const snapshot = readUsableSnapshot(actor);
    if (
      reason === "server_shutdown" &&
      snapshot &&
      isActorSettled(actor) &&
      ownedRuntime &&
      !ownedRuntime.admission &&
      !ownedRuntime.attempt &&
      !ownedRuntime.stopping
    ) {
      ownedRuntime.debugCleanupVerification?.controller.abort();
      await ownedRuntime.command;
      await closeHostedRuntime(key);
      await Promise.allSettled(ownedRuntime.debugVerificationWork ?? []);
      await flushRuntimeDurability(actor, ownedRuntime);
      logger.info("conversation-manager.settled_actor_drained", {
        conversationId,
        reason,
        pendingQuestionId:
          actor.getSnapshot().context.pendingQuestion?.questionId ?? null,
      });
    } else if (snapshot) {
      await requestConversationStop(
        {
          projectPath,
          target: targetFromStoreSessionName(
            snapshot.context.target.projectName,
            sessionName,
            conversationId,
          ),
        },
        "shutdown",
      ).settled;
    } else {
      const runtime = deps.getRuntime(key);
      await runtime?.attempt?.cancel("shutdown");
      await closeHostedRuntime(key);
    }
    if (host.get(key) !== actor) return;
    deps.forgetPersistence({ projectPath, sessionName, conversationId });
    // Unregistering has to happen even when the actor refuses to stop: the entry
    // being discarded is often the one that has already proved unusable, and
    // leaving it in a `globalThis` registry would make every later lookup find
    // the same broken actor with no way to evict it.
    try {
      actor.stop();
    } catch (error) {
      logger.warn("conversation-manager.actor_stop_error", {
        conversationId,
        reason,
        error: getErrorMessage(error),
      });
    }

    host.remove(key, actor);
  }
  function getConversationRuntimeConfiguration(
    conversationId: string,
  ):
    | Readonly<import("./pre-turn/runtime-recreate").RecreateRuntimeSnapshot>
    | undefined {
    for (const [key, actor] of host.entries()) {
      if (
        readUsableSnapshot(actor)?.context.target.conversationId !==
        conversationId
      )
        continue;
      return deps.getRuntime(key)?.managed.configurationSnapshot;
    }
    return undefined;
  }
  async function readDesiredConversationRuntimeConfiguration(
    conversationId: string,
    current: DesiredRuntimeConfiguration,
  ): Promise<DesiredRuntimeConfiguration> {
    for (const [, actor] of host.entries()) {
      const context = readUsableSnapshot(actor)?.context;
      if (context?.target.conversationId !== conversationId) continue;
      const instructions = await deps.readRuntimeInstructions({
        projectPath: context.projectPath,
        worktreePath: context.worktreePath,
        target: context.target,
        turn: current.instructionSelection,
      });
      return {
        ...current,
        repeatableInstructions: instructions.repeatableInstructions,
        alignmentVersion: instructions.alignmentVersion,
      };
    }
    return current;
  }
  async function stopAllConversationActors(): Promise<void> {
    const results = await Promise.allSettled(
      host.entries().map(async ([, actor]) => {
        const context = actor.getSnapshot().context;
        await stopConversationActor(
          context.projectPath,
          conversationTargetStoreSessionName(context.target),
          context.target.conversationId,
          "server_shutdown",
        );
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        "Conversation shutdown did not complete",
      );
  }
  return {
    getConversationRuntimeConfiguration,
    readDesiredConversationRuntimeConfiguration,
    stopAllConversationActors,
    restorePersistedConversations,
    describeActiveTurn,
    getConversationTooling,
    executeConversationCommand,
    hasLiveConversationActor,
    ensureConversationLifecycle,
    submitConversationTurn,
    retryConversationTurn,
    executeConversationTurn,
    ensureConversationActorAndDrain,
    registerConversationQuestion,
    clearConversationQuestion,
    requestConversationStop,
    stopConversationActor,
  };
}
export type ConversationManager = ReturnType<typeof createConversationManager>;

let productionManager: ConversationManager | undefined;
function defaultManager(): ConversationManager {
  return (productionManager ??= createConversationManager(
    createProductionConversationManagerDependencies(),
  ));
}

export function describeActiveTurn(
  address: ConversationAddress,
): ActiveConversationTurnDescription | null {
  return defaultManager().describeActiveTurn(address);
}

export function getConversationTooling(
  address: ConversationAddress,
):
  | Readonly<import("@/lib/agent-backends/types").ConversationToolingOverrides>
  | undefined {
  return defaultManager().getConversationTooling(address);
}

export function executeConversationCommand(
  address: ConversationAddress,
  command: DebugCommand,
): Promise<ConversationCommandOutcome> {
  return defaultManager().executeConversationCommand(address, command);
}

export function hasLiveConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): boolean {
  return defaultManager().hasLiveConversationActor(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function ensureConversationLifecycle(
  binding: ConversationBinding,
): Promise<void> {
  return defaultManager().ensureConversationLifecycle(binding);
}

export function submitConversationTurn(
  input: ConversationTurnSubmission,
): Promise<TurnAdmission> {
  return defaultManager().submitConversationTurn(input);
}

export function retryConversationTurn(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<boolean> {
  return defaultManager().retryConversationTurn(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function executeConversationTurn(
  input: ConversationTurnSubmission,
): Promise<ConversationTurnExecution> {
  return defaultManager().executeConversationTurn(input);
}

export function ensureConversationActorAndDrain(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  return defaultManager().ensureConversationActorAndDrain(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function registerConversationQuestion(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  question: ConversationQuestionBatch,
): Promise<boolean> {
  return defaultManager().registerConversationQuestion(
    projectPath,
    sessionName,
    conversationId,
    question,
  );
}

export function clearConversationQuestion(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  question: { questionId: string },
): Promise<boolean> {
  return defaultManager().clearConversationQuestion(
    projectPath,
    sessionName,
    conversationId,
    question,
  );
}

export function requestConversationStop(
  address: ConversationAddress,
  reason: TurnCancelReason,
): { requested: boolean; settled: Promise<void> } {
  return defaultManager().requestConversationStop(address, reason);
}

export function stopConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  return defaultManager().stopConversationActor(
    projectPath,
    sessionName,
    conversationId,
    reason,
  );
}

export function restorePersistedConversations(): Promise<number> {
  return defaultManager().restorePersistedConversations();
}

export function stopAllConversationActors(): Promise<void> {
  return defaultManager().stopAllConversationActors();
}

export function getConversationRuntimeConfiguration(
  conversationId: string,
):
  | Readonly<import("./pre-turn/runtime-recreate").RecreateRuntimeSnapshot>
  | undefined {
  return defaultManager().getConversationRuntimeConfiguration(conversationId);
}

export function readDesiredConversationRuntimeConfiguration(
  conversationId: string,
  current: DesiredRuntimeConfiguration,
): Promise<DesiredRuntimeConfiguration> {
  return defaultManager().readDesiredConversationRuntimeConfiguration(
    conversationId,
    current,
  );
}
