import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import {
  targetFromStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type {
  AskQuestionItem,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { InTurnQuestionReply } from "@/lib/conversations/in-turn-question-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type {
  TranscriptBroadcastMeta,
  TranscriptEntry,
} from "@/lib/prompt/transcript";
import type { QueuedDeliveryAccounting } from "@/lib/conversation-core/contributions/queued-delivery-accounting";
import {
  composeUserTranscriptBlocks,
  resolveTurnPromptText,
} from "@/lib/conversation-core/contributions/review-feedback";
import type { QueuedDeliveryMetadata } from "@/lib/conversation-core/turn/turn-spec";
import type { Logger } from "@/lib/logging";
import { isRuntimeCreatedWithoutResume } from "@/lib/memory/delivery-decision";
import { getErrorMessage } from "@/lib/shared/errors";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import {
  fingerprintAssembledInput,
  fingerprintSubmittedInput,
} from "@/lib/conversation-checkpoints/input-fingerprint";
import type { PreparedCheckpointSeed } from "@/lib/conversation-checkpoints/checkpoint-seed";
import type { ContinuationSeed } from "@/lib/conversation-checkpoints/continuation-seed";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  isInputDeliveryUncertain,
  markPromptNotDelivered,
} from "@/lib/agent-backends/errors";
import {
  classifyDelivery,
  type DeliveryClass,
  type InputDelivery,
  type PreparedTurnInput,
  type TurnInputRequest,
} from "./turn-input";
import {
  toPromptActorResult,
  type TurnExecutionOutcome,
  type TurnInterruption,
} from "@/lib/conversation-core/turn/turn-result";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import { resolveDebugOutputFormat } from "@/lib/workflows/debug/prompt-policy";
import {
  backendLocked,
  resumableRef,
  runtimeDebugMode,
  settlementOf,
  type ConversationIdentity,
  type ConversationRecordPort,
} from "./conversation-record";
import type { TurnStream, UserTurnPort } from "./executor";
import type { UserTurnRequest } from "./schemas";
import {
  failedTurn,
  runRecordedTurn,
  turnResultOf,
  recordedResult,
} from "./recorded-turn";
import type { RuntimeHost } from "./runtime-host";
import type { TurnEngine } from "./turn-engine";

/** The conversation row as an interactive turn reads it. */
type ConversationRowRead = NonNullable<
  Awaited<ReturnType<ConversationRecordPort["read"]>>
