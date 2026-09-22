import { isDeepStrictEqual } from "node:util";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import {
  type CaptureHandoffResult,
  captureHandoffResultSchema,
} from "@/lib/agent-backends/schemas";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { CheckpointCaptureRuntimeInput } from "./actor-implementations";
import {
  omittedCaptureResult,
  pendingCheckpointCapture,
} from "./checkpoint-capture";
import type {
  BackendModelSelection,
  CaptureAvailability,
} from "@/lib/agent-backends/schemas";
import type { CheckpointHandoffRequest } from "@/lib/conversation-checkpoints/schemas";
import type { admitCheckpointForkSubmission } from "@/lib/conversation-checkpoints/fork-submission";
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
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";

import { type ConversationActorRef } from "./machine";
import type { ConversationEvent } from "./types";
import {
  conversationRuntimeKey,
  registerHostedCostSettlementApplier,
} from "./runtime-state";
import {
  type ConversationPersistenceAdapter,
  forgetConversationPersistence,
} from "./persistence-adapter";
import { createLogger } from "@/lib/logging";
import {
  ConversationBindingNotFoundError,
  checkpointScopeKeyForStoreIdentity,
  type EnsureActorInputData,
} from "./actor-input-loader";

import { admitConversationProfileForTurn } from "@/lib/conversations/profile-admission";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import { drainConversationQueue } from "@/lib/conversations/message-queue-drain";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  checkpointHoldsOrdinaryAdmission,
  evaluateCheckpointAdmission,
  evaluateCheckpointConversation,
  type CheckpointAdmissionObservation,
  type CheckpointConversationObservation,
  type CheckpointHostObservation,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
} from "@/lib/conversation-checkpoints/admission";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import {
  CHECKPOINT_CAPTURE_POLICY,
  type CheckpointReceipt,
  type CheckpointHandoffEligibility,
} from "@/lib/conversation-checkpoints/receipt";
import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import { isTerminalCheckpointPhase } from "@/lib/conversation-checkpoints/transitions";
import {
  checkpointActorProjection,
  type CheckpointActorProjection,
  type CheckpointOperation,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import type { CheckpointAdmissionState } from "@/lib/conversation-checkpoints/repo";
import type { CompactionConfig } from "@/lib/config/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import type {
  ConversationBackgroundActivity,
  ConversationState,
} from "@/lib/conversations/schemas";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  captureCheckpointSourceForHost,
  runCheckpointMaintenance,
  type CheckpointMaintenanceHost,
  restoredGateFor,
} from "./checkpoint-maintenance";
import {
  checkpointKeyLogFields,
  hydrateCheckpointAuthority,
  type CheckpointAuthorityHydration,
  readCheckpointAuthority,
} from "./checkpoint-restart";
import { repairQueuedAcceptanceFromCheckpoint } from "./checkpoint-queue-repair";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { ExecuteWorkflowTaskRunInput } from "./execute-workflow-task-run";
import type { TaskRunResult } from "./turn-result";
import type { ConversationCheckpointMaintenance } from "./runtime-state";

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

/**
 * Checkpoint maintenance owns this host: ordinary work waits for it, a rebind
 * is refused, and an eviction of a host still held after its work settled is
 * refused too, because eviction would close or abandon the runtime the
 * operation still accounts for.
 */
export class ConversationMaintenanceActiveError extends Error {}

/**
 * The checkpoint domain the manager composes: durable operations, the
 * captured archive, the compaction generator on a synthetic lane, and the
 * settled-state channels admission consults. Every method resolves lazily so
 * the manager's import graph stays as it was.
 */
