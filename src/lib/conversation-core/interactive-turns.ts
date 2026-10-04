import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import { targetFromStoreSessionName, type ConversationTarget } from "@/lib/conversations/conversation-target";
import type { AskQuestionItem, MessageContentBlock } from "@/lib/conversations/schemas";
import type { InTurnQuestionReply } from "@/lib/conversations/in-turn-question-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { TranscriptBroadcastMeta, TranscriptEntry } from "@/lib/prompt/transcript";
import type { QueuedDeliveryAccounting } from "@/lib/workflows/conversation/post-turn/queued-delivery-accounting";
import {
  composeUserTranscriptBlocks,
  resolveTurnPromptText,
} from "@/lib/workflows/conversation/pre-turn/review-feedback";
import type { QueuedDeliveryMetadata } from "@/lib/workflows/conversation/turn-spec";
import type { Logger } from "@/lib/logging";
import { isRuntimeCreatedWithoutResume } from "@/lib/memory/delivery-decision";
import { getErrorMessage } from "@/lib/shared/errors";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { fingerprintAssembledInput, fingerprintSubmittedInput } from "@/lib/conversation-checkpoints/input-fingerprint";
import type { PreparedCheckpointSeed } from "@/lib/workflows/conversation/pre-turn/checkpoint-seed";
import type { ContinuationSeed } from "@/lib/workflows/conversation/pre-turn/continuation-seed";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { PreparedConversationTurnContext, TurnContextExecution } from "@/lib/workflows/conversation/turn-context";
import { toPromptActorResult, type TurnExecutionOutcome, type TurnInterruption } from "@/lib/workflows/conversation/turn-result";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import { resolveDebugOutputFormat } from "@/lib/workflows/debug/prompt-policy";
import {
  QUEUE_REVIEW_REQUIRED_MESSAGE,
  runtimeDebugMode,
  settlementOf,
  type ConversationIdentity,
  type ConversationRecordPort,
} from "./conversation-record";
import type { TurnStream, UserTurnPort } from "./executor";
import { failedTurn, runRecordedTurn, turnResultOf, withCollection } from "./recorded-turn";
import type { RuntimeHost } from "./runtime-host";
import type { TurnEngine } from "./turn-engine";

export interface InteractiveContextRequest {
  execution: TurnContextExecution & { executionAttemptId: string };
  /** The message as the agent reads it: feedback rendered as prose, images numbered in. */
  promptText: string;
  runtimeCreatedWithoutResume: boolean;
  /** The one continuation this turn runs under; see `resolveContinuationSeed`. */
  continuation: ContinuationSeed;
  /** The ready checkpoint the turn delivers, exactly when `continuation` is one. */
  checkpoint: PreparedCheckpointSeed | null;
  /** Archives a queued delivery's input once accepted, without releasing its rows yet. */
  archiveQueuedInput(): Promise<void>;
  /** Archives (when not yet) and releases a queued delivery's rows; last in the acceptance order. */
  onQueueAccepted(): Promise<void>;
}

/** The per-turn context a person's message runs with, and the receipts it owes. */
export type InteractiveTurnContext = Pick<
  PreparedConversationTurnContext,
  | "promptText"
  | "dispatchPromptText"
  | "userPromptText"
  | "promptContext"
  | "markDispatched"
  | "markDispatchFailure"
  | "onInputAccepted"
  | "onBackendInit"
  | "finish"
>;

/** The conversation row as an interactive turn reads it. */
type ConversationRowRead = NonNullable<Awaited<ReturnType<ConversationRecordPort["read"]>>>;

/** A cleanup turn's report, handed to the debug workflow's verification. */
export interface DebugVerificationStart {
  identity: ConversationIdentity;
  worktreePath: string;
  structuredOutput: unknown;
  debugSessionId: string;
  attempt: number;
  /** The core attempt of the cleanup turn that reported, whose end the result waits for. */
  turnAttemptId: string;
}