>;

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
  host: Pick<RuntimeHost, "release" | "isLive" | "runtime" | "alignment">;
  /** Where the conversation's agent works: its session's worktree, or the project root for a project conversation. */
  worktreeOf(projectPath: string, target: ConversationTarget): Promise<string>;
  /**
   * A checkpoint fork's first message: its backend fixed by this submission,
   * on the selection it was forked with unless the message names one; null
   * for any other conversation.
   */
  admitCheckpointFork(
    identity: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
    backend: AgentBackendId,
    explicit: BackendModelSelection | undefined,
    isCurrent: () => boolean,
  ): Promise<BackendModelSelection | null>;
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
    backend: AgentBackendId;
    row: ConversationRowRead;
  }): Promise<{
    continuation: ContinuationSeed;
    seed: PreparedCheckpointSeed | null;
  }>;
  /** The turn's input: the message and the contributions ahead of it, with what its acceptance owes. */
  prepareInput(request: TurnInputRequest): Promise<PreparedTurnInput>;
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
  failQueued(input: {
    identity: ConversationIdentity;
    delivery: QueuedDeliveryMetadata;
    error: string;
  }): Promise<void>;
  /** A batch that was never sent goes back to pending, to be delivered again. */
  returnQueued(input: {
    identity: ConversationIdentity;
    delivery: QueuedDeliveryMetadata;
    error: string;
  }): Promise<void>;
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
  return call?.kind === "failed"
    ? call.error.message
    : "The turn ended before its input was sent";
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
function reportEnding(
  stream: TurnStream | null,
  outcome: TurnExecutionOutcome,
  streamedErrors: Set<string>,
): void {
  if (stream === null) return;
  const error = (message: string) => {
    if (!streamedErrors.has(message)) stream.emit("error", { message });
  };
  if (outcome.kind === "not_started") {
    if (outcome.interruption !== undefined)
      stream.emit("aborted", { message: stoppedMessage(outcome.interruption) });
    else if (outcome.reason === "cancelled")
      stream.emit("aborted", { message: "Prompt execution was cancelled" });
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

/** The message as the transcript keeps it and the agent reads it: feedback as prose, images saved and numbered in. */
async function renderMessage(
  deps: Pick<InteractiveTurnDeps, "persistImages">,
  conversationId: string,
  request: UserTurnRequest,
): Promise<PreparedInput> {
  const { effectivePromptText, isDrainedFeedbackBatch } = resolveTurnPromptText(
    {
      promptText: request.text,
      documentFeedback: request.documentFeedback,
      notepadFeedback: request.notepadFeedback,
      isQueuedDelivery: request.queuedDelivery !== undefined,
    },
  );
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

/** A turn that is running now, as live input reaches it. */
interface RunningTurn {
  identity: ConversationIdentity;
  execution: TurnInputRequest["execution"];
  broadcast: TranscriptBroadcastMeta;
  /** Set once the turn ended: it takes no more live input. */
  settling: boolean;
  deliveries: Set<Promise<DeliveryClass>>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(getErrorMessage(error));
}

/** A person's messages to a conversation the core runs, and the receipts their turns still owe. */
/** A conversation's running turn: whether a person attends it, and the message it delivers. */
export interface RunningTurnDescription {
  autonomous: boolean;
  originMessageId: string | null;
}

export interface InteractiveTurns extends UserTurnPort {
  describeRunning(conversationId: string): RunningTurnDescription | null;
  /** Whether the conversation's running turn could take a queued message now. */
  acceptsLive(conversationId: string): Promise<boolean>;
  /**
   * Delivers a queued message the queue claimed into the running turn (design
   * §4.4 live input), through the same turn input and acceptance order as a
   * turn's own. The queue's rows are settled here: `not_sent` returns them for
   * the next turn; `uncertain`, and `accepted` input the queue could not
   * release, hold them for review.
   */
  deliverLive(
    identity: ConversationIdentity,
    request: UserTurnRequest,
  ): Promise<DeliveryClass>;
  /**
   * Settles receipts the conversation's earlier turns could not, such as a
   * checkpoint delivery's acceptance; one that still fails stays retained.
   */
  settleRetained(conversationId: string): Promise<void>;
}

/**
 * A person's messages to a conversation the core runs, on the same turn engine and
 * row bookkeeping as seat turns: the ordinary conversation's context, model
 * and continuity, streamed live to the request that sent it.
 */
export function createInteractiveTurns(
  deps: InteractiveTurnDeps,
): InteractiveTurns {
  /**
   * Receipts still unsettled when their turn ended keep an owner here and are
   * settled before the conversation's next turn prepares its own context.
   */
  const unsettled = new Map<string, PreparedTurnInput[]>();
  /** One settlement per conversation at a time: a turn waits for one a hold check started. */
  const settling = new Map<string, Promise<void>>();
  /** Each conversation's running turn, which live input joins. */
  const running = new Map<string, RunningTurn>();
  /** What each running turn is, from its start: whether a person attends it, and the delivery it came from. */
  const described = new Map<string, RunningTurnDescription>();

  function retain(conversationId: string, input: PreparedTurnInput): void {
    deps.log.error("conversation_core.input_receipts_unsettled", {
      conversationId,
    });
    unsettled.set(conversationId, [
      ...(unsettled.get(conversationId) ?? []),
      input,
    ]);
  }

  /** Why the running turn cannot take a queued message now; null when it can. */
  async function liveRefusal(conversationId: string): Promise<string | null> {
    const turn = running.get(conversationId);
    if (turn === undefined) return "no_running_turn";
    if (turn.settling) return "turn_settling";
    const runtime = deps.host.runtime(conversationId);
    // Only input that joins this turn, or is refused once it ends: the runtime closes with the turn.
    if (
      runtime?.queueUserInput === undefined ||
      runtime.liveInput !== "running_turn"
    )
      return "runtime_not_turn_bound";
    const row = await deps.records.read(turn.identity);
    if (row === null) return "no_conversation";
    // A question waits for its answer, debug mode takes no queued input, a collaboration holds the conversation.
    if (row.pendingQuestionId !== null) return "question_pending";
    if (runtimeDebugMode(row.debugMode) !== null) return "debug_mode";
    if (row.owner !== null) return "collaboration_owner";
    return null;
  }

  async function acceptsLive(conversationId: string): Promise<boolean> {
    const reason = await liveRefusal(conversationId);
    if (reason !== null)
      deps.log.info("conversation_core.live_input_declined", {
        conversationId,
        reason,
      });
    return reason === null;
  }

  async function deliverInto(
    turn: RunningTurn,
    request: UserTurnRequest,
    delivery: QueuedDeliveryMetadata,
  ): Promise<DeliveryClass> {
    const { identity } = turn;
    const conversationId = identity.conversationId;
    const runtime = deps.host.runtime(conversationId);
    if (runtime?.queueUserInput === undefined) {
      await deps.returnQueued({
        identity,
        delivery,
        error: "The running turn ended before it could take this message",
      });
      return "not_sent";
    }
    const message = await renderMessage(deps, conversationId, request);
    const messageId = delivery.messageIds[0] ?? delivery.deliveryAttemptId;
    const entry: TranscriptEntry & { id: string } = {
      id: messageId,
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: message.transcriptBlocks,
    };
    const accounting = deps.queuedDelivery({
      identity,
      delivery,
      appendUserEntry: () =>
        deps.transcript.appendTranscriptEntryOnce(
          conversationId,
          entry,
          turn.broadcast,
        ),
    });
    const prepared = await deps.prepareInput({
      mode: "live",
      execution: {
        ...turn.execution,
        turn: { inputOrigin: request.inputOrigin, promptText: request.text },
      },
      promptText: message.promptText,
      briefingAttemptId: delivery.deliveryAttemptId,
      archive: () => accounting.appendAcceptedUserEntry(),
      release: () => accounting.releaseAccepted(),
    });
    prepared.sending();
    try {
      await runtime.queueUserInput({
        content: [
          { type: "text", text: prepared.dispatchPromptText },
          ...(request.images ?? []).map((image) => ({
            type: "image" as const,
            mediaType: image.mediaType,
            base64Data: image.base64Data,
          })),
        ],
        userPromptText: request.text,
        ...(prepared.promptContext !== undefined
          ? { promptContext: prepared.promptContext }
          : {}),
        // A live delivery joins a turn that already reported its continuity.
        onAccepted: () => prepared.accepted(null),
      });
    } catch (error) {
      // The port rejects ambiguous delivery as uncertain; any other rejection is a refusal before sending.
      prepared.failed(
        isInputDeliveryUncertain(error)
          ? error
          : markPromptNotDelivered(asError(error)),
      );
      deps.log.warn("conversation_core.live_delivery_failed", {
        conversationId,
        deliveryAttemptId: delivery.deliveryAttemptId,
        error: getErrorMessage(error),
      });
    }
    // An adapter that resolved without reporting acceptance proves nothing either way: uncertain.
    const outcome = classifyDelivery(prepared.delivery);
    if (!(await prepared.settle())) retain(conversationId, prepared);
    // Sent rows the queue has not released are held for review, as a turn's are.
    if (outcome === "not_sent")
      await deps.returnQueued({
        identity,
        delivery,
        error: "Not sent into the running turn; it goes with the next turn",
      });
    else await accounting.settleAfterTurn();
    deps.log.info("conversation_core.live_delivery", {
      conversationId,
      deliveryAttemptId: delivery.deliveryAttemptId,
      outcome,
    });
    return outcome;
  }

  async function settleRetainedNow(conversationId: string): Promise<void> {
    const retained = unsettled.get(conversationId) ?? [];
    unsettled.delete(conversationId);
    const still: PreparedTurnInput[] = [];
    for (const input of retained) {
      if (!(await input.settle())) still.push(input);
    }
    if (still.length > 0)
      deps.log.error("conversation_core.input_receipts_unsettled", {
        conversationId,
        count: still.length,
      });
    if (still.length > 0)
      unsettled.set(conversationId, [
        ...still,
        ...(unsettled.get(conversationId) ?? []),
      ]);
  }

  function settleRetained(conversationId: string): Promise<void> {
    const next = (settling.get(conversationId) ?? Promise.resolve()).then(() =>
      settleRetainedNow(conversationId),
    );
    settling.set(conversationId, next);
    void next.finally(() => {
      if (settling.get(conversationId) === next)
        settling.delete(conversationId);
    });
    return next;
  }

  return {
    describeRunning(conversationId) {
      return described.get(conversationId) ?? null;
    },
    settleRetained,
    acceptsLive,
    async deliverLive(identity, request) {
      const delivery = request.queuedDelivery;
      if (delivery === undefined)
        throw new Error("Live input is a queued message the queue claimed");
      const turn = running.get(identity.conversationId);
      // Checked again after the row read: a turn that began settling meanwhile waits for no new delivery.
      if (
        turn === undefined ||
        !(await acceptsLive(identity.conversationId)) ||
        turn.settling
      ) {
        await deps.returnQueued({
          identity,
          delivery,
          error: "No running turn could take it; it goes with the next turn",
        });
        return "not_sent";
      }
      const work = deliverInto(turn, request, delivery);
      turn.deliveries.add(work);
      try {
        return await work;
      } finally {
        turn.deliveries.delete(work);
      }
    },
    async notStarted({ conversationId, place, request, reason, endedBy }) {
      const delivery = request.queuedDelivery;
      const identity = {
        projectPath: place.projectPath,
        storeSessionName: place.sessionName,
        conversationId,
      };
      if (delivery === undefined) {
        // A debug turn the person stopped before it started still failed its phase, and can be retried.
        if (endedBy !== "person") return;
        const row = await deps.records.read(identity);
        if (row === null || runtimeDebugMode(row.debugMode) === null) return;
        await deps.records.settleTurn(
          identity,
          settlementOf({
            kind: "not_started",
            reason: "cancelled",
            message: reason,
          }),
          "user",
        );
        return;
      }
      // Provably never sent: a batch the server stopped is delivered after the restart.
      if (endedBy === "server") {
        await deps.returnQueued({
          identity,
          delivery,
          error: "The server stopped before it was sent",
        });
        return;
      }
      await deps.failQueued({
        identity,
        delivery,
        error:
          endedBy === "person"
            ? "Stopped before it was sent"
            : `Not sent: ${reason}`,
      });
    },
    async run({ conversationId, place, request, attemptId, signal, stream }) {
      const identity = {
        projectPath: place.projectPath,
        storeSessionName: place.sessionName,
        conversationId,
      };
      const autonomous = request.autonomous === true;
      const delivery = request.queuedDelivery;
      /** The queue's side of this turn, once the input it delivers is known. */
      let accounting: QueuedDeliveryAccounting | null = null;
      /** What the send observed of this turn's input, once it is prepared. */
      let evidence: InputDelivery | null = null;
      const streamedErrors = new Set<string>();
      let turnWorktree: string | null = null;
      // Whatever ends the turn, from here on, the queue is told what became of its batch.
      let ran: TurnExecutionOutcome = {
        kind: "not_started",
        reason: "configuration",
        message: "The turn did not run",
      };
      try {
        // Inputs an earlier turn still owes settle first: what they record can decide this message's continuation.
        await settleRetained(conversationId);
        const row = await deps.records.read(identity);
        if (row === null) {
          const failure = `Conversation ${conversationId} no longer exists`;
          ran = {
            kind: "not_started",
            reason: "configuration",
            message: failure,
          };
          stream?.emit("error", { message: failure });
          return failedTurn(failure);
        }
        // In debug mode the session's phase decides the turn's context and the report it asks for.
        const debugMode = runtimeDebugMode(row.debugMode);
        const outputFormat =
          debugMode === null
            ? undefined
            : resolveDebugOutputFormat(debugMode.phase);
        // An unattended turn keeps out of the person's bookkeeping, and `cctl ask` refuses it, as on the actor.
        const recorded = await runRecordedTurn(
          deps,
          identity,
          autonomous ? "workflow" : "user",
          () => runMessage(row, debugMode, outputFormat),
        );
        const { outcome, debug } = recorded;
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
        return recordedResult(
          turnResultOf(outcome, outputFormat, null),
          recorded,
        );
      } catch (error) {
        ran = {
          kind: "not_started",
          reason: "configuration",
          message: getErrorMessage(error),
        };
        throw error;
      } finally {
        await settleQueued(ran);
      }

      async function runMessage(
        row: ConversationRowRead,
        debugMode: RuntimeDebugModeState | null,
        outputFormat: ReturnType<typeof resolveDebugOutputFormat>,
      ): Promise<TurnExecutionOutcome> {
        const projectName = deps.getProjectDisplayName(place.projectPath);
        const backend = request.backend ?? row.agentBackend;
        const persistedRef = resumableRef(row, backend);
        if (backend !== row.agentBackend) {
          // Decided here, inside the conversation's one running turn, so a
          // refused concurrent message can never change it.
          if (backendLocked(row)) {
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
            projectPath: place.projectPath,
            projectName,
            sessionName: place.sessionName,
            conversationId,
            content: request.text.slice(0, 4_000),
          });
        }
        let modelSelection: BackendModelSelection;
        try {
          // A checkpoint fork's first message is the fork's own; every later one is the conversation's.
          modelSelection =
            (row.checkpointFork !== undefined && row.promptCount === 0
              ? await deps.admitCheckpointFork(
                  {
                    projectPath: place.projectPath,
                    sessionName: place.sessionName,
                    conversationId,
                  },
                  backend,
                  request.modelSelection,
                  () => !signal.aborted,
                )
              : null) ??
            (await deps.resolveModelSelection({
              projectPath: place.projectPath,
              backend,
              transcriptPath: row.transcriptPath,
              explicit: request.modelSelection ?? null,
            }));
        } catch (error) {
          deps.log.warn("conversation_core.model_selection_refused", {
            conversationId,
            error: getErrorMessage(error),
          });
          return {
            kind: "not_started",
            reason: "configuration",
            message: getErrorMessage(error),
          };
        }
        let resumed: Awaited<ReturnType<InteractiveTurnDeps["continuation"]>>;
        try {
          resumed = await deps.continuation({ identity, backend, row });
        } catch (error) {
          deps.log.error("conversation_core.continuation_unavailable", {
            conversationId,
            error: getErrorMessage(error),
          });
          return {
            kind: "not_started",
            reason: "configuration",
            message: getErrorMessage(error),
          };
        }
        const { seed } = resumed;
        const forkSeed =
          resumed.continuation.kind === "fork"
            ? resumed.continuation.seed
            : null;
        // A checkpoint retired the provider continuation: its seed starts a fresh runtime that resumes nothing.
        const resumeRef = seed === null ? persistedRef : null;
        if (seed !== null && deps.host.isLive(conversationId)) {
          deps.log.warn("checkpoint.stale_runtime_closed", {
            conversationId,
            operationId: seed.operationId,
          });
          await deps.host.release(conversationId);
        }
        // Settled once the turn is going to run: from here the profile is locked.
        const profile = await deps.records.admitProfile(identity);
        const input = await renderMessage(deps, conversationId, request);
        const broadcast = {
          projectName,
          storeSessionName: place.sessionName,
        };
        // One id for the message: the transcript entry carries it, and the running turn reports it as its origin.
        const messageId =
          delivery === undefined
            ? attemptId
            : (delivery.subscriptionBatchId ??
              delivery.messageIds[0] ??
              delivery.deliveryAttemptId);
        const userEntry: TranscriptEntry = {
          id: messageId,
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
        if (delivery !== undefined) {
          // The queue owns a delivered batch's content until the backend accepts it.
          accounting = deps.queuedDelivery({
            identity,
            delivery,
            appendUserEntry: () =>
              deps.transcript.appendTranscriptEntryOnce(
                conversationId,
                { ...userEntry, id: messageId },
                broadcast,
              ),
          });
        }
        const owned = accounting;
        const target = targetFromStoreSessionName(
          projectName,
          place.sessionName,
          conversationId,
        );
        const worktreePath = await deps.worktreeOf(place.projectPath, target);
        turnWorktree = worktreePath;
        const execution: TurnInputRequest["execution"] = {
          projectPath: place.projectPath,
          target,
          worktreePath,
          role: null,
          persistence: "durable",
          executionAttemptId: attemptId,
          debugMode,
          turn: { inputOrigin: request.inputOrigin, promptText: request.text },
        };
        const prepared = await deps.prepareInput({
          mode: "turn",
          execution,
          promptText: input.promptText,
          briefingAttemptId: attemptId,
          runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
            willCreateRuntime: !deps.host.isLive(conversationId),
            promptCount: row.promptCount,
            hasResumeHandle: resumeRef !== null,
            pendingCheckpoint: seed !== null,
          }),
          checkpoint: seed,
          forkSeed,
          archive: () => owned?.appendAcceptedUserEntry() ?? Promise.resolve(),
          release: () => owned?.releaseAccepted() ?? Promise.resolve(),
        });
        evidence = prepared.delivery;
        let currentRef: AgentSessionRef | null = resumeRef;
        // Live input joins this turn once the turn's own input is accepted, until it settles.
        const turn: RunningTurn = {
          identity,
          execution,
          broadcast,
          settling: false,
          deliveries: new Set(),
        };
        described.set(conversationId, {
          autonomous,
          originMessageId: messageId,
        });
        /** The charter the agent received with this turn's input. */
        const received: {
          charter: ReturnType<InteractiveTurnDeps["host"]["alignment"]>;
        } = { charter: null };
        try {
          // Durable before the provider is called: a crash from here leaves an attempt that may have
          // run, distinguishable from one that never did.
          await seed?.bind({
            attemptId,
            inputFingerprint: fingerprintAssembledInput({
              promptText: prepared.promptText,
              images: input.imageRefs,
            }),
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
              projectPath: place.projectPath,
              projectName,
              target,
              worktreePath,
              backend,
              executionClass: "ordinary-conversation",
              persistedRef: resumeRef,
              // A project conversation has no session for its agent to act in as itself.
              ...(target.scope === "session"
                ? { callerIdentity: conversationId }
                : {}),
              profile,
            },
            requirements: {
              modelSelection,
              instructionSelection: { autonomous },
            },
            // An autonomous turn has no person to ask.
            ...(autonomous
              ? {}
              : {
                  onUserQuestion: (
                    questions: Parameters<
                      InteractiveTurnDeps["requestUserQuestion"]
                    >[1],
                    questionSignal: AbortSignal,
                  ) =>
                    deps.requestUserQuestion(
                      {
                        projectPath: place.projectPath,
                        sessionName: place.sessionName,
                        conversationId,
                      },
                      questions,
                      questionSignal,
                    ),
                }),
            broadcast,
            promptText: prepared.dispatchPromptText,
            userPromptText: prepared.userPromptText,
            ...(prepared.promptContext !== undefined
              ? { promptContext: prepared.promptContext }
              : {}),
            ...(forkSeed !== null ? { syntheticForkSeed: forkSeed } : {}),
            ...(input.imageRefs.length > 0
              ? { imageRefs: input.imageRefs }
              : {}),
            observe: {
              sending: () => prepared.sending(),
              failed: (error) => prepared.failed(error),
            },
            userEntry: owned === null ? userEntry : null,
            writeCapability: "write_capable",
            autonomous,
            waitForBackgroundTasks: false,
            async onBackendInit(ref) {
              currentRef = ref;
              try {
                await deps.records.recordContinuity(identity, ref);
              } finally {
                // The input learns its session whether or not the row could record it.
                // A delivered seed's acceptance that cannot be recorded now is retried by its receipt.
                await prepared.backendInit(ref).catch((error: unknown) =>
                  deps.log.warn("conversation_core.input_receipts_failed", {
                    conversationId,
                    error: getErrorMessage(error),
                  }),
                );
              }
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
                  // The charter the agent received: the runtime that took this input was created with it.
                  received.charter = deps.host.alignment(conversationId);
                  // Never throws: a receipt that cannot be written stays owned, and the turn goes on.
                  await prepared.accepted(currentRef);
                  if (!turn.settling) running.set(conversationId, turn);
                  break;
                default:
                  break;
              }
            },
            signal,
          });
          // A backend may name the session only in the turn's result (Claude, when a turn ends early).
          if (
            turnOutcome.kind === "call_result" &&
            turnOutcome.result.continuationDisposition !== "clear"
          )
            await prepared.ended(turnOutcome.result.backendRef);
          if (debugMode !== null)
            await recordDebugReport(turnOutcome, debugMode, broadcast);
          // Captured on acceptance: the agent received this charter, however the turn ended.
          if (received.charter?.eligible === true)
            await deps.records
              .recordSeenAlignment(identity, received.charter.version)
              .catch((error: unknown) =>
                deps.log.warn("conversation_core.seen_alignment_failed", {
                  conversationId,
                  error: getErrorMessage(error),
                }),
              );
          return turnOutcome;
        } finally {
          described.delete(conversationId);
          turn.settling = true;
          if (running.get(conversationId) === turn)
            running.delete(conversationId);
          await Promise.allSettled([...turn.deliveries]);
          if (!(await prepared.settle())) retain(conversationId, prepared);
        }
      }

      /** A debug turn's report joins the transcript with the phase it answered, for its card. */
      async function recordDebugReport(
        turnOutcome: TurnExecutionOutcome,
        debugMode: RuntimeDebugModeState,
        broadcast: { projectName: string; storeSessionName: string },
      ): Promise<void> {
        const presented = toPromptActorResult(turnOutcome);
        if (
          presented.structuredOutput === undefined ||
          presented.error != null ||
          turnOutcome.interruption !== undefined
        )
          return;
        await deps.transcript
          .appendTranscriptEntryOnce(
            conversationId,
            {
              id: `debug-structured:${attemptId}`,
              timestamp: new Date().toISOString(),
              type: "assistant",
              role: "assistant",
              content: [
                {
                  type: "debug_structured",
                  phase: debugMode.phase,
                  payload: presented.structuredOutput,
                },
              ],
            },
            broadcast,
          )
          .catch((error: unknown) =>
            deps.log.warn("conversation_core.debug_report_append_failed", {
              conversationId,
              error: getErrorMessage(error),
            }),
          );
      }

      /** What the queue is owed for this turn's batch: released, held for review, or failed unsent. */
      async function settleQueued(
        outcome: TurnExecutionOutcome,
      ): Promise<void> {
        if (delivery === undefined) return;
        const owned: QueuedDeliveryAccounting | null = accounting;
        try {
          // Input that may have reached the agent is held for review; input proven unsent is failed with its reason.
          if (
            evidence !== null &&
            classifyDelivery(evidence) !== "not_sent" &&
            owned !== null
          )
            await owned.settleAfterTurn();
          else
            await deps.failQueued({
              identity,
              delivery,
              error: outcomeMessage(outcome),
            });
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