export interface ConversationCheckpointDependencies {
  repo(): Promise<ConversationCheckpointsRepo>;
  readConversation(identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<ConversationState | null>;
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
  findArtifact(conversationId: string): Promise<ContextArtifactRow | null>;
  resolveConfig(projectPath: string): Promise<CompactionConfig>;
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  backendSupportsCheckpoint(backend: AgentBackendId): boolean;
  captureAvailability(backend: AgentBackendId): CaptureAvailability;
  acquireCaptureRuntime(
    input: CheckpointCaptureRuntimeInput,
    signal: AbortSignal,
  ): Promise<ConversationBackendRuntime | undefined>;
  appendCaptureEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  resolveCaptureModel(input: {
    agentBackend: AgentBackendId;
    transcriptPath: string | null;
    projectPath: string;
  }): Promise<BackendModelSelection>;
  /**
   * Append the user entry a crashed delivery turn owed the archive, at most
   * once per stable id; see `checkpoint-queue-repair`.
   */
  appendUserEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  /** Release queued rows on durable acceptance evidence; see `MessageQueueService.confirmDelivery`. */
  confirmQueuedDelivery(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<number>;
  getBackgroundActivity(
    conversationId: string,
  ): ConversationBackgroundActivity | null;
  /** The channel's change count; see `BackgroundActivityChannel.epoch`. */
  getBackgroundActivityEpoch(conversationId: string): number;
  generate: typeof generateCheckpoint;
  now(): string;
}

export interface ConversationCheckpointRequest {
  handoff?: CheckpointHandoffRequest;
  address: ConversationAddress;
  /** Caller-generated UUID: the operation id, and the reuse key on retransmit. */
  requestId: string;
  /**
   * Explicit recovery: the recovery-required operation this build supersedes.
   * Absent for an ordinary checkpoint, which cannot supersede anything.
   */
  recover?: string | null;
}

export type ConversationCheckpointReconcile =
  | { kind: "repaired"; operation: CheckpointOperation }
  | {
      kind: "blocked";
      operation: CheckpointOperation;
      refusal: CheckpointRefusal;
    }
  | { kind: "unchanged"; operation: CheckpointOperation }
  | { kind: "refused"; refusal: CheckpointRefusal };

export type ConversationCheckpointStart =
  | {
      kind: "admitted" | "reused";
      operation: CheckpointOperation;
      receipt: CheckpointReceipt;
      /** Settles with the operation's durable outcome; never rejects. */
      completion: Promise<CheckpointOperation>;
    }
  | { kind: "refused"; refusal: CheckpointRefusal };

export interface ConversationCheckpointCheck {
  handoff: CheckpointHandoffEligibility;
  eligible: boolean;
  /** Every failing predicate, primary first; empty when eligible. */
  refusals: CheckpointRefusal[];
  /** The operation holding the slot, when one does. */
  active: CheckpointReceipt | null;
  hosted: boolean;
}

export type ConversationCheckpointCancel =
  | { kind: "cancelled"; operation: CheckpointOperation }
  | { kind: "completed"; operation: CheckpointOperation }
  | { kind: "refused"; refusal: CheckpointRefusal };

/** The manager's owned reservation; `runtime.maintenance` aliases it once hosted. */
interface ManagedCheckpointMaintenance extends ConversationCheckpointMaintenance {
  /** Settles once the repository admitted the operation, or null when refused first. */
  readonly captureController: AbortController;
  captureMutation: Promise<unknown>;
  reconcileCapture?: () => Promise<boolean>;
  sealCapture?: () => void;
  readonly admitted: Promise<CheckpointOperation | null>;
  admit(operation: CheckpointOperation): void;
  settle(operation: CheckpointOperation | null): void;
  release(): void;
}

function checkpointRefusal(
  code: CheckpointRefusalCode,
  reason: string,
  operation: CheckpointOperation | null = null,
): CheckpointRefusal {
  return {
    code,
    reason,
    operationId: operation?.id ?? null,
    phase: operation?.phase ?? null,
  };
}

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
  admitCheckpointForkForTurn(
    identity: Parameters<typeof admitCheckpointForkSubmission>[1],
    backend: AgentBackendId,
    modelSelection:
      | import("@/lib/agent-backends/schemas").BackendModelSelection
      | null,
    isCurrent: () => boolean,
  ): Promise<
    import("@/lib/agent-backends/schemas").BackendModelSelection | null
  >;
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
  checkpoint: ConversationCheckpointDependencies;
}

/**
 * What `releaseIdleConversationRuntime` found: `released` closed the hosted
 * backend runtime, `not_hosted` had nothing to close, and `busy` means work was
 * in flight so nothing was touched.
 */
export type IdleRuntimeRelease = "released" | "not_hosted" | "busy";

export function createConversationManager(
  deps: ConversationManagerDependencies,
) {
  const host = deps.createHost({
    drainQueue: drainAfterTurn,
    executeDebugCommand: executeConversationCommand,
  });
  /**
   * Checkpoint reservations by runtime key. Set synchronously before a start
   * awaits anything, so a dormant host's startup drain and any concurrent
   * admission see the hold; kept for `needs_reconciliation` until an explicit
   * repair, and dropped with the host on disposal because the durable
   * operation re-establishes the hold through the actor input on restart.
   */
  const maintenances = new Map<string, ManagedCheckpointMaintenance>();

  function activeMaintenance(
    key: string,
  ): ManagedCheckpointMaintenance | undefined {
    return maintenances.get(key);
  }

  /** Whether ordinary work must wait: an in-process reservation or a loaded hold. */
  function maintenanceHolds(key: string): boolean {
    if (maintenances.has(key)) return true;
    const actor = host.get(key);
    const snapshot = actor ? readUsableSnapshot(actor) : null;
    return checkpointHoldsOrdinaryAdmission(snapshot?.context.checkpoint);
  }
  function restorePersistedConversations(): Promise<number> {
    return deps.rehydrate(host);
  }

  /**
   * Fold a late cost settlement into a HOSTED actor's totals. The actor's own
   * derived-field sync then writes the new total, so a direct row write could
   * not be overwritten by a stale in-memory figure. `applied: false` when no
   * usable actor is hosted for the key; the caller writes the row itself.
   */
  function applyCostSettlementToHostedActor(
    key: string,
    costUsdDelta: number,
  ): { applied: true; totalCostUsd: number | null } | { applied: false } {
    const actor = host.get(key);
    if (actor === undefined || readUsableSnapshot(actor) === null)
      return { applied: false };
    actor.send({ type: "COST_SETTLED", costUsdDelta });
    return {
      applied: true,
      totalCostUsd: actor.getSnapshot().context.totals.totalCostUsd,
    };
  }
  registerHostedCostSettlementApplier(applyCostSettlementToHostedActor);

  function checkpointAcceptsQueuedInput(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean {
    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversationId,
    );
    if (maintenanceHolds(key)) return true;
    const actor = host.get(key);
    const snapshot = actor ? readUsableSnapshot(actor) : null;
    // A composer may submit its queued input just as readiness releases the hold.
    return snapshot?.context.checkpoint?.phase === "ready";
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
        if (maintenanceHolds(key))
          return {
            kind: "refused",
            code: "busy",
            message: "Conversation checkpoint maintenance is in progress",
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
      runtime.durabilityFailure ||
      runtime.managed.cleanupFailure ||
      // A provider-initiated turn owns the host; its completion re-enters
      // idle, whose entry drains.
      runtime.managed.externalTurnActive
    )
      return;
    // Every drain path — idle entry, post-turn, explicit nudge — lands here,
    // and a checkpoint that owns the host keeps queued messages exactly where
    // they are until it reaches a safe outcome.
    if (maintenanceHolds(key)) {
      logger.info("queue.drain_held_checkpoint", {
        ...conversationTargetLogFields(context.target),
      });
      return;
    }
    const queueDeps = deps.queue;
    const drain = () => {
      if (
        runtime.stopping ||
        runtime.disposing ||
        runtime.durabilityFailure ||
        runtime.managed.cleanupFailure ||
        runtime.managed.externalTurnActive
      )
        return;
      if (deps.getRuntime(key) !== runtime) return;
      if (maintenanceHolds(key)) return;
      // Registered for its whole claim-and-dispatch lifetime, so a checkpoint
      // reservation taken while it is in flight yields to it instead of
      // bouncing the claimed batch or running its command under maintenance.
      const inflight = drainConversationQueue(context, queueDeps);
      runtime.queueDrains.add(inflight);
      void inflight
        .finally(() => {
          runtime.queueDrains.delete(inflight);
        })
        .catch(() => {});
      return inflight;
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
    // The host's per-conversation section: startup restore and the on-demand
    // restart rules take the same one, so none of them sees this
    // conversation between another's ownership check and its effect.
    return host.exclusive(key, () =>
      ensureConversationActorUnserialized(
        projectPath,
        sessionName,
        conversationId,
        options,
      ),
    );
  }

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
      if (
        maintenanceHolds(
          conversationRuntimeKey(projectPath, sessionName, conversationId),
        )
      )
        throw new ConversationMaintenanceActiveError(
          `Conversation actor ${conversationId} is under checkpoint maintenance; cannot rebind to executionTarget worktreePath=${requestedWorktreePath}`,
        );
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
      // A delivery the crash cut off between the checkpoint's acceptance and
      // the queue's is confirmed from that acceptance before anything drains.
      await repairQueuedAcceptance({
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
      checkpoint: data.checkpoint,
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
    if (runtime)
      await reconcileHostFailures(key, runtime, binding.address.target);
    await runtime?.stopping;
    await ensureBinding(conversationBindingSchema.parse(binding));
  }

  /**
   * Retry a host's recorded stop and durability failures — the owned close,
   * the attempt's receipts, the row and snapshot writes. One reconciliation
   * runs at a time per host; a second caller awaits the same one.
   */
  async function reconcileHostFailures(
    key: string,
    runtime: ConversationRuntimeState,
    target: ConversationTarget,
  ): Promise<void> {
    if (
      !(
        runtime.stopFailure ||
        runtime.durabilityFailure ||
        runtime.reconciliation
      )
    )
      return;
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
            ...conversationTargetLogFields(target),
          });
          // The failure held the queue at the settled host's idle entry;
          // that entry does not recur, so the repair restores the drain.
          const actor = host.get(key);
          const context = actor
            ? readUsableSnapshot(actor)?.context
            : undefined;
          if (actor && context && isActorSettled(actor))
            drainAfterTurn(context);
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
      if (
        maintenanceHolds(
          conversationRuntimeKey(
            identity.projectPath,
            identity.sessionName,
            identity.conversationId,
          ),
        )
      )
        throw new ConversationMaintenanceActiveError(
          "A conversation under checkpoint maintenance cannot be rebound",
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
      checkpoint: null,
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
      if (error instanceof ConversationMaintenanceActiveError)
        return { kind: "refused", code: "busy", message: error.message };
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
      if (runtime.managed.cleanupFailure)
        return {
          kind: "refused",
          code: "busy",
          message: runtime.managed.cleanupFailure.message,
        };
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
      const maintenance = activeMaintenance(key);
      // A queue drain that was already claiming when a checkpoint reserved
      // this host finishes first: its submission is admitted while the
      // reservation is still pre-admission, and the checkpoint then observes
      // the running turn and refuses itself.
      const drainPrecedesReservation =
        maintenance?.phase === "reserving" &&
        runtime.queueDrains.size > 0 &&
        turn.kind === "conversation_turn" &&
        turn.queuedDelivery !== undefined;
      const heldByMaintenance =
        maintenance !== undefined && !drainPrecedesReservation;
      if (
        runtime.stopping ||
        runtime.command ||
        runtime.admission ||
        runtime.attempt ||
        heldByMaintenance ||
        runtime.managed.externalTurnActive ||
        !actor.getSnapshot().can(makeEvent())
      ) {
        if (!input.waitUntilReady)
          return {
            kind: "refused",
            code: "busy",
            message: heldByMaintenance
              ? "Conversation checkpoint maintenance is in progress"
              : "Conversation is not ready to accept a turn",
          };
        try {
          if (runtime.stopping)
            await waitWithCancellation(runtime.stopping, input.signal);
          else if (heldByMaintenance && maintenance !== undefined)
            await waitWithCancellation(maintenance.released, input.signal);
          else if (runtime.command)
            await waitWithCancellation(runtime.command, input.signal);
          else if (runtime.admission)
            await waitWithCancellation(runtime.admission.settled, input.signal);
          else if (runtime.attempt)
            await waitWithCancellation(runtime.attempt.completed, input.signal);
          else if (runtime.managed.externalTurnActive)
            // Seen here before the start frame reaches the machine; the turn's
            // settlement, not the machine's state, is what ends the wait.
            await waitWithCancellation(
              runtime.managed.externalTurnSettled(),
              input.signal,
            );
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
          const state = await readAdmissionStateRepaired(identity);
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
        // Checkpoint continuity is the last admission predicate: a ready
        // seed is delivered only by an ordinary conversation turn, and an
        // applied continuation that has since been lost is gated for
        // recovery here rather than resumed as nothing.
        if (binding.kind === "durable") {
          const continuity = await admitCheckpointContinuity(
            checkpointKeyFor(binding.address),
            actor,
            turn.kind,
          );
          if (continuity !== null) return continuity;
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
        }
        const admissionIsCurrent = () =>
          !input.signal?.aborted &&
          !reservation.cancelled &&
          deps.getRuntime(key) === runtime &&
          runtime.admission === reservation &&
          actor.getSnapshot().can(makeEvent());
        if (
          binding.kind === "durable" &&
          turn.kind !== "task_run" &&
          admissionIsCurrent()
        ) {
          const forkSelection = await deps.admitCheckpointForkForTurn(
            identity,
            turn.backend,
            turn.modelSelection,
            admissionIsCurrent,
          );
          if (forkSelection) turn.modelSelection = forkSelection;
        }
        if (input.signal?.aborted || reservation.cancelled)
          return {
            kind: "refused",
            code: "cancelled",
            message: "Turn admission cancelled",
          };
        if (!admissionIsCurrent())
          return {
            kind: "refused",
            code: "binding_mismatch",
            message: "Conversation host changed during admission",
          };
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
        if (binding.kind === "durable") {
          const scopeKey = checkpointKeyFor(binding.address);
          attempt.ownFinalizer(() =>
            settleCheckpointAfterTurn(scopeKey, actor),
          );
        }
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
    // A checkpoint owns the host: there is no turn to stop, and closing the
    // runtime here would retire it before the payload is frozen — or, for an
    // operation held after a failed close or a failed outcome write, retire
    // it without the evidence that says it may be. The caller can wait for
    // the maintenance to settle; a held operation is released only by the
    // reconcile owner.
    const maintenance = activeMaintenance(key);
    if (maintenance)
      return {
        requested: false,
        settled: maintenance.work.then(() => undefined),
      };
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

  /**
   * Lets go of a settled conversation's hosted backend runtime while its actor
   * stays; the next turn opens a fresh runtime from the persisted ref, exactly
   * as after an idle worker expiry. This is how a conversation hands its
   * provider agent to another owner: a collaboration's Agent One lane resumes
   * that agent as a task, and a backend that binds an agent to one live worker
   * under one owner (Cursor) refuses the lane while this host still holds the
   * worker. `busy` means a turn, admission, stop or checkpoint is in flight
   * after all, so nothing was closed and the caller must not proceed.
   */
  async function releaseIdleConversationRuntime(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<IdleRuntimeRelease> {
    const key = conversationRuntimeKey(
      projectPath,
      sessionName,
      conversationId,
    );
    const actor = host.get(key);
    const runtime = deps.getRuntime(key);
    if (!actor || !runtime || runtime.managed.backend === undefined)
      return "not_hosted";
    if (
      !isActorSettled(actor) ||
      runtime.admission !== undefined ||
      runtime.attempt !== undefined ||
      runtime.stopping !== undefined ||
      runtime.disposing === true ||
      runtime.managed.externalTurnActive ||
      activeMaintenance(key) !== undefined
    ) {
      return "busy";
    }
    await runtime.command;
    await closeHostedRuntime(key);
    await flushRuntimeDurability(actor, runtime);
    logger.info("conversation-manager.idle_runtime_released", {
      conversationId,
      ...scopeRefFromStoreSessionName(sessionName),
    });
    return "released";
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
    // Disposal cannot cross maintenance: a build is cancelled through its own
    // signal and a retirement finishes forward, and the host is evicted only
    // once the operation reached a durable safe outcome. A hold that outlives
    // the work — a failed close, failed receipts, or an outcome the
    // repository never accepted — is not settled by eviction: the runtime it
    // still accounts for would be closed before its payload was frozen or
    // abandoned after a close it could not complete, and a reloaded
    // projection could never recover that handle. Only the reconcile owner
    // releases such a hold, so the eviction is refused and the host stays.
    const maintenance = activeMaintenance(key);
    if (maintenance) {
      maintenance.controller.abort(reason);
      await maintenance.work;
      if (maintenances.get(key) === maintenance) {
        if (ownedRuntime) ownedRuntime.disposing = undefined;
        logger.error("checkpoint.disposal_refused", {
          conversationId,
          ...scopeRefFromStoreSessionName(sessionName),
          operationId: maintenance.operationId,
          phase: maintenance.phase,
          outcome: maintenance.outcome,
          reason,
        });
        throw new ConversationMaintenanceActiveError(
          `Conversation ${conversationId} is held by checkpoint operation ${maintenance.operationId ?? "(unadmitted)"} (${maintenance.phase}); reconcile the checkpoint before disposing the host`,
        );
      }
    }
    const snapshot = readUsableSnapshot(actor);
    if (
      (reason === "server_shutdown" || reason === "workflow_turn_completed") &&
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
  // ==========================================================
  // Checkpoint maintenance
  //
  // The manager is a checkpoint's only lifecycle owner: nothing else sends
  // the actor's CHECKPOINT_PHASE projection, sets `runtime.maintenance` or
  // runs `checkpoint-maintenance` / `checkpoint-restart`
  // (boundaries.arch.test.ts refuses all of them elsewhere). The HTTP and CLI
  // surfaces compose the semantic methods below — check, start (ordinary or
  // explicit recovery), cancel, reconcile — and the repository's receipts,
  // never the actor or the runtime. Ownership here ends at a durable safe
  // outcome: carrying a `ready` seed into a fresh runtime (ready →
  // delivering → applied) is the next ordinary turn's admission. An
  // operation a restart interrupted is settled by the restart rules when its
  // authority is hydrated; one held as `needs_reconciliation` is repaired by
  // reconcile, or superseded by a recovery that names it, from its durable
  // phase — never from an in-process reservation.
  // ==========================================================

  function checkpointKeyFor(address: ConversationAddress): CheckpointScopeKey {
    return checkpointScopeKeyForStoreIdentity(
      conversationStoreIdentity(address),
    );
  }

  /**
   * Confirm queued rows a durable checkpoint acceptance proves delivered;
   * see `checkpoint-queue-repair`. Runs wherever the queue is read for
   * admission so a crash between the two receipts never strands a delivered
   * row in review — and never replays one.
   */
  async function repairQueuedAcceptance(identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<number> {
    return repairQueuedAcceptanceFromCheckpoint(identity, {
      repo: await deps.checkpoint.repo(),
      readQueue: async (target) =>
        (await deps.checkpoint.readConversation(target))?.pendingQueue ?? null,
      confirmDelivery: (input) => deps.checkpoint.confirmQueuedDelivery(input),
      appendUserEntryOnce: deps.checkpoint.appendUserEntryOnce,
      now: deps.checkpoint.now,
      log: logger,
    });
  }

  /** The admission-state read, after any queued receipt the checkpoint can repair. */
  async function readAdmissionStateRepaired(identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): ReturnType<ConversationManagerDependencies["readAdmissionState"]> {
    const state = await deps.readAdmissionState(identity);
    if (!state.found || !state.requiresQueueReview) return state;
    const released = await repairQueuedAcceptance(identity);
    return released > 0 ? deps.readAdmissionState(identity) : state;
  }

  function observeHostedConversation(
    key: string,
    actor: ConversationActorRef | undefined,
  ):
    | (CheckpointHostObservation & {
        debugActive: boolean;
        questionPending: boolean;
        transient: boolean;
        backendRef: string | null;
        activityEpoch: number;
      })
    | null {
    const runtime = deps.getRuntime(key);
    if (!actor || !runtime) return null;
    const snapshot = readUsableSnapshot(actor);
    if (!snapshot) {
      return {
        idle: false,
        turnActive: false,
        busy: true,
        trackedWork: false,
        debugActive: false,
        questionPending: false,
        transient: false,
        backendRef: null,
        activityEpoch: runtime.managed.activityEpoch,
      };
    }
    return {
      idle: snapshot.value === "idle",
      // A provider-initiated external turn counts even though the machine
      // refuses its start under a hold: the runtime is executing either way.
      turnActive:
        runtime.attempt !== undefined ||
        runtime.admission !== undefined ||
        runtime.managed.externalTurnActive,
      busy: Boolean(
        runtime.stopping ||
        runtime.disposing ||
        runtime.command ||
        runtime.reconciliation ||
        runtime.durabilityFailure ||
        runtime.managed.cleanupFailure ||
        runtime.stopFailure,
      ),
      trackedWork: runtime.managed.hasTrackedWork,
      debugActive: snapshot.context.debugMode?.active === true,
      questionPending: snapshot.context.pendingQuestion !== null,
      transient: snapshot.context.transient === true,
      backendRef: snapshot.context.backendRef?.ref ?? null,
      activityEpoch: runtime.managed.activityEpoch,
    };
  }

  function conversationObservationFromRow(
    row: ConversationState | null,
    hosted: ReturnType<typeof observeHostedConversation>,
  ): CheckpointConversationObservation | null {
    if (row === null) return null;
    return {
      archived: row.archived,
      role: row.role,
      owned: row.owner !== null,
      agentBackend: row.agentBackend,
      debugActive:
        row.debugMode?.active === true || hosted?.debugActive === true,
      questionPending:
        row.pendingQuestionId !== null || hosted?.questionPending === true,
      transient: hosted?.transient === true,
      promptCount: row.promptCount,
      transcriptPath: row.transcriptPath,
      running: row.status === "running",
    };
  }

  /**
   * The checkpoint repository's authority with the restart rules applied.
   * Only a conversation with no live host can hold an operation a crash
   * interrupted — a hosted one is owned by this process's maintenance or
   * was hydrated when its host was loaded — so this is where an ordinary
   * start, a cancel or a reconcile catches up with a restart that startup
   * rehydration has not reached yet. A read-only check never writes.
   */
  async function hydrateAuthorityForUnhosted(
    key: string,
    scopeKey: CheckpointScopeKey,
    identity: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
  ): Promise<CheckpointAuthorityHydration> {
    const repo = await deps.checkpoint.repo();
    return host.exclusive(key, async () => {
      // Ownership is re-read inside the section: a host that started while
      // this call waited applied the rules itself when it loaded, and its
      // live work must not be read as interrupted.
      if (host.get(key) !== undefined)
        return readCheckpointAuthority(scopeKey, repo);
      const hydration = await hydrateCheckpointAuthority(scopeKey, {
        repo,
        now: deps.checkpoint.now,
        log: logger,
      });
      if (
        hydration.outcome.kind !== "none" &&
        hydration.outcome.kind !== "held"
      )
        logger.info("checkpoint.restart.applied_on_demand", {
          ...checkpointKeyLogFields(scopeKey),
          outcome: hydration.outcome.kind,
        });
      await repairQueuedAcceptance(identity);
      return hydration;
    });
  }

  async function observeCheckpointAdmission(
    address: ConversationAddress,
    request: { requestId: string | null; recover: string | null },
    options: { self?: ManagedCheckpointMaintenance; hydrate?: boolean } = {},
  ): Promise<
    CheckpointAdmissionObservation & { hasCaptureContinuity: boolean }
  > {
    const identity = conversationStoreIdentity(address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const scopeKey = checkpointKeyFor(address);
    // Read before the first await: a reservation is what a start sets
    // synchronously, and a check must see it whether or not a host exists.
    const reservation = activeMaintenance(key);
    const [row, repo] = await Promise.all([
      deps.checkpoint.readConversation(identity),
      deps.checkpoint.repo(),
    ]);
    const hosted = observeHostedConversation(key, host.get(key));
    let checkpoints =
      options.hydrate === true && host.get(key) === undefined
        ? (await hydrateAuthorityForUnhosted(key, scopeKey, identity)).state
        : await repo.getStateForAdmission(scopeKey);
    // The live reference: the hosted actor's when there is one, else the row's.
    const liveRef = hosted ? hosted.backendRef : (row?.backendRef?.ref ?? null);
    if (options.hydrate === true) {
      const lost = await settleLostContinuation(
        scopeKey,
        host.get(key),
        checkpoints,
        liveRef !== null,
      );
      if (lost !== null)
        checkpoints = await repo.getStateForAdmission(scopeKey);
    }
    const continuationLost =
      checkpoints.active === null &&
      checkpoints.latestAccepted !== null &&
      liveRef === null
        ? {
            operationId: checkpoints.latestAccepted.operationId,
            phase: checkpoints.latestAccepted.currentPhase,
          }
        : null;
    return {
      hasCaptureContinuity: liveRef !== null,
      continuationLost,
      requestId: request.requestId,
      recover: request.recover,
      conversation: conversationObservationFromRow(row, hosted),
      backendSupportsCheckpoint:
        row !== null &&
        deps.checkpoint.backendSupportsCheckpoint(row.agentBackend),
      host: hosted,
      reservation:
        reservation !== undefined && reservation !== options.self
          ? { operationId: reservation.operationId }
          : null,
      backgroundActivity:
        deps.checkpoint.getBackgroundActivity(identity.conversationId) !== null,
      queueReviewRequired: (await deps.readAdmissionState(identity))
        .requiresQueueReview,
      checkpoints,
    };
  }

  /**
   * An applied checkpoint whose accepted continuation is gone: the
   * conversation holds no live reference, no operation is active, and the
   * latest acceptance still stands. The accepted operation is moved to
   * `needs_reconciliation` with its acceptance evidence retained — the repo
   * refuses to hand that seed back — and a hosted actor takes the hold, so
   * ordinary admission and queue drain wait for an explicit recovery built
   * from the recorded history since. Returns the held operation, or null
   * when nothing was lost.
   */
  async function settleLostContinuation(
    scopeKey: CheckpointScopeKey,
    actor: ConversationActorRef | undefined,
    state: CheckpointAdmissionState,
    hasContinuation: boolean,
  ): Promise<CheckpointOperation | null> {
    if (state.active !== null || state.latestAccepted === null) return null;
    if (hasContinuation) return null;
    const accepted = state.latestAccepted;
    const repo = await deps.checkpoint.repo();
    const held = await repo.recordOutcome({
      key: scopeKey,
      operationId: accepted.operationId,
      expectedPhase: "applied",
      phase: "needs_reconciliation",
      failure: {
        code: "continuation_lost",
        message:
          "the accepted provider continuation is no longer usable; run compact-context --recover with this operation id to build a fresh checkpoint from the recorded history",
      },
      at: deps.checkpoint.now(),
    });
    const operation = held.ok
      ? held.value
      : await repo.getOperation(scopeKey, accepted.operationId);
    if (operation === null || operation.phase !== "needs_reconciliation") {
      logger.warn("checkpoint.continuation_loss_unrecorded", {
        ...checkpointKeyLogFields(scopeKey),
        operationId: accepted.operationId,
        refusal: held.ok ? null : held.refusal.code,
        phase: operation?.phase ?? null,
      });
      return null;
    }
    logger.error("checkpoint.continuation_lost", {
      ...checkpointKeyLogFields(scopeKey),
      operationId: operation.id,
      ordinal: operation.ordinal,
      acceptedAttemptId: accepted.acceptance.attemptId,
      acceptedAt: accepted.acceptance.acceptedAt,
    });
    actor?.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: operation.id, phase: "needs_reconciliation" },
    });
    return operation;
  }

  /**
   * The turn-admission half of checkpoint continuity, after the queue and
   * profile predicates: a lost continuation is gated for recovery, a ready
   * seed admits only an ordinary conversation turn, and any other active
   * phase is the hold the projection already carries.
   */
  async function admitCheckpointContinuity(
    scopeKey: CheckpointScopeKey,
    actor: ConversationActorRef,
    turnKind: "conversation_turn" | "task_run",
  ): Promise<TurnAdmissionRefusal | null> {
    const context = readUsableSnapshot(actor)?.context;
    if (!context || context.transient) return null;
    const repo = await deps.checkpoint.repo();
    const state = await repo.getStateForAdmission(scopeKey);
    const lost = await settleLostContinuation(
      scopeKey,
      actor,
      state,
      context.backendRef !== null,
    );
    if (lost !== null)
      return {
        kind: "refused",
        code: "busy",
        message: `The applied checkpoint continuation was lost; run compact-context --recover ${lost.id}`,
      };
    const active = state.active;
    if (active === null) return null;
    if (active.phase === "ready") {
      if (turnKind === "task_run")
        return {
          kind: "refused",
          code: "busy",
          message:
            "A ready checkpoint is delivered by the next ordinary conversation turn",
        };
      if (context.checkpoint?.operationId !== active.id)
        actor.send({
          type: "CHECKPOINT_PHASE",
          checkpoint: { operationId: active.id, phase: "ready" },
        });
      return null;
    }
    // Held. The projection normally says so already; a durable hold the
    // actor does not yet carry is projected before the refusal so the drain
    // and every later admission see it.
    if (!checkpointHoldsOrdinaryAdmission(context.checkpoint))
      actor.send({
        type: "CHECKPOINT_PHASE",
        checkpoint: checkpointActorProjection(active),
      });
    logger.info("checkpoint.admission_held", {
      ...checkpointKeyLogFields(scopeKey),
      operationId: active.id,
      phase: active.phase,
    });
    return {
      kind: "refused",
      code: "busy",
      message: "Conversation checkpoint maintenance is in progress",
    };
  }

  /**
   * The settlement half, run as the attempt's finalizer once its receipts —
   * including a checkpoint delivery's acceptance — have settled: project the
   * durable phase (an applied seed leaves no projection, an unsent one
   * returns to ready, an unresolved one holds), and gate a continuation the
   * turn just lost. A delivery whose receipt is still unsettled fails here,
   * and the failure is retained and re-run after the receipt is repaired.
   */
  async function settleCheckpointAfterTurn(
    scopeKey: CheckpointScopeKey,
    actor: ConversationActorRef,
  ): Promise<void> {
    const context = readUsableSnapshot(actor)?.context;
    if (!context || context.transient) return;
    const repo = await deps.checkpoint.repo();
    const state = await repo.getStateForAdmission(scopeKey);
    if (state.active?.phase === "delivering")
      throw new Error(
        `checkpoint operation ${state.active.id} is still delivering after the turn settled; its acceptance receipt has not landed`,
      );
    const lost = await settleLostContinuation(
      scopeKey,
      actor,
      state,
      context.backendRef !== null,
    );
    if (lost !== null) return;
    const projection = checkpointActorProjection(state.active);
    const current = context.checkpoint ?? null;
    if (
      projection?.operationId === current?.operationId &&
      projection?.phase === current?.phase
    )
      return;
    actor.send({ type: "CHECKPOINT_PHASE", checkpoint: projection });
    logger.info("checkpoint.projection_settled", {
      ...checkpointKeyLogFields(scopeKey),
      operationId: projection?.operationId ?? null,
      phase: projection?.phase ?? null,
    });
  }

  /**
   * Read-only eligibility: the same predicates a start enforces, over durable
   * and hosted state only. Starts no actor, drains nothing, reserves nothing.
   */
  async function checkConversationCheckpoint(
    address: ConversationAddress,
    options: { recover?: string | null } = {},
  ): Promise<ConversationCheckpointCheck> {
    const observation = await observeCheckpointAdmission(address, {
      requestId: null,
      recover: options.recover ?? null,
    });
    const verdict = evaluateCheckpointAdmission(observation);
    const active = observation.checkpoints.active;
    const repo = await deps.checkpoint.repo();
    const availability =
      observation.conversation === null
        ? {
            available: false as const,
            mode: null,
            reason: "conversation_not_found",
          }
        : deps.checkpoint.captureAvailability(
            observation.conversation.agentBackend,
          );
    const handoff: CheckpointHandoffEligibility = {
      available: availability.available && observation.hasCaptureContinuity,
      mode: availability.mode,
      reason: !availability.available
        ? availability.reason
        : observation.hasCaptureContinuity
          ? null
          : "continuity_unavailable",
      policy: CHECKPOINT_CAPTURE_POLICY,
    };
    return {
      handoff,
      eligible: verdict.eligible,
      refusals: verdict.eligible ? [] : verdict.refusals,
      active: active
        ? await repo.getReceipt(checkpointKeyFor(address), active.id)
        : null,
      hosted: observation.host !== null,
    };
  }

  function createMaintenance(
    requestId: string,
    options: { recovers: string | null; retryClose: boolean } = {
      recovers: null,
      retryClose: false,
    },
  ): ManagedCheckpointMaintenance {
    let settleWork!: (operation: CheckpointOperation | null) => void;
    let settleAdmitted!: (operation: CheckpointOperation | null) => void;
    let release!: () => void;
    const work = new Promise<CheckpointOperation | null>((resolve) => {
      settleWork = resolve;
    });
    const admitted = new Promise<CheckpointOperation | null>((resolve) => {
      settleAdmitted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      requestId,
      operationId: null,
      recovers: options.recovers,
      retryClose: options.retryClose,
      phase: "reserving",
      outcome: "pending",
      controller: new AbortController(),
      captureController: new AbortController(),
      captureMutation: Promise.resolve(),
      work,
      admitted,
      released,
      admit: settleAdmitted,
      settle(operation) {
        settleAdmitted(operation);
        settleWork(operation);
      },
      release,
    };
  }

  /**
   * Admit and start a checkpoint. Returns after the operation is durable;
   * generation and retirement continue as owned maintenance and settle
   * through `completion`. Nothing about the conversation changes before the
   * durable admission: a refusal allocates no provider session, drains no
   * queue and leaves the continuation as it was.
   *
   * With `recover`, the build is an explicit recovery: it supersedes exactly
   * the named recovery-required operation by compare-and-swap on its id and
   * phase, builds from the complete recorded archive, closes the suspect
   * runtime before readiness, and — should it fail or be cancelled — hands
   * the host back to that operation's hold rather than releasing the queue.
   */
  async function startConversationCheckpoint(
    input: ConversationCheckpointRequest,
  ): Promise<ConversationCheckpointStart> {
    const identity = conversationStoreIdentity(input.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const scopeKey = checkpointKeyFor(input.address);
    const logFields = {
      ...conversationTargetLogFields(input.address.target),
      requestId: input.requestId,
    };
    const recover = input.recover ?? null;
    const existing = activeMaintenance(key);
    /** The settled hold an explicit recovery takes over; restored if admission fails. */
    let superseded: ManagedCheckpointMaintenance | undefined;
    if (existing) {
      if (existing.requestId === input.requestId) {
        const operation = await existing.admitted;
        if (operation) {
          return reusedStart(scopeKey, operation, existing.work);
        }
      }
      // An explicit recovery may take over the hold of exactly the operation
      // it names, once that hold has settled into needs_reconciliation with
      // a durable outcome; anything else is a competing checkpoint.
      const recoverable =
        recover !== null &&
        existing.operationId === recover &&
        existing.phase === "needs_reconciliation" &&
        existing.outcome === "durable";
      if (!recoverable) {
        const refusal = checkpointRefusal(
          "checkpoint_pending",
          "a checkpoint already owns this conversation",
          existing.operationId
            ? await (
                await deps.checkpoint.repo()
              ).getOperation(scopeKey, existing.operationId)
            : null,
        );
        logger.info("checkpoint.admission_refused", {
          ...logFields,
          code: refusal.code,
        });
        return { kind: "refused", refusal };
      }
      superseded = existing;
    }

    // Reserve before the first await: from here every competing admission,
    // drain, rebind and stop sees the hold, including the idle-entry drain
    // of a host this start is about to wake. A recovery's owned close may
    // retry the recorded close failure of the runtime it supersedes.
    const maintenance = createMaintenance(input.requestId, {
      recovers: recover,
      retryClose: recover !== null,
    });
    maintenances.set(key, maintenance);
    if (superseded) {
      const runtime = deps.getRuntime(key);
      if (runtime?.maintenance === superseded)
        runtime.maintenance = maintenance;
    }
    let admitted = false;
    try {
      const observation = await observeCheckpointAdmission(
        input.address,
        { requestId: input.requestId, recover },
        { self: maintenance, hydrate: true },
      );
      const verdict = evaluateCheckpointAdmission(observation);
      if (!verdict.eligible) {
        logger.info("checkpoint.admission_refused", {
          ...logFields,
          code: verdict.refusals[0].code,
          codes: verdict.refusals.map((entry) => entry.code),
        });
        return { kind: "refused", refusal: verdict.refusals[0] };
      }
      if (verdict.reuse) {
        return reusedStart(
          scopeKey,
          verdict.reuse,
          Promise.resolve(verdict.reuse),
        );
      }

      let actor: ConversationActorRef;
      try {
        actor = await ensureConversationActor(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
        );
      } catch (error) {
        if (error instanceof ConversationBindingNotFoundError)
          return {
            kind: "refused",
            refusal: checkpointRefusal("conversation_not_found", error.message),
          };
        throw error;
      }
      const runtime = deps.getRuntime(key);
      if (!runtime)
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "conversation_busy",
            "the conversation host is not registered",
          ),
        };
      runtime.maintenance = maintenance;
      const maintenanceHost = createMaintenanceHost(
        scopeKey,
        key,
        actor,
        runtime,
        maintenance,
      );

      // Settled hosted state, then the receipts every transcript and turn
      // effect owes, then the capture. The hosted recheck runs after the
      // receipts settle because settling them is what an in-flight external
      // frame needed to become visible.
      const hostedRefusal = refuseUnsettledHost(maintenanceHost.observe());
      if (hostedRefusal) {
        logger.info("checkpoint.admission_refused", {
          ...logFields,
          code: hostedRefusal.code,
        });
        return { kind: "refused", refusal: hostedRefusal };
      }
      let source;
      try {
        source = await captureCheckpointSourceForHost(maintenanceHost, {
          readEntries: deps.checkpoint.readEntries,
        });
      } catch (error) {
        runtime.durabilityFailure ??= {
          context: actor.getSnapshot().context,
          error,
        };
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "conversation_busy",
            `the conversation's receipts did not settle: ${getErrorMessage(error)}`,
          ),
        };
      }
      const settled = maintenanceHost.observe();
      const lateRefusal = refuseUnsettledHost(settled);
      if (lateRefusal) {
        logger.info("checkpoint.admission_refused", {
          ...logFields,
          code: lateRefusal.code,
        });
        return { kind: "refused", refusal: lateRefusal };
      }

      const repo = await deps.checkpoint.repo();
      const captureContext = actor.getSnapshot().context;
      const captureModel =
        input.handoff === undefined
          ? null
          : (runtime.managed.backend?.modelSelection ??
            (await deps.checkpoint.resolveCaptureModel({
              agentBackend: captureContext.agentBackend,
              transcriptPath: captureContext.transcriptPath,
              projectPath: captureContext.projectPath,
            })));
      const beforeAdmission = maintenanceHost.observe();
      if (
        !beforeAdmission.settled ||
        beforeAdmission.backendRef !== settled.backendRef ||
        beforeAdmission.activityEpoch !== settled.activityEpoch ||
        beforeAdmission.backgroundEpoch !== settled.backgroundEpoch ||
        actor.getSnapshot().context.agentBackend !== captureContext.agentBackend
      ) {
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "conversation_busy",
            "the source changed while binding checkpoint admission",
          ),
        };
      }
      const requestedAt = deps.checkpoint.now();
      const admissionInput = {
        ...(input.handoff === undefined || captureModel === null
          ? {}
          : {
              handoff: pendingCheckpointCapture({
                requestId: input.requestId,
                request: input.handoff,
                backend: captureContext.agentBackend,
                modelSelection: captureModel,
                sourceBasis: source.basis,
                at: requestedAt,
              }),
            }),
        key: scopeKey,
        requestId: input.requestId,
        sourceBasis: source.basis,
        priorBackendRef: settled.backendRef,
        requestedAt,
      };
      const admission =
        recover === null
          ? await repo.admitOperation(admissionInput)
          : await repo.admitRecovery({
              ...admissionInput,
              recoversOperationId: recover,
            });
      if (!admission.ok) {
        logger.info("checkpoint.admission_refused", {
          ...logFields,
          code: admission.refusal.code,
        });
        return { kind: "refused", refusal: admission.refusal };
      }
      const { operation } = admission.value;
      if (admission.value.outcome === "reused") {
        return reusedStart(scopeKey, operation, Promise.resolve(operation));
      }
      admitted = true;
      maintenance.operationId = operation.id;
      maintenance.phase = "building";
      maintenance.admit(operation);
      maintenanceHost.project({ operationId: operation.id, phase: "building" });
      logger.info(
        recover === null
          ? "checkpoint.admitted"
          : "checkpoint.recovery_admitted",
        {
          ...logFields,
          operationId: operation.id,
          ordinal: operation.ordinal,
          capturedThroughSeq: operation.sourceBasis.capturedThroughSeq,
          ...(recover === null ? {} : { recoversOperationId: recover }),
        },
      );

      const completion = runOwnedMaintenance(
        key,
        actor,
        maintenance,
        maintenanceHost,
        operation,
        source,
        settled,
      );
      const receipt = await repo.getReceipt(scopeKey, operation.id);
      if (!receipt) throw new Error("Admitted checkpoint has no receipt");
      return { kind: "admitted", operation, receipt, completion };
    } finally {
      if (!admitted) {
        if (superseded) restoreMaintenance(key, maintenance, superseded);
        else releaseMaintenance(key, maintenance, null);
      }
    }
  }

  /**
   * Put a settled hold back after a recovery that never admitted: the
   * replaced reservation settles for anyone waiting on it, and nothing
   * drains, because the prior operation still owns the host.
   */
  function restoreMaintenance(
    key: string,
    replaced: ManagedCheckpointMaintenance,
    prior: ManagedCheckpointMaintenance,
  ): void {
    if (maintenances.get(key) === replaced) maintenances.set(key, prior);
    const runtime = deps.getRuntime(key);
    if (runtime?.maintenance === replaced) runtime.maintenance = prior;
    replaced.settle(null);
    replaced.release();
  }

  /**
   * Drop a transient reservation without draining: the durable hold — the
   * actor's projection — stays exactly as it was, and waiters settle.
   */
  function dropReservation(
    key: string,
    reservation: ManagedCheckpointMaintenance,
    operation: CheckpointOperation | null,
  ): void {
    if (maintenances.get(key) === reservation) maintenances.delete(key);
    const runtime = deps.getRuntime(key);
    if (runtime?.maintenance === reservation) runtime.maintenance = undefined;
    reservation.settle(operation);
    reservation.release();
  }

  async function reusedStart(
    scopeKey: CheckpointScopeKey,
    operation: CheckpointOperation,
    completion: Promise<CheckpointOperation | null>,
  ): Promise<ConversationCheckpointStart> {
    const receipt = await (
      await deps.checkpoint.repo()
    ).getReceipt(scopeKey, operation.id);
    if (!receipt) throw new Error("Reused checkpoint has no receipt");
    return {
      kind: "reused",
      operation,
      receipt,
      completion: completion.then((settled) => settled ?? operation),
    };
  }

  function refuseUnsettledHost(
    observed: ReturnType<CheckpointMaintenanceHost["observe"]>,
  ): CheckpointRefusal | null {
    if (observed.settled) return null;
    const code = observed.reason ?? "conversation_busy";
    return checkpointRefusal(code, `the conversation is not settled: ${code}`);
  }

  function createMaintenanceHost(
    scopeKey: CheckpointScopeKey,
    key: string,
    actor: ConversationActorRef,
    runtime: ConversationRuntimeState,
    maintenance: ManagedCheckpointMaintenance,
  ): CheckpointMaintenanceHost {
    const context = () => actor.getSnapshot().context;
    const persistence = () =>
      deps.persistence(context().transient ? "ephemeral" : "durable");
    return {
      key: scopeKey,
      target: context().target,
      projectPath: context().projectPath,
      worktreePath: context().worktreePath,
      transcriptPath: context().transcriptPath,
      signal: maintenance.controller.signal,
      captureSignal: maintenance.captureController.signal,
      mutateCapture: (work) => mutateCapture(maintenance, work),
      async captureHandoff(operation, captureInput, expected) {
        const handoff = operation.handoff;
        if (!handoff) throw new Error("Capture has no admitted intent");
        const ref = context().backendRef;
        const initiallyHosted = runtime.managed.backend;
        let sourceChanged = false;
        const auditEntryIds: string[] = [];
        const startActivity = runtime.managed.activityEpoch;
        const startBackground = deps.checkpoint.getBackgroundActivityEpoch(
          context().target.conversationId,
        );
        const sourceIsCurrent = () =>
          context().agentBackend === handoff.backend &&
          (context().backendRef?.ref ?? null) ===
            operation.protectedReferences.priorBackendRef &&
          runtime.managed.activityEpoch === expected.activityEpoch &&
          deps.checkpoint.getBackgroundActivityEpoch(
            context().target.conversationId,
          ) === expected.backgroundEpoch;
        const availability = deps.checkpoint.captureAvailability(
          handoff.backend,
        );
        let ordinal = 0;
        let sinkSettled = false;
        let writes = Promise.resolve();
        let writeFailure: unknown;
        let captureResult: CaptureHandoffResult | null = null;
        let invoked = false;
        let outputAdded = false;
        let settlementAdded = false;
        const pendingWrites = new Map<string, () => Promise<void>>();
        maintenance.sealCapture = () => {
          sinkSettled = true;
        };
        const append = (
          entry: TranscriptEntry,
          part: "control" | "output" | "activity" | "settlement",
        ) => {
          const id = `${handoff.captureId}:${ordinal++}`;
          auditEntryIds.push(id);
          const persist = () =>
            deps.checkpoint
              .appendCaptureEntryOnce(context().target.conversationId, {
                ...entry,
                id,
                role: entry.role ?? "notice",
                content: entry.content?.length
                  ? entry.content
                  : [{ type: "text", text: `Checkpoint capture ${part}` }],
                origin: {
                  source: "checkpoint_capture",
                  checkpointCapture: {
                    operationId: operation.id,
                    captureId: handoff.captureId,
                    part,
                  },
                },
              })
              .then(() => {
                pendingWrites.delete(id);
              });
          pendingWrites.set(id, persist);
          const receipt = writes.then(persist);
          runtime.managed.trackCaptureReceipt(handoff.captureId, id, receipt);
          writes = receipt.catch((error: unknown) => {
            writeFailure ??= error;
            runtime.durabilityFailure ??= { context: context(), error };
          });
          return receipt;
        };
        const sourceRefusal = () => {
          sourceChanged = true;
          return omittedCaptureResult("checkpoint_failed", ref);
        };
        const dispatch = async () => {
          if (captureInput.signal.aborted)
            return omittedCaptureResult("skipped", ref);
          if (!sourceIsCurrent()) return sourceRefusal();
          if (handoff.requestedMode === null || !availability.available)
            return omittedCaptureResult("unavailable", ref);
          if (availability.mode !== handoff.requestedMode)
            return omittedCaptureResult("mode_changed", ref);
          if (ref === null || ref.backend !== handoff.backend)
            return omittedCaptureResult("continuity_unavailable", null);
          const row = await deps.checkpoint.readConversation(
            conversationStoreIdentity({
              projectPath: context().projectPath,
              target: context().target,
            }),
          );
          const refusals = evaluateCheckpointConversation(
            conversationObservationFromRow(
              row,
              observeHostedConversation(key, actor),
            ),
            row !== null &&
              deps.checkpoint.backendSupportsCheckpoint(row.agentBackend),
          );
          if (
            refusals.length ||
            !sourceIsCurrent() ||
            deps.checkpoint.getBackgroundActivity(
              context().target.conversationId,
            ) !== null
          )
            return sourceRefusal();
          let backend;
          try {
            backend = await deps.checkpoint.acquireCaptureRuntime(
              {
                target: context().target,
                projectPath: context().projectPath,
                worktreePath: context().worktreePath,
                agentBackend: handoff.backend,
                modelSelection: structuredClone(handoff.modelSelection),
                backendRef: ref,
                captureId: handoff.captureId,
                mode: handoff.requestedMode,
              },
              captureInput.signal,
            );
          } catch {
            await runtime.managed.close();
            return omittedCaptureResult("mode_establishment_failed", ref);
          }
          if (!backend?.captureHandoff)
            return omittedCaptureResult("unavailable", ref);
          const bindingIsCurrent = () =>
            sourceIsCurrent() &&
            isDeepStrictEqual(backend.modelSelection, handoff.modelSelection) &&
            runtime.managed.activityEpoch === startActivity &&
            deps.checkpoint.getBackgroundActivityEpoch(
              context().target.conversationId,
            ) === startBackground;
          if (!bindingIsCurrent()) return sourceRefusal();
          await append(
            {
              timestamp: deps.checkpoint.now(),
              type: "checkpoint_capture_control",
              role: "notice",
              content: [{ type: "text", text: captureInput.promptText }],
            },
            "control",
          );
          if (!bindingIsCurrent()) return sourceRefusal();
          const currentMode = deps.checkpoint.captureAvailability(
            handoff.backend,
          );
          if (
            !currentMode.available ||
            currentMode.mode !== handoff.requestedMode
          )
            return omittedCaptureResult("mode_changed", ref);
          if (captureInput.signal.aborted)
            return omittedCaptureResult("skipped", ref);
          invoked = true;
          const result = captureHandoffResultSchema.parse(
            await backend.captureHandoff({
              ...captureInput,
              mode: handoff.requestedMode,
              onTranscript: async (entry) => {
                if (sinkSettled) {
                  await runtime.managed.track(Promise.resolve());
                  throw new Error("Capture transcript sink is settled");
                }
                const frame = conversationTranscriptFrame(entry);
                return append(
                  frame,
                  frame.role === "user"
                    ? "control"
                    : frame.role === "assistant"
                      ? "output"
                      : "activity",
                );
              },
            }),
          );
          captureResult = result;
          sourceChanged = !bindingIsCurrent();
          if (
            result.executionSettled &&
            result.continuation.nextRuntime !== "current"
          )
            await runtime.managed.close();
          return result;
        };
        const finishAudit = async (result: CaptureHandoffResult) => {
          sinkSettled = true;
          if (!result.submitted && auditEntryIds.length === 0) return;
          if (result.candidateText !== null && !outputAdded) {
            outputAdded = true;
            await append(
              {
                timestamp: deps.checkpoint.now(),
                type: "checkpoint_capture_output",
                role: "assistant",
                content: [{ type: "text", text: result.candidateText }],
              },
              "output",
            );
          }
          if (!settlementAdded) {
            settlementAdded = true;
            await append(
              {
                timestamp: deps.checkpoint.now(),
                type: "checkpoint_capture_settlement",
                role: "notice",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      captureId: handoff.captureId,
                      executionSettled: result.executionSettled,
                      activity: result.activity,
                      omissionReason: result.omissionReason,
                    }),
                  },
                ],
              },
              "settlement",
            );
          }
          await writes;
          if (writeFailure !== undefined) throw writeFailure;
        };
        // Retry only known deterministic work; the source request is never replayed.
        maintenance.reconcileCapture = async () => {
          await writes;
          for (const [id, persist] of pendingWrites) {
            await runtime.managed.trackCaptureReceipt(
              handoff.captureId,
              id,
              persist(),
            );
          }
          writeFailure = undefined;
          runtime.managed.reconcileClose();
          await runtime.managed.close();
          const known =
            captureResult ??
            (!invoked ? omittedCaptureResult("capture_failed", ref) : null);
          if (!known) return false;
          // A successful owned close verifies collection, including work that
          // outlived the original capture deadline. Backends reject close while
          // cleanup remains unverified; the immutable capture result cannot
          // reflect this later observation.
          captureResult = {
            ...known,
            executionSettled: true,
            cleanupFailure: null,
          };
          await finishAudit(captureResult);
          await runtime.managed.settleOwnedWork();
          return true;
        };
        const result = await dispatch();
        captureResult = result;
        if (
          result.executionSettled &&
          !initiallyHosted &&
          runtime.managed.backend
        )
          await runtime.managed.close();
        await writes;
        if (writeFailure !== undefined) throw writeFailure;
        if (!result.executionSettled || result.cleanupFailure !== null)
          return { ...result, auditEntryIds, sourceChanged };
        await finishAudit(result);
        return { ...result, auditEntryIds, sourceChanged };
      },
      async settleReceipts() {
        // Every drain that was claiming or dispatching when the reservation
        // landed finishes first; whatever it admitted is then visible to
        // `observe`.
        while (runtime.queueDrains.size > 0)
          await Promise.allSettled([...runtime.queueDrains]);
        await Promise.allSettled(runtime.debugVerificationWork ?? []);
        await runtime.managed.settleOwnedWork();
        await persistence().whenDurable(context());
      },
      observe() {
        const hosted = observeHostedConversation(key, host.get(key));
        if (
          host.get(key) !== actor ||
          deps.getRuntime(key) !== runtime ||
          !hosted
        )
          return {
            settled: false,
            reason: "conversation_busy",
            backendRef: null,
            activityEpoch: -1,
            backgroundEpoch: -1,
          };
        const reason: CheckpointRefusalCode | null = hosted.busy
          ? "conversation_busy"
          : hosted.turnActive || !hosted.idle
            ? "turn_active"
            : hosted.debugActive
              ? "debug_mode"
              : hosted.questionPending
                ? "question_pending"
                : hosted.trackedWork ||
                    deps.checkpoint.getBackgroundActivity(
                      context().target.conversationId,
                    ) !== null
                  ? "background_work"
                  : null;
        return {
          settled: reason === null,
          reason,
          backendRef: hosted.backendRef,
          activityEpoch: hosted.activityEpoch,
          backgroundEpoch: deps.checkpoint.getBackgroundActivityEpoch(
            context().target.conversationId,
          ),
        };
      },
      observeDurable(conversation) {
        const refusals = evaluateCheckpointConversation(
          conversationObservationFromRow(
            conversation,
            observeHostedConversation(key, host.get(key)),
          ),
          conversation !== null &&
            deps.checkpoint.backendSupportsCheckpoint(
              conversation.agentBackend,
            ),
        );
        return refusals[0]?.code ?? null;
      },
      project(projection) {
        actor.send({ type: "CHECKPOINT_PHASE", checkpoint: projection });
        if (projection?.phase === "retiring") maintenance.phase = "retiring";
        if (projection?.phase === "ready") maintenance.phase = "publishing";
        if (projection?.phase === "needs_reconciliation")
          maintenance.phase = "needs_reconciliation";
      },
      async closeRuntime() {
        // Only a reconcile or a recovery reopens a recorded close failure;
        // an ordinary checkpoint that finds one is refused as busy instead.
        if (maintenance.retryClose) runtime.managed.reconcileClose();
        await closeHostedRuntime(key);
      },
      awaitDurable: () => persistence().whenDurable(context()),
      recordDurabilityFailure(error) {
        runtime.durabilityFailure ??= { context: context(), error };
      },
    };
  }

  /** The owned work after durable admission; settles the reservation either way. */
  async function runOwnedMaintenance(
    key: string,
    actor: ConversationActorRef,
    maintenance: ManagedCheckpointMaintenance,
    maintenanceHost: CheckpointMaintenanceHost,
    operation: CheckpointOperation,
    source: Awaited<ReturnType<typeof captureCheckpointSourceForHost>>,
    captured: ReturnType<CheckpointMaintenanceHost["observe"]>,
  ): Promise<CheckpointOperation> {
    const infra = {
      repo: await deps.checkpoint.repo(),
      readEntries: deps.checkpoint.readEntries,
      findArtifact: deps.checkpoint.findArtifact,
      resolveConfig: deps.checkpoint.resolveConfig,
      executeTaskRun: deps.checkpoint.executeTaskRun,
      generate: deps.checkpoint.generate,
      now: deps.checkpoint.now,
      log: logger,
    };
    try {
      const result = await runCheckpointMaintenance(
        { operation, source, captured, host: maintenanceHost },
        infra,
      );
      maintenance.outcome = "durable";
      if (result.released) {
        releaseMaintenance(key, maintenance, result.operation);
      } else {
        maintenance.operationId = result.hold.operationId;
        maintenance.phase = "needs_reconciliation";
        maintenance.settle(result.operation);
      }
      return result.operation;
    } catch (error) {
      // The outcome itself could not be made durable. Nothing is released
      // and nothing counts as finished: the durable phase still says what the
      // operation was doing, and the reconcile owner decides from that record.
      maintenance.phase = "persistence_failed";
      maintenance.outcome = "undurable";
      logger.error("checkpoint.outcome_persist_failed", {
        ...conversationTargetLogFields(actor.getSnapshot().context.target),
        operationId: operation.id,
        ...checkpointErrorFields(error),
      });
      maintenance.settle(operation);
      return operation;
    }
  }

  function releaseMaintenance(
    key: string,
    maintenance: ManagedCheckpointMaintenance,
    operation: CheckpointOperation | null,
  ): void {
    if (maintenances.get(key) === maintenance) maintenances.delete(key);
    const runtime = deps.getRuntime(key);
    if (runtime?.maintenance === maintenance) runtime.maintenance = undefined;
    maintenance.settle(operation);
    maintenance.release();
    if (operation)
      logger.info("checkpoint.released", {
        operationId: operation.id,
        phase: operation.phase,
      });
    // Every release restores ordinary queued admission — a nudge that arrived
    // under the hold would otherwise wait for an unrelated idle entry. The
    // checkpoint itself never consumes a queued message.
    const actor = host.get(key);
    const context = actor ? readUsableSnapshot(actor)?.context : undefined;
    if (context) drainAfterTurn(context);
  }

  /** Serialize stop requests with capture start and durable result settlement. */
  function mutateCapture<T>(
    maintenance: ManagedCheckpointMaintenance,
    work: () => Promise<T>,
  ): Promise<T> {
    const result = maintenance.captureMutation.then(work);
    maintenance.captureMutation = result.catch(() => undefined);
    return result;
  }

  async function stopCheckpointCapture(
    repo: ConversationCheckpointsRepo,
    scopeKey: CheckpointScopeKey,
    maintenance: ManagedCheckpointMaintenance,
    operationId: string,
    intent: "skip" | "cancel",
  ) {
    return mutateCapture(maintenance, async () => {
      const operation = await repo.getOperation(scopeKey, operationId);
      const handoff = operation?.handoff;
      if (
        !operation ||
        !handoff ||
        operation.phase !== "building" ||
        (handoff.stage !== "pending" &&
          handoff.stage !== "running" &&
          handoff.stage !== "settling")
      )
        return operation;
      const stopped = await repo.settleCapture({
        key: scopeKey,
        operationId,
        captureId: handoff.captureId,
        expectedSourceBasis: operation.sourceBasis,
        expectedStage: handoff.stage,
        settlement: { kind: "stop", intent },
        at: deps.checkpoint.now(),
      });
      if (!stopped.ok)
        throw new Error(`Capture stop refused: ${stopped.refusal.code}`);
      maintenance.captureController.abort(intent);
      return stopped.value;
    });
  }

  async function skipConversationCheckpointHandoff(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<
    | {
        kind: "stopping" | "handoff_already_settled";
        operation: CheckpointOperation;
      }
    | { kind: "refused"; refusal: CheckpointRefusal }
  > {
    const identity = conversationStoreIdentity(input.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const repo = await deps.checkpoint.repo();
    const scopeKey = checkpointKeyFor(input.address);
    const maintenance = activeMaintenance(key);
    const operation =
      maintenance?.operationId === input.operationId &&
      maintenance.phase === "building"
        ? await stopCheckpointCapture(
            repo,
            scopeKey,
            maintenance,
            input.operationId,
            "skip",
          )
        : await repo.getOperation(scopeKey, input.operationId);
    if (!operation)
      return {
        kind: "refused",
        refusal: checkpointRefusal(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        ),
      };
    if (
      operation.handoff?.stage === "settling" &&
      maintenance?.operationId === operation.id &&
      maintenance.phase === "building"
    )
      return { kind: "stopping", operation };
    if (
      operation.handoff &&
      ["pending", "running", "settling"].includes(operation.handoff.stage)
    )
      return {
        kind: "refused",
        refusal: checkpointRefusal(
          "not_owned",
          "capture requires reconciliation",
          operation,
        ),
      };
    return { kind: "handoff_already_settled", operation };
  }

  /**
   * Cancel a building checkpoint. After the payload is frozen the transition
   * finishes forward to a safe outcome instead, and the caller learns which.
   */
  async function cancelConversationCheckpoint(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<ConversationCheckpointCancel> {
    const identity = conversationStoreIdentity(input.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const scopeKey = checkpointKeyFor(input.address);
    const repo = await deps.checkpoint.repo();
    const maintenance = activeMaintenance(key);
    if (maintenance && maintenance.operationId === input.operationId) {
      if (maintenance.phase === "needs_reconciliation") {
        const operation = await repo.getOperation(scopeKey, input.operationId);
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "not_cancellable",
            "this operation needs reconciliation or explicit recovery",
            operation,
          ),
        };
      }
      const cancellable = maintenance.phase === "building";
      if (cancellable) {
        maintenance.controller.abort("cancelled");
        await stopCheckpointCapture(
          repo,
          scopeKey,
          maintenance,
          input.operationId,
          "cancel",
        );
      }
      const operation =
        (await maintenance.work) ??
        (await repo.getOperation(scopeKey, input.operationId));
      if (!operation)
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "checkpoint_not_found",
            "the operation no longer exists",
          ),
        };
      if (maintenance.outcome === "undurable")
        return {
          kind: "refused",
          refusal: checkpointRefusal(
            "recovery_required",
            "the operation's outcome could not be made durable; run checkpoint reconcile",
            (await repo.getOperation(scopeKey, input.operationId)) ?? operation,
          ),
        };
      return operation.phase === "cancelled"
        ? { kind: "cancelled", operation }
        : { kind: "completed", operation };
    }
    // Nothing in this process owns the operation. An unhosted conversation
    // may still hold one a restart interrupted, and the restart rules decide
    // what it became before this cancel answers: an interrupted build is
    // already failed, an interrupted retirement has finished forward.
    const hydration =
      host.get(key) === undefined
        ? await hydrateAuthorityForUnhosted(key, scopeKey, identity)
        : null;
    const operation = await repo.getOperation(scopeKey, input.operationId);
    if (!operation)
      return {
        kind: "refused",
        refusal: checkpointRefusal(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        ),
      };
    if (operation.phase === "cancelled")
      return { kind: "cancelled", operation };
    // The cancel arrived after retirement had begun and this call finished
    // it forward: the caller learns that, as it would from a live cancel.
    if (
      hydration?.outcome.kind === "retirement_completed" &&
      hydration.outcome.operation.id === operation.id
    )
      return { kind: "completed", operation };
    if (operation.phase === "building" || operation.phase === "retiring")
      return {
        kind: "refused",
        refusal: checkpointRefusal(
          "not_owned",
          "this operation is not owned by the running server; run checkpoint reconcile",
          operation,
        ),
      };
    return {
      kind: "refused",
      refusal: checkpointRefusal(
        "not_cancellable",
        operation.phase === "needs_reconciliation"
          ? "this operation needs reconciliation or explicit recovery"
          : `a ${operation.phase} operation cannot be cancelled`,
        operation,
      ),
    };
  }

  /**
   * Deterministic repair of an owned checkpoint: retry the recorded close,
   * the readiness commit and the row/snapshot receipts, or record a build
   * whose outcome never became durable. Never sends a model request. An
   * unresolved delivery stays blocked — first behind the existing queue
   * review, then behind an explicit recovery that names the operation.
   *
   * Ownership is taken before the first await. An in-process hold is claimed
   * as `reconciling`; a hold that exists only durably gets a transient
   * reservation. Either way a competing reconcile, recovery, drain or stop
   * sees the repair in progress instead of passing the same checks in
   * parallel and projecting over its result.
   *
   * An infrastructure error settles that ownership rather than leaking it.
   * Before the host is bound the claim is handed back and the error
   * propagates; after it, the maintenance stays as a hold that the next
   * reconcile resumes from the durable phase, because nothing short of a
   * read that may fail the same way can say what the repair left behind.
   */
  async function reconcileConversationCheckpoint(input: {
    address: ConversationAddress;
    operationId: string;
    captureExecutionStopped?: boolean;
    source?: "cli" | "ui" | "api";
  }): Promise<ConversationCheckpointReconcile> {
    const identity = conversationStoreIdentity(input.address);
    const key = conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    const scopeKey = checkpointKeyFor(input.address);
    const logFields = {
      ...conversationTargetLogFields(input.address.target),
      operationId: input.operationId,
    };
    const refused = (
      code: CheckpointRefusalCode,
      reason: string,
      operation: CheckpointOperation | null = null,
    ): ConversationCheckpointReconcile => {
      logger.info("checkpoint.reconcile.refused", { ...logFields, code });
      return {
        kind: "refused",
        refusal: checkpointRefusal(code, reason, operation),
      };
    };

    const existing = activeMaintenance(key);
    if (existing && existing.operationId !== input.operationId) {
      const repo = await deps.checkpoint.repo();
      if ((await repo.getOperation(scopeKey, input.operationId)) === null)
        return refused(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        );
      return refused(
        "checkpoint_pending",
        "another checkpoint operation owns this conversation",
        existing.operationId
          ? await repo.getOperation(scopeKey, existing.operationId)
          : null,
      );
    }
    if (
      existing &&
      existing.phase !== "needs_reconciliation" &&
      existing.phase !== "persistence_failed"
    )
      return refused(
        "conversation_busy",
        existing.phase === "reconciling"
          ? "a reconcile is already running for this operation"
          : "the operation is still running; wait for its outcome",
        await (
          await deps.checkpoint.repo()
        ).getOperation(scopeKey, input.operationId),
      );

    // Claim before the first await.
    const transient = existing === undefined;
    const previousPhase = existing?.phase ?? "reconciling";
    const maintenance =
      existing ??
      createMaintenance(`reconcile:${input.operationId}`, {
        recovers: null,
        retryClose: true,
      });
    maintenance.operationId = input.operationId;
    maintenance.phase = "reconciling";
    if (transient) maintenances.set(key, maintenance);

    /** Hand the claim back with nothing durable changed. */
    const abandon = (operation: CheckpointOperation | null): void => {
      if (transient) dropReservation(key, maintenance, operation);
      else maintenance.phase = previousPhase;
    };
    const refusedAfterClaim = (
      code: CheckpointRefusalCode,
      reason: string,
      operation: CheckpointOperation | null = null,
    ): ConversationCheckpointReconcile => {
      abandon(operation);
      return refused(code, reason, operation);
    };

    // Nothing durable has changed yet, so a failure here hands the claim
    // back; left `reconciling`, it would refuse every later reconcile as busy
    // and every recovery as pending long after the infrastructure recovered.
    let repo: ConversationCheckpointsRepo;
    let read: CheckpointOperation | null;
    try {
      repo = await deps.checkpoint.repo();
      if (transient && host.get(key) === undefined)
        await hydrateAuthorityForUnhosted(key, scopeKey, identity);
      read = await repo.getOperation(scopeKey, input.operationId);
    } catch (error) {
      abandon(null);
      throw error;
    }
    if (!read)
      return refusedAfterClaim(
        "checkpoint_not_found",
        "no such checkpoint operation in this scope",
      );
    const operation: CheckpointOperation = read;
    const captureCleanupHold =
      operation.phase === "needs_reconciliation" &&
      operation.lastStablePhase === "building" &&
      operation.payloadId === null &&
      operation.handoff?.stage === "omitted" &&
      (operation.handoff.omissionReason === "interrupted" ||
        operation.handoff.omissionReason === "cleanup_unverified");
    if (
      input.captureExecutionStopped &&
      (!captureCleanupHold ||
        (operation.handoff?.executionSettled &&
          !operation.handoff.executionStopAttestation))
    )
      return refusedAfterClaim(
        "invalid_handoff",
        "execution acknowledgement applies only to capture execution uncertainty",
        operation,
      );
    if (operation.supersededByOperationId !== null)
      return refusedAfterClaim(
        "stale_operation",
        `operation ${operation.id} is superseded by recovery ${operation.supersededByOperationId}`,
        operation,
      );
    if (transient) {
      if (operation.phase === "delivering")
        return refusedAfterClaim(
          "conversation_busy",
          "a delivery attempt is in flight for this operation",
          operation,
        );
      if (operation.phase === "building" || operation.phase === "retiring")
        return refusedAfterClaim(
          "conversation_busy",
          "the operation is still running; wait for its outcome",
          operation,
        );
      if (operation.phase !== "needs_reconciliation") {
        abandon(operation);
        return { kind: "unchanged", operation };
      }
    }

    // The repair projects onto the actor and awaits its receipts, so a host
    // is needed; waking a dormant one loads the durable hold it starts under.
    let actor: ConversationActorRef;
    try {
      actor = await ensureConversationActor(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
    } catch (error) {
      if (error instanceof ConversationBindingNotFoundError)
        return refusedAfterClaim("conversation_not_found", error.message);
      abandon(operation);
      throw error;
    }
    const hostRuntime = deps.getRuntime(key);
    if (!hostRuntime)
      return refusedAfterClaim(
        "conversation_busy",
        "the conversation host is not registered",
        operation,
      );
    const runtime: ConversationRuntimeState = hostRuntime;
    if (transient) {
      runtime.maintenance = maintenance;
      maintenance.admit(operation);
    }
    const maintenanceHost = createMaintenanceHost(
      scopeKey,
      key,
      actor,
      runtime,
      maintenance,
    );
    logger.info("checkpoint.reconcile.started", {
      ...logFields,
      phase: operation.phase,
      lastStablePhase: operation.lastStablePhase,
      undurableOutcome: existing?.outcome === "undurable",
      hosted: !transient,
    });
    const at = () => deps.checkpoint.now();

    const repaired = (
      repairedOperation: CheckpointOperation,
    ): ConversationCheckpointReconcile => {
      maintenance.outcome = "durable";
      releaseMaintenance(key, maintenance, repairedOperation);
      logger.info("checkpoint.reconcile.repaired", {
        ...logFields,
        phase: repairedOperation.phase,
      });
      return { kind: "repaired", operation: repairedOperation };
    };
    /**
     * A hold kept past this call is one the next reconcile — or an explicit
     * recovery, which takes over only a durably settled hold — reasons about
     * from the durable record. The exception is a hold whose own outcome
     * write never landed while the record still shows the build in flight:
     * only the undurable branch knows how to finish that, so it keeps its
     * marker.
     */
    const settleOutcome = (known: CheckpointOperation): void => {
      if (
        maintenance.outcome === "undurable" &&
        known.phase !== "needs_reconciliation" &&
        !isTerminalCheckpointPhase(known.phase)
      )
        return;
      maintenance.outcome = "durable";
    };
    const blocked = (
      blockedOperation: CheckpointOperation,
      code: CheckpointRefusalCode,
      reason: string,
    ): ConversationCheckpointReconcile => {
      // Once a durable-only hold's reservation is dropped, the projection is
      // all that keeps ordinary admission held: it follows the durable
      // record, never a step this call projected ahead of a write.
      if (blockedOperation.phase === "needs_reconciliation")
        maintenanceHost.project({
          operationId: blockedOperation.id,
          phase: "needs_reconciliation",
        });
      if (transient) dropReservation(key, maintenance, blockedOperation);
      else {
        settleOutcome(blockedOperation);
        maintenance.phase = "needs_reconciliation";
      }
      logger.warn("checkpoint.reconcile.blocked", {
        ...logFields,
        code,
        phase: blockedOperation.phase,
        lastStablePhase: blockedOperation.lastStablePhase,
        attemptId: blockedOperation.delivery?.attemptId ?? null,
      });
      return {
        kind: "blocked",
        operation: blockedOperation,
        refusal: checkpointRefusal(code, reason, blockedOperation),
      };
    };
    /**
     * A recovery build that ended without a checkpoint: the repository
     * restored the gate it superseded in the same write, and the host stays
     * held by that prior operation — exactly as an in-process settlement of
     * the same build leaves it — rather than draining into uncertain
     * continuity.
     */
    async function holdRestoredGate(
      settledOperation: CheckpointOperation,
      hold: CheckpointActorProjection,
    ): Promise<ConversationCheckpointReconcile> {
      maintenanceHost.project(hold);
      maintenance.operationId = hold.operationId;
      maintenance.phase = "needs_reconciliation";
      maintenance.outcome = "durable";
      maintenance.settle(settledOperation);
      const prior = await repo.getOperation(scopeKey, hold.operationId);
      logger.warn("checkpoint.reconcile.gate_restored", {
        ...logFields,
        phase: settledOperation.phase,
        restoredOperationId: hold.operationId,
      });
      const reason = `recovery ${settledOperation.id} ended ${settledOperation.phase}; operation ${hold.operationId} still needs explicit recovery`;
      return {
        kind: "blocked",
        operation: settledOperation,
        refusal: prior
          ? checkpointRefusal("recovery_required", reason, prior)
          : {
              code: "recovery_required",
              reason,
              operationId: hold.operationId,
              phase: hold.phase,
            },
      };
    }
    const unchanged = async (
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> => {
      if (transient) dropReservation(key, maintenance, current);
      else if (isTerminalCheckpointPhase(current.phase)) {
        const restored =
          current.phase === "failed" || current.phase === "cancelled"
            ? restoredGateFor(current)
            : null;
        if (restored) return holdRestoredGate(current, restored);
        releaseMaintenance(key, maintenance, current);
      } else maintenance.phase = previousPhase;
      return { kind: "unchanged", operation: current };
    };

    /**
     * The repair threw partway. What it wrote before that is durable or is
     * not, and the read that would tell may fail the same way — so the host
     * is not released on either reading. The maintenance stays as a hold,
     * a loaded hold's reservation becoming the in-process hold the failure
     * would have left under the original owner, and the next reconcile
     * resumes from whichever durable phase it finds.
     */
    async function retainAfterFailure(): Promise<ConversationCheckpointReconcile> {
      let current: CheckpointOperation | null = null;
      try {
        current = await repo.getOperation(scopeKey, operation.id);
      } catch (lookupError) {
        logger.error("checkpoint.reconcile.lookup_failed", {
          ...logFields,
          ...checkpointErrorFields(lookupError),
        });
      }
      const known = current ?? operation;
      // A readiness nothing proved durable must not be what the projection
      // reports; a durable `ready` keeps its projection and this hold.
      if (known.phase !== "ready")
        maintenanceHost.project({
          operationId: known.id,
          phase: "needs_reconciliation",
        });
      settleOutcome(known);
      maintenance.phase = "needs_reconciliation";
      maintenance.settle(known);
      logger.warn("checkpoint.reconcile.blocked", {
        ...logFields,
        code: "reconciliation_failed",
        phase: known.phase,
        lastStablePhase: known.lastStablePhase,
        attemptId: known.delivery?.attemptId ?? null,
        retained: true,
      });
      return {
        kind: "blocked",
        operation: known,
        refusal: checkpointRefusal(
          "reconciliation_failed",
          "the repair did not complete; retry checkpoint reconcile",
          known,
        ),
      };
    }

    async function prepareReadiness(
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile | null> {
      try {
        await reconcileHostFailures(key, runtime, input.address.target);
        maintenanceHost.project({ operationId: current.id, phase: "ready" });
        await maintenanceHost.awaitDurable();
      } catch (error) {
        maintenanceHost.recordDurabilityFailure(error);
        logger.error("checkpoint.reconcile.persistence_failed", {
          ...logFields,
          ...checkpointErrorFields(error),
        });
        if (current.phase === "needs_reconciliation") {
          return blocked(
            current,
            "reconciliation_failed",
            "row or snapshot receipts did not settle; retry checkpoint reconcile",
          );
        }
        const held = await repo.recordOutcome({
          key: scopeKey,
          operationId: current.id,
          expectedPhase: current.phase,
          phase: "needs_reconciliation",
          failure: {
            code: "readiness_receipts_failed",
            message:
              "row or snapshot receipts did not settle before readiness; run checkpoint reconcile",
          },
          at: at(),
        });
        maintenanceHost.project({
          operationId: current.id,
          phase: "needs_reconciliation",
        });
        return blocked(
          held.ok ? held.value : current,
          "reconciliation_failed",
          "row or snapshot receipts did not settle; retry checkpoint reconcile",
        );
      }
      return null;
    }

    /** Close the retired runtime again and finish the clear-and-commit. */
    async function finishRetirement(
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> {
      try {
        // The reconcile is the owner retrying the recorded close failure;
        // without this the runtime would answer with the failure it recorded.
        runtime.managed.reconcileClose();
        await maintenanceHost.closeRuntime();
      } catch (error) {
        logger.error("checkpoint.reconcile.close_failed", {
          ...logFields,
          ...checkpointErrorFields(error),
        });
        return blocked(
          current,
          "reconciliation_failed",
          "the retired runtime still did not close; retry checkpoint reconcile",
        );
      }
      const receiptFailure = await prepareReadiness(current);
      if (receiptFailure) return receiptFailure;
      const committed = await repo.commitReady({
        key: scopeKey,
        operationId: current.id,
        at: at(),
      });
      if (committed.ok) return repaired(committed.value);
      // Refused under another writer: the projection follows the durable
      // phase, never this call's expectation of it.
      const durable =
        (await repo.getOperation(scopeKey, current.id)) ?? current;
      if (durable.phase === "ready") return repaired(durable);
      return blocked(
        durable,
        "reconciliation_failed",
        `readiness was refused: ${committed.refusal.code}`,
      );
    }

    /** Retry the receipts a readiness commit left unsettled, then declare ready. */
    async function finishReadiness(
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> {
      const receiptFailure = await prepareReadiness(current);
      if (receiptFailure) return receiptFailure;
      let ready = current;
      if (current.phase === "needs_reconciliation") {
        const declared = await repo.recordOutcome({
          key: scopeKey,
          operationId: current.id,
          expectedPhase: "needs_reconciliation",
          phase: "ready",
          at: at(),
        });
        if (!declared.ok)
          return blocked(
            current,
            "reconciliation_failed",
            declared.refusal.reason,
          );
        ready = declared.value;
      }
      return repaired(ready);
    }

    async function reconcileCaptureHold(
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> {
      const observed = (await maintenance.reconcileCapture?.()) ?? false;
      runtime.managed.reconcileClose();
      await maintenanceHost.closeRuntime();
      await reconcileHostFailures(key, runtime, input.address.target);
      await maintenanceHost.awaitDurable();

      if (observed && !current.handoff?.executionSettled && current.handoff) {
        const recorded = await repo.recordOutcome({
          key: scopeKey,
          operationId: current.id,
          expectedPhase: "needs_reconciliation",
          phase: "needs_reconciliation",
          captureCleanupObserved: { captureId: current.handoff.captureId },
          at: at(),
        });
        if (!recorded.ok)
          return blocked(
            current,
            "reconciliation_failed",
            recorded.refusal.reason,
          );
        current = recorded.value;
      } else if (input.captureExecutionStopped) {
        const timestamp = at();
        const acknowledged = await repo.recordOutcome({
          key: scopeKey,
          operationId: current.id,
          expectedPhase: "needs_reconciliation",
          phase: "needs_reconciliation",
          captureExecutionStopAttestation: {
            at: timestamp,
            source: input.source ?? "api",
          },
          at: timestamp,
        });
        if (!acknowledged.ok)
          return blocked(
            current,
            "reconciliation_failed",
            acknowledged.refusal.reason,
          );
        current = acknowledged.value;
      }
      if (!current.handoff?.executionSettled)
        return blocked(
          current,
          "recovery_required",
          "capture execution remains uncertain; inspect and stop prior backend work, then reconcile with captureExecutionStopped acknowledgement",
        );
      maintenance.sealCapture?.();
      actor.send({
        type: "CHECKPOINT_PHASE",
        checkpoint: { operationId: current.id, phase: "needs_reconciliation" },
        clearContinuation: true,
      });
      await maintenanceHost.awaitDurable();
      return blocked(
        current,
        "recovery_required",
        "capture cleanup is settled; run compact-context --recover with this operation id for a fresh baseline checkpoint",
      );
    }

    try {
      if (
        captureCleanupHold ||
        (operation.phase === "needs_reconciliation" &&
          operation.lastStablePhase === "building" &&
          operation.handoff?.executionSettled &&
          operation.handoff.continuationDisposition === "clear")
      )
        return await reconcileCaptureHold(operation);
      if (existing?.outcome === "undurable") {
        // The outcome write itself failed; the durable phase says what the
        // build was doing when it did.
        switch (operation.phase) {
          case "building": {
            const cancelled =
              operation.handoff !== null && existing.controller.signal.aborted;
            const lostContinuation =
              operation.recoversOperationId === null &&
              operation.handoff?.executionSettled &&
              operation.handoff.continuationDisposition === "clear" &&
              operation.protectedReferences.priorBackendRef !== null;
            if (
              lostContinuation ||
              (operation.handoff &&
                operation.handoff.stage !== "pending" &&
                !operation.handoff.executionSettled)
            ) {
              const held = await repo.recordOutcome({
                key: scopeKey,
                operationId: operation.id,
                expectedPhase: "building",
                phase: "needs_reconciliation",
                failure: {
                  code: lostContinuation
                    ? cancelled
                      ? "cancelled"
                      : "capture_continuation_lost"
                    : "capture_cleanup_unverified",
                  message:
                    "capture outcome was not durable; reconciling owned cleanup",
                },
                at: at(),
              });
              if (!held.ok)
                return blocked(
                  operation,
                  "reconciliation_failed",
                  held.refusal.reason,
                );
              return await reconcileCaptureHold(held.value);
            }

            const failed = await repo.recordOutcome({
              key: scopeKey,
              operationId: operation.id,
              expectedPhase: "building",
              phase: cancelled ? "cancelled" : "failed",
              failure: {
                code: cancelled ? "cancelled" : "outcome_unrecorded",
                message: cancelled
                  ? "checkpoint cancellation settled but its outcome required a persistence retry"
                  : "the build ended but its outcome could not be recorded; recorded as failed by checkpoint reconcile",
              },
              at: at(),
            });
            if (!failed.ok)
              return blocked(
                operation,
                "reconciliation_failed",
                failed.refusal.reason,
              );
            const restored = restoredGateFor(failed.value);
            if (restored) return await holdRestoredGate(failed.value, restored);
            maintenanceHost.project(null);
            return repaired(failed.value);
          }
          case "retiring":
            return await finishRetirement(operation);
          case "ready":
            return await finishReadiness(operation);
          default:
            return await unchanged(operation);
        }
      }
      // A hold this owner kept after a failed repair whose readiness had
      // committed: only the receipts are outstanding.
      if (!transient && operation.phase === "ready")
        return await finishReadiness(operation);
      if (operation.phase !== "needs_reconciliation")
        return await unchanged(operation);
      switch (operation.lastStablePhase) {
        case "retiring":
          return await finishRetirement(operation);
        case "ready":
          return await finishReadiness(operation);
        case "delivering": {
          const admissionState = await deps.readAdmissionState(identity);
          return admissionState.requiresQueueReview
            ? blocked(
                operation,
                "queue_review_required",
                "the attempted delivery is unresolved; retry or discard the uncertain queued deliveries, then run compact-context --recover with this operation id",
              )
            : blocked(
                operation,
                "recovery_required",
                "the attempted delivery is unresolved; run compact-context --recover with this operation id to build a fresh checkpoint",
              );
        }
        case "applied":
          return blocked(
            operation,
            "recovery_required",
            "the applied continuation became unusable; run compact-context --recover with this operation id to build a fresh checkpoint from the recorded history",
          );
        default:
          return blocked(
            operation,
            "recovery_required",
            "this operation needs explicit recovery; run compact-context --recover with this operation id",
          );
      }
    } catch (error) {
      logger.error("checkpoint.reconcile.failed", {
        ...logFields,
        ...checkpointErrorFields(error),
      });
      return await retainAfterFailure();
    }
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
    applyCostSettlementToHostedActor,
    getConversationRuntimeConfiguration,
    checkpointAcceptsQueuedInput,
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
    releaseIdleConversationRuntime,
    checkConversationCheckpoint,
    startConversationCheckpoint,
    skipConversationCheckpointHandoff,
    cancelConversationCheckpoint,
    reconcileConversationCheckpoint,
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

export function checkpointAcceptsQueuedInput(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): boolean {
  return defaultManager().checkpointAcceptsQueuedInput(
    projectPath,
    sessionName,
    conversationId,
  );
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

export function releaseIdleConversationRuntime(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<IdleRuntimeRelease> {
  return defaultManager().releaseIdleConversationRuntime(
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

export function checkConversationCheckpoint(
  address: ConversationAddress,
  options?: { recover?: string | null },
): Promise<ConversationCheckpointCheck> {
  return defaultManager().checkConversationCheckpoint(address, options);
}

export function startConversationCheckpoint(
  input: ConversationCheckpointRequest,
): Promise<ConversationCheckpointStart> {
  return defaultManager().startConversationCheckpoint(input);
}

export function reconcileConversationCheckpoint(input: {
  address: ConversationAddress;
  operationId: string;
  captureExecutionStopped?: boolean;
  source?: "cli" | "ui" | "api";
}): Promise<ConversationCheckpointReconcile> {
  return defaultManager().reconcileConversationCheckpoint(input);
}

export function cancelConversationCheckpoint(input: {
  address: ConversationAddress;
  operationId: string;
}): Promise<ConversationCheckpointCancel> {
  return defaultManager().cancelConversationCheckpoint(input);
}

export function skipConversationCheckpointHandoff(input: {
  address: ConversationAddress;
  operationId: string;
}) {
  return defaultManager().skipConversationCheckpointHandoff(input);
}