export interface InteractiveTurnDeps {
  engine: Pick<TurnEngine, "runTurn">;
  records: ConversationRecordPort;
  host: Pick<RuntimeHost, "release" | "isLive">;
  /** Where the conversation's agent works: its session's worktree, or the project root for a project conversation. */
  worktreeOf(projectPath: string, target: ConversationTarget): Promise<string>;
  /** Explicit, else the conversation's last used, else the backend default; admitted for the project. */
  resolveModelSelection(input: {
    projectPath: string;
    backend: AgentBackendId;
    transcriptPath: string | null;
    explicit: BackendModelSelection | null;
  }): Promise<BackendModelSelection>;
  /**
   * What the message's runtime continues from: a ready checkpoint's frozen
   * seed in a fresh runtime, with its delivery receipt, or ordinary resume.
   */
  continuation(input: {
    identity: ConversationIdentity;
    row: ConversationRowRead;
  }): Promise<{ continuation: ContinuationSeed; seed: PreparedCheckpointSeed | null }>;
  prepareContext(request: InteractiveContextRequest): Promise<InteractiveTurnContext>;
  nameConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    content: string;
  }): void;
  /** Asks the person mid-turn and waits for the answer (the agent's native question tool). */
  requestUserQuestion(
    scope: { projectPath: string; sessionName: string; conversationId: string },
    questions: AskQuestionItem[],
    signal: AbortSignal,
  ): Promise<InTurnQuestionReply>;
  /** Saves the message's images with the transcript and numbers them into its text. */
  persistImages(input: {
    conversationId: string;
    promptText: string;
    images: ImagePayload[];
  }): Promise<{ promptText: string; imageRefs: ConversationImageRef[] }>;
  /** The queue's side of a delivered batch: archived and released on acceptance, held for review otherwise. */
  queuedDelivery(input: {
    identity: ConversationIdentity;
    delivery: QueuedDeliveryMetadata;
    appendUserEntry(): Promise<void>;
  }): QueuedDeliveryAccounting;
  /** A batch no turn sent stays in the queue, failed with the reason, for the person to resend or discard. */
  failQueued(input: { identity: ConversationIdentity; delivery: QueuedDeliveryMetadata; error: string }): Promise<void>;
  /** A batch that was never sent goes back to pending, to be delivered again. */
  returnQueued(input: { identity: ConversationIdentity; delivery: QueuedDeliveryMetadata; error: string }): Promise<void>;
  transcript: {
    appendTranscriptEntryOnce(
      conversationId: string,
      entry: TranscriptEntry & { id: string },
      meta: TranscriptBroadcastMeta,
    ): Promise<void>;
  };
  getProjectDisplayName(projectPath: string): string;
  /** Starts the debug workflow's check of a cleanup report; its result reaches the session as a debug command. */
  startDebugVerification(input: DebugVerificationStart): void;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** The message as the transcript keeps it and the agent reads it. */
interface PreparedInput {
  promptText: string;
  imageRefs: ConversationImageRef[];
  transcriptBlocks: MessageContentBlock[];
}

function outcomeMessage(outcome: TurnExecutionOutcome): string {
  if (outcome.kind === "not_started") return outcome.message;
  const call = outcome.result?.outcome;
  return call?.kind === "failed" ? call.error.message : "The turn ended before its input was sent";
}

function stoppedMessage(interruption: TurnInterruption): string {
  switch (interruption.reason) {
    case "timeout":
      return `Prompt execution timed out after ${interruption.timeoutMs}ms`;
    case "stalled":
      return `Prompt execution stalled: no agent activity for ${interruption.timeoutMs}ms`;
    case "shutdown":
      return "The server stopped while this turn was running";
    case "user":
      return "Prompt execution was cancelled";
  }
}

/**
 * What the person's request hears when the turn ends without succeeding: why
 * it stopped, or the failure, unless the backend already reported it live.
 */
function reportEnding(stream: TurnStream | null, outcome: TurnExecutionOutcome, streamedErrors: Set<string>): void {
  if (stream === null) return;
  const error = (message: string) => {
    if (!streamedErrors.has(message)) stream.emit("error", { message });
  };
  if (outcome.kind === "not_started") {
    if (outcome.interruption !== undefined) stream.emit("aborted", { message: stoppedMessage(outcome.interruption) });
    else if (outcome.reason === "cancelled") stream.emit("aborted", { message: "Prompt execution was cancelled" });
    else error(outcome.message);
    return;
  }
  if (outcome.interruption !== undefined) {
    stream.emit("aborted", { message: stoppedMessage(outcome.interruption) });
    return;
  }
  const call = outcome.result?.outcome;
  if (call?.kind === "failed") error(call.error.message);
}

/**
 * The context's receipts owe their durable evidence before the turn settles. A
 * required receipt reports its first failure and retries on the next finish,
 * so a failure gets that one retry; true when everything is settled.
 */
async function settleReceipts(
  context: InteractiveTurnContext,
  conversationId: string,
  log: Pick<Logger, "warn" | "error">,
): Promise<boolean> {
  try {
    await context.finish();
    return true;
  } catch (error) {
    log.warn("conversation_core.context_receipts_retry", { conversationId, error: getErrorMessage(error) });
  }
  try {
    await context.finish();
    return true;
  } catch (error) {
    log.error("conversation_core.context_receipts_unsettled", { conversationId, error: getErrorMessage(error) });
    return false;
  }
}

/**
 * The context's receipts and a delivered checkpoint's own, settled and retried
 * as one: the delivery receipt first, as the actor's attempt orders them.
 */
function withSeedReceipt(context: InteractiveTurnContext, seed: PreparedCheckpointSeed | null): InteractiveTurnContext {
  if (seed === null) return context;
  return {
    ...context,
    async finish() {
      const errors: unknown[] = [];
      for (const finish of [() => seed.finish(), () => context.finish()]) {
        await finish().catch((error: unknown) => errors.push(error));
      }
      if (errors.length > 0) throw new AggregateError(errors, "Turn receipts failed");
    },
  };
}

/** A person's messages to an enrolled conversation, and the receipts their turns still owe. */
export interface InteractiveTurns extends UserTurnPort {
  /**
   * Settles receipts the conversation's earlier turns could not, such as a
   * checkpoint delivery's acceptance; one that still fails stays retained.
   */
  settleRetained(conversationId: string): Promise<void>;
}

/**
 * A person's messages to an enrolled conversation, on the same turn engine and
 * row bookkeeping as seat turns: the ordinary conversation's context, model
 * and continuity, streamed live to the request that sent it.
 */
export function createInteractiveTurns(deps: InteractiveTurnDeps): InteractiveTurns {
  /**
   * Receipts still unsettled when their turn ended keep an owner here and are
   * settled before the conversation's next turn prepares its own context.
   */
  const unsettled = new Map<string, InteractiveTurnContext[]>();
  /** One settlement per conversation at a time: a turn waits for one a hold check started. */
  const settling = new Map<string, Promise<void>>();

  async function settleRetainedNow(conversationId: string): Promise<void> {
    const retained = unsettled.get(conversationId) ?? [];
    unsettled.delete(conversationId);
    const still: InteractiveTurnContext[] = [];
    for (const context of retained) {
      await context.finish().catch((error: unknown) => {
        deps.log.error("conversation_core.context_receipts_unsettled", { conversationId, error: getErrorMessage(error) });
        still.push(context);
      });
    }
    if (still.length > 0) unsettled.set(conversationId, [...still, ...(unsettled.get(conversationId) ?? [])]);
  }

  function settleRetained(conversationId: string): Promise<void> {
    const next = (settling.get(conversationId) ?? Promise.resolve()).then(() => settleRetainedNow(conversationId));
    settling.set(conversationId, next);
    void next.finally(() => {
      if (settling.get(conversationId) === next) settling.delete(conversationId);
    });
    return next;
  }

  return {
    settleRetained,
    async notStarted({ conversationId, enrollment, request, reason, endedBy }) {
      const delivery = request.queuedDelivery;
      const identity = { projectPath: enrollment.projectPath, storeSessionName: enrollment.sessionName, conversationId };
      if (delivery === undefined) {
        // A debug turn the person stopped before it started still failed its phase, and can be retried.
        if (endedBy !== "person") return;
        const row = await deps.records.read(identity);
        if (row === null || runtimeDebugMode(row.debugMode) === null) return;
        await deps.records.settleTurn(identity, settlementOf({ kind: "not_started", reason: "cancelled", message: reason }), "user");
        return;
      }
      // Provably never sent: a batch the server stopped is delivered after the restart.
      if (endedBy === "server") {
        await deps.returnQueued({ identity, delivery, error: "The server stopped before it was sent" });
        return;
      }
      await deps.failQueued({
        identity,
        delivery,
        error: endedBy === "person" ? "Stopped before it was sent" : `Not sent: ${reason}`,
      });
    },
    async run({ conversationId, enrollment, request, attemptId, signal, stream }) {
      const identity = {
        projectPath: enrollment.projectPath,
        storeSessionName: enrollment.sessionName,
        conversationId,
      };
      const delivery = request.queuedDelivery;
      /** The queue's side of this turn, once the input it delivers is known. */
      let accounting: QueuedDeliveryAccounting | null = null;
      let dispatched = false;
      const streamedErrors = new Set<string>();
      let turnWorktree: string | null = null;
      // Whatever ends the turn, from here on, the queue is told what became of its batch.
      let ran: TurnExecutionOutcome = { kind: "not_started", reason: "configuration", message: "The turn did not run" };
      try {
        const row = await deps.records.read(identity);
        if (row === null) {
          const failure = `Conversation ${conversationId} no longer exists`;
          ran = { kind: "not_started", reason: "configuration", message: failure };
          stream?.emit("error", { message: failure });
          return failedTurn(failure);
        }
        if (delivery === undefined && row.queueReviewRequired) {
          deps.log.warn("conversation_core.prompt_held_for_queue_review", { conversationId });
          stream?.emit("error", { message: QUEUE_REVIEW_REQUIRED_MESSAGE, code: "QUEUE_REVIEW_REQUIRED" });
          return failedTurn(QUEUE_REVIEW_REQUIRED_MESSAGE);
        }
        // In debug mode the session's phase decides the turn's context and the report it asks for.
        const debugMode = runtimeDebugMode(row.debugMode);
        const outputFormat = debugMode === null ? undefined : resolveDebugOutputFormat(debugMode.phase);
        const { outcome, uncollected, debug } = await runRecordedTurn(deps, identity, "user", () =>
          runMessage(row, debugMode, outputFormat),
        );
        ran = outcome;
        if (debug?.kind === "verify_cleanup" && turnWorktree !== null) {
          deps.startDebugVerification({
            identity,
            worktreePath: turnWorktree,
            structuredOutput: toPromptActorResult(outcome).structuredOutput,
            debugSessionId: debug.debugMode.debugSessionId,
            attempt: debug.debugMode.cleanupVerificationAttempt ?? 0,
            turnAttemptId: attemptId,
          });
        }
        reportEnding(stream, outcome, streamedErrors);
        return withCollection(turnResultOf(outcome, outputFormat, null), uncollected);
      } catch (error) {
        ran = { kind: "not_started", reason: "configuration", message: getErrorMessage(error) };
        throw error;
      } finally {
        await settleQueued(ran);
      }

      async function runMessage(
        row: ConversationRowRead,
        debugMode: RuntimeDebugModeState | null,
        outputFormat: ReturnType<typeof resolveDebugOutputFormat>,
      ): Promise<TurnExecutionOutcome> {
        const projectName = deps.getProjectDisplayName(enrollment.projectPath);
        const backend = request.backend ?? row.agentBackend;
        const persistedRef = row.backendRef !== null && row.backendRef.backend === backend ? row.backendRef : null;
        await settleRetained(conversationId);
        if (backend !== row.agentBackend) {
          // Decided here, inside the conversation's one running turn, so a
          // refused concurrent message can never change it.
          if (row.promptCount > 0 || row.backendRef !== null) {
            return {
              kind: "not_started",
              reason: "configuration",
              message: `Backend mismatch: conversation uses "${row.agentBackend}" but the message asked for "${backend}"`,
            };
          }
          await deps.records.adoptBackend(identity, backend);
        }
        if (row.promptCount === 0 && request.text.trim().length > 0) {
          deps.nameConversation({
            projectPath: enrollment.projectPath,
            projectName,
            sessionName: enrollment.sessionName,
            conversationId,
            content: request.text.slice(0, 4_000),
          });
        }
        let modelSelection: BackendModelSelection;
        try {
          modelSelection = await deps.resolveModelSelection({
            projectPath: enrollment.projectPath,
            backend,
            transcriptPath: row.transcriptPath,
            explicit: request.modelSelection ?? null,
          });
        } catch (error) {
          deps.log.warn("conversation_core.model_selection_refused", { conversationId, error: getErrorMessage(error) });
          return { kind: "not_started", reason: "configuration", message: getErrorMessage(error) };
        }
        let resumed: Awaited<ReturnType<InteractiveTurnDeps["continuation"]>>;
        try {
          resumed = await deps.continuation({ identity, row });
        } catch (error) {
          deps.log.error("conversation_core.continuation_unavailable", { conversationId, error: getErrorMessage(error) });
          return { kind: "not_started", reason: "configuration", message: getErrorMessage(error) };
        }
        const { seed } = resumed;
        // A checkpoint retired the provider continuation: its seed starts a fresh runtime that resumes nothing.
        const resumeRef = seed === null ? persistedRef : null;
        if (seed !== null && deps.host.isLive(conversationId)) {
          deps.log.warn("checkpoint.stale_runtime_closed", { conversationId, operationId: seed.operationId });
          await deps.host.release(conversationId);
        }
        // Settled once the turn is going to run: from here the profile is locked.
        const profile = await deps.records.admitProfile(identity);
        const input = await prepareInput(conversationId);
        const broadcast = { projectName, storeSessionName: enrollment.sessionName };
        const messageId =
          delivery === undefined
            ? undefined
            : (delivery.subscriptionBatchId ?? delivery.messageIds[0] ?? delivery.deliveryAttemptId);
        const userEntry: TranscriptEntry = {
          ...(messageId !== undefined ? { id: messageId } : {}),
          timestamp: new Date().toISOString(),
          type: "user",
          role: "user",
          content: input.transcriptBlocks,
          modelSelection,
          ...(delivery?.subscriptionBatchId !== undefined
            ? {
                origin: {
                  source: "subscription_update" as const,
                  subscriptionUpdate: { batchId: delivery.subscriptionBatchId },
                },
              }
            : {}),
        };
        if (delivery !== undefined && messageId !== undefined) {
          // The queue owns a delivered batch's content until the backend accepts it.
          accounting = deps.queuedDelivery({
            identity,
            delivery,
            appendUserEntry: () =>
              deps.transcript.appendTranscriptEntryOnce(conversationId, { ...userEntry, id: messageId }, broadcast),
          });
        }
        const owned = accounting;
        const target = targetFromStoreSessionName(projectName, enrollment.sessionName, conversationId);
        const worktreePath = await deps.worktreeOf(enrollment.projectPath, target);
        turnWorktree = worktreePath;
        const prepared = await deps.prepareContext({
          execution: {
            projectPath: enrollment.projectPath,
            target,
            worktreePath,
            role: null,
            persistence: "durable",
            executionAttemptId: attemptId,
            debugMode,
            turn: { inputOrigin: request.inputOrigin, promptText: request.text },
          },
          promptText: input.promptText,
          runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
            willCreateRuntime: !deps.host.isLive(conversationId),
            promptCount: row.promptCount,
            hasResumeHandle: resumeRef !== null,
            pendingCheckpoint: seed !== null,
          }),
          continuation: resumed.continuation,
          checkpoint: seed,
          archiveQueuedInput: () => owned?.appendAcceptedUserEntry() ?? Promise.resolve(),
          onQueueAccepted: () => owned?.handleInputAccepted() ?? Promise.resolve(),
        });
        const context = withSeedReceipt(prepared, seed);
        let currentRef: AgentSessionRef | null = resumeRef;
        let inputAccepted = false;
        try {
          // Durable before the provider is called: a crash from here leaves an attempt that may have
          // run, distinguishable from one that never did.
          await seed?.bind({
            attemptId,
            inputFingerprint: fingerprintAssembledInput({ promptText: context.promptText, images: input.imageRefs }),
            submittedInputFingerprint: fingerprintSubmittedInput({
              promptText: request.text,
              images: request.images ?? [],
              documentFeedback: request.documentFeedback,
              notepadFeedback: request.notepadFeedback,
            }),
            queuedAttemptId: delivery?.deliveryAttemptId ?? null,
            queuedMessageId: delivery?.messageIds[0] ?? null,
          });
          const turnOutcome = await deps.engine.runTurn({
            ...(outputFormat !== undefined ? { outputFormat } : {}),
            conversation: {
              conversationId,
              projectPath: enrollment.projectPath,
              projectName,
              target,
              worktreePath,
              backend,
              executionClass: "ordinary-conversation",
              persistedRef: resumeRef,
              // A project conversation has no session for its agent to act in as itself.
              ...(target.scope === "session" ? { callerIdentity: conversationId } : {}),
              profile,
            },
            requirements: { modelSelection, instructionSelection: { autonomous: false } },
            onUserQuestion: (questions, questionSignal) =>
              deps.requestUserQuestion(
                { projectPath: enrollment.projectPath, sessionName: enrollment.sessionName, conversationId },
                questions,
                questionSignal,
              ),
            broadcast,
            promptText: context.dispatchPromptText,
            userPromptText: context.userPromptText,
            ...(context.promptContext !== undefined ? { promptContext: context.promptContext } : {}),
            ...(input.imageRefs.length > 0 ? { imageRefs: input.imageRefs } : {}),
            observe: {
              sending: () => {
                dispatched = true;
                context.markDispatched();
                seed?.markDispatched();
              },
              failed: (error) => {
                context.markDispatchFailure(error);
                seed?.markDispatchFailure(error);
              },
            },
            userEntry: owned === null ? userEntry : null,
            writeCapability: "write_capable",
            autonomous: false,
            waitForBackgroundTasks: false,
            async onBackendInit(ref) {
              currentRef = ref;
              await deps.records.recordContinuity(identity, ref);
              // A delivered seed's acceptance that cannot be recorded now is retried by its receipt.
              await context.onBackendInit(ref).catch((error: unknown) =>
                deps.log.warn("conversation_core.input_receipts_failed", { conversationId, error: getErrorMessage(error) }),
              );
            },
            async onEvent(event) {
              switch (event.type) {
                case "content":
                  stream?.emit("content", event.block);
                  break;
                case "error":
                  streamedErrors.add(event.message);
                  stream?.emit("error", { message: event.message });
                  break;
                case "input_accepted":
                  // Accepted input was certainly sent, whatever the send observer saw.
                  dispatched = true;
                  inputAccepted = true;
                  // A receipt that cannot be recorded must not cost the turn the agent is already running.
                  await context.onInputAccepted(currentRef).catch((error: unknown) =>
                    deps.log.warn("conversation_core.input_receipts_failed", {
                      conversationId,
                      error: getErrorMessage(error),
                    }),
                  );
                  break;
                default:
                  break;
              }
            },
            signal,
          });
          if (debugMode !== null) await recordDebugReport(turnOutcome, debugMode, broadcast);
          return turnOutcome;
        } finally {
          if (!(await settleReceipts(context, conversationId, deps.log))) {
            unsettled.set(conversationId, [...(unsettled.get(conversationId) ?? []), context]);
          } else if (inputAccepted && owned !== null) {
            // A receipt that failed at acceptance held the queue release back; the agent has the
            // input, and a batch held for review would offer a retry that sends it twice.
            await owned.handleInputAccepted().catch((error: unknown) =>
              deps.log.warn("conversation_core.queue_release_failed", { conversationId, error: getErrorMessage(error) }),
            );
          }
        }
      }

      /** A debug turn's report joins the transcript with the phase it answered, for its card. */
      async function recordDebugReport(
        turnOutcome: TurnExecutionOutcome,
        debugMode: RuntimeDebugModeState,
        broadcast: { projectName: string; storeSessionName: string },
      ): Promise<void> {
        const presented = toPromptActorResult(turnOutcome);
        if (presented.structuredOutput === undefined || presented.error != null || turnOutcome.interruption !== undefined) return;
        await deps.transcript
          .appendTranscriptEntryOnce(
            conversationId,
            {
              id: `debug-structured:${attemptId}`,
              timestamp: new Date().toISOString(),
              type: "assistant",
              role: "assistant",
              content: [{ type: "debug_structured", phase: debugMode.phase, payload: presented.structuredOutput }],
            },
            broadcast,
          )
          .catch((error: unknown) =>
            deps.log.warn("conversation_core.debug_report_append_failed", { conversationId, error: getErrorMessage(error) }),
          );
      }

      async function prepareInput(conversationId: string): Promise<PreparedInput> {
        const { effectivePromptText, isDrainedFeedbackBatch } = resolveTurnPromptText({
          promptText: request.text,
          documentFeedback: request.documentFeedback,
          notepadFeedback: request.notepadFeedback,
          isQueuedDelivery: delivery !== undefined,
        });
        const persisted = await deps.persistImages({
          conversationId,
          promptText: effectivePromptText,
          images: request.images ?? [],
        });
        return {
          promptText: persisted.promptText,
          imageRefs: persisted.imageRefs,
          transcriptBlocks: composeUserTranscriptBlocks({
            promptText: request.text,
            effectivePromptText,
            rewrittenPromptText: persisted.promptText,
            isDrainedFeedbackBatch,
            documentFeedback: request.documentFeedback,
            notepadFeedback: request.notepadFeedback,
            imageRefs: persisted.imageRefs,
          }),
        };
      }

      /** What the queue is owed for this turn's batch: released, held for review, or failed unsent. */
      async function settleQueued(outcome: TurnExecutionOutcome): Promise<void> {
        if (delivery === undefined) return;
        const owned: QueuedDeliveryAccounting | null = accounting;
        try {
          if (dispatched && owned !== null) await owned.settleAfterTurn();
          else await deps.failQueued({ identity, delivery, error: outcomeMessage(outcome) });
        } catch (error) {
          deps.log.error("conversation_core.queued_delivery_settle_failed", {
            conversationId,
            deliveryAttemptId: delivery.deliveryAttemptId,
            error: getErrorMessage(error),
          });
        }
      }

    },
  };
}
