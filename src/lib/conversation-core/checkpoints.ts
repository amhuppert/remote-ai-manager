/**
 * Checkpoints ("compact context now") of the conversations the shared
 * conversation core runs: check, start, cancel, skip and reconcile, the
 * checkpoint half of the core's hold check, and the restart rules at boot.
 *
 * The checkpoint operation row is the durable holder. While it is building,
 * retiring, delivering or held for reconciliation the core starts no message
 * and no task (`refusal`); while it is ready it starts the next message, which
 * carries the frozen seed, and no task. In-process exclusivity is one core
 * lease, taken synchronously before anything is read and kept until the build
 * has a durable outcome, so no turn, task or command starts under a build.
 *
 * The owned work itself (the optional capture, generation, the fenced freeze,
 * retirement and readiness) is the conversation lifecycle's checkpoint
 * maintenance, run over a host made of the core's own effects; generation
 * runs on a task lane of its own, on no conversation, and a requested
 * handoff is captured in the conversation's own session (`checkpoint-capture`).
 */

import type {
  BackendModelSelection,
  CaptureAvailability,
} from "@/lib/agent-backends/schemas";
import type { CompactionConfig } from "@/lib/config/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import {
  evaluateCheckpointAdmission,
  evaluateCheckpointConversation,
  type CheckpointAdmissionObservation,
  type CheckpointConversationObservation,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
} from "@/lib/conversation-checkpoints/admission";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import {
  CHECKPOINT_CAPTURE_POLICY,
  type CheckpointHandoffEligibility,
} from "@/lib/conversation-checkpoints/receipt";
import {
  planCheckpointReconcile,
  type CheckpointReconcilePlan,
} from "@/lib/conversation-checkpoints/reconcile-plan";
import type {
  CheckpointAdmissionState,
  ConversationCheckpointsRepo,
} from "@/lib/conversation-checkpoints/repo";
import {
  checkpointActorProjection,
  isActiveCheckpointPhase,
  type CheckpointOperation,
  type CheckpointPhase,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import {
  conversationStoreIdentity,
  conversationTargetLogFields,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { queuedMessageBlocksOrdinaryAdmission } from "@/lib/conversations/message-queue-schemas";
import type {
  ConversationBackgroundActivity,
  ConversationState,
  ForkedFrom,
} from "@/lib/conversations/schemas";
import type { CheckpointForkOrigin } from "@/lib/conversation-checkpoints/fork-schemas";
import type { Logger } from "@/lib/logging";
import type {
  TranscriptEntriesResult,
  TranscriptEntry,
} from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { checkpointScopeKeyForStoreIdentity } from "@/lib/conversation-checkpoints/scope-key";
import { pendingCheckpointCapture } from "@/lib/conversation-checkpoints/checkpoint-capture";
import {
  captureCoreHandoff,
  type CaptureRuntime,
  type CaptureRuntimeRequest,
  type RetainedCapture,
} from "./checkpoint-capture";
import {
  captureCheckpointSourceForHost,
  runCheckpointMaintenance,
  type CheckpointMaintenanceHost,
} from "@/lib/conversation-checkpoints/checkpoint-maintenance";
import {
  checkpointKeyLogFields,
  hydrateCheckpointAuthority,
} from "@/lib/conversation-checkpoints/checkpoint-restart";
import { repairQueuedAcceptanceFromCheckpoint } from "@/lib/conversation-checkpoints/checkpoint-queue-repair";
import {
  prepareCheckpointSeed,
  type PreparedCheckpointSeed,
} from "@/lib/conversation-checkpoints/checkpoint-seed";
import {
  resolveContinuationSeed,
  type ContinuationSeed,
} from "@/lib/conversation-checkpoints/continuation-seed";
import type { ForkSeedDeps } from "@/lib/conversation-checkpoints/fork-seed";
import type {
  ConversationCheckpointReconcile,
  ConversationCheckpointStart,
  CoreConversationCheckpoints,
} from "@/lib/conversation-checkpoints/operation-contract";
import type { ConversationIdentity } from "./conversation-record";
import type { ConversationCore, HoldSource } from "./executor";
import type { InteractiveEnrollmentRecord } from "./schemas";
import type { TaskLane } from "./task-turns";

/** A conversation as the state store keys it: the project sentinel for a project conversation. */
interface StoreIdentity {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

/** The checkpoint domain's edges: durable state, the archive, generation and the core's runtimes. */
export interface CoreCheckpointPorts {
  repo(): ConversationCheckpointsRepo;
  readConversation(identity: StoreIdentity): Promise<ConversationState | null>;
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
  findArtifact(conversationId: string): Promise<ContextArtifactRow | null>;
  resolveConfig(projectPath: string): Promise<CompactionConfig>;
  /** A fresh lane for one build's generation passes: tasks on no conversation. */
  taskLane(): TaskLane;
  generate: typeof generateCheckpoint;
  /** The model a requested handoff's capture runs on. */
  resolveCaptureModel(input: {
    agentBackend: AgentBackendId;
    transcriptPath: string | null;
    projectPath: string;
  }): Promise<BackendModelSelection>;
  backendSupportsCheckpoint(backend: AgentBackendId): boolean;
  /** Whether the backend can capture a handoff, and in which mode. */
  captureAvailability(backend: AgentBackendId): CaptureAvailability;
  /** Appends one entry of a capture's audit to the conversation's transcript, once. */
  appendCaptureEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  background: {
    activity(conversationId: string): ConversationBackgroundActivity | null;
    /** The channel's change count; see `BackgroundActivityChannel.epoch`. */
    epoch(conversationId: string): number;
  };
  /** Releases queued rows a durable checkpoint acceptance proves delivered. */
  confirmQueuedDelivery(
    input: StoreIdentity & { ids: string[]; deliveryAttemptId: string },
  ): Promise<number>;
  appendUserEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  worktreeOf(identity: StoreIdentity): Promise<string>;
  runtime: {
    /** Closes the conversation's runtime, if one is hosted. */
    release(conversationId: string): Promise<void>;
    /** Closes again a runtime whose close failed. */
    retryRelease(conversationId: string): Promise<void>;
    /** Why the conversation's runtime could not be closed, or null. */
    closeFailure(conversationId: string): Promise<string | null>;
    /**
     * A runtime resuming the conversation's session for a handoff capture,
     * hosted as the conversation's runtime, so its release closes it.
     */
    openForCapture(input: CaptureRuntimeRequest): Promise<CaptureRuntime>;
  };
  /** Receipts the conversation's earlier turns still owe, settled before its checkpoint state is read. */
  settleTurnReceipts(conversationId: string): Promise<void>;
  now(): string;
}

export interface CoreCheckpointDeps extends CoreCheckpointPorts {
  core: Pick<ConversationCore, "hold" | "isBusy" | "runningAttempt">;
  enrollment(conversationId: string): InteractiveEnrollmentRecord | null;
  log: Logger;
}

export interface CoreCheckpoints extends CoreConversationCheckpoints {
  /** The checkpoint half of the core's hold check: null when a turn of this kind may start. */
  refusal: HoldSource["refusal"];
  /** Boot: the restart rules for an operation the last process left in flight, then the queued receipts an acceptance proves. */
  recover(enrollment: InteractiveEnrollmentRecord): Promise<void>;
}

/** A build this process runs, from its lease to its durable outcome. */
interface OwnedBuild {
  readonly requestId: string;
  operationId: string | null;
  phase: "admitting" | "building" | "retiring" | "publishing";
  /** The build ended but its outcome could not be written; the durable phase still shows it in flight. */
  undurable: boolean;
  readonly controller: AbortController;
  readonly captureController: AbortController;
  captureMutation: Promise<unknown>;
  /** The admitted operation, or null when the start was refused. */
  readonly admitted: Promise<CheckpointOperation | null>;
  /** The operation as its build left it. */
  readonly work: Promise<CheckpointOperation | null>;
  admit(operation: CheckpointOperation): void;
  settle(operation: CheckpointOperation | null): void;
}

function createBuild(requestId: string): OwnedBuild {
  let resolveAdmitted: (
    operation: CheckpointOperation | null,
  ) => void = () => {};
  let resolveWork: (operation: CheckpointOperation | null) => void = () => {};
  const admitted = new Promise<CheckpointOperation | null>(
    (resolve) => (resolveAdmitted = resolve),
  );
  const work = new Promise<CheckpointOperation | null>(
    (resolve) => (resolveWork = resolve),
  );
  return {
    requestId,
    operationId: null,
    phase: "admitting",
    undurable: false,
    controller: new AbortController(),
    captureController: new AbortController(),
    captureMutation: Promise.resolve(),
    admitted,
    work,
    admit: resolveAdmitted,
    settle(operation) {
      resolveAdmitted(operation);
      resolveWork(operation);
    },
  };
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

function refused(
  code: CheckpointRefusalCode,
  reason: string,
  operation: CheckpointOperation | null = null,
) {
  return {
    kind: "refused" as const,
    refusal: checkpointRefusal(code, reason, operation),
  };
}

function observationFromRow(
  row: ConversationState | null,
): CheckpointConversationObservation | null {
  if (row === null) return null;
  return {
    archived: row.archived,
    role: row.role,
    owned: row.owner !== null,
    agentBackend: row.agentBackend,
    debugActive: row.debugMode?.active === true,
    questionPending: row.pendingQuestionId !== null,
    transient: false,
    promptCount: row.promptCount,
    transcriptPath: row.transcriptPath,
    running: row.status === "running",
  };
}

function activePhase(
  operation: CheckpointOperation | null,
): CheckpointPhase | null {
  return operation !== null && isActiveCheckpointPhase(operation.phase)
    ? operation.phase
    : null;
}

/** Whether a checkpoint of this conversation could capture a handoff: its backend's capture, from its own session. */
function captureEligibility(
  row: ConversationState | null,
  availability: (backend: AgentBackendId) => CaptureAvailability,
): CheckpointHandoffEligibility {
  if (row === null)
    return {
      available: false,
      mode: null,
      reason: "conversation_not_found",
      policy: CHECKPOINT_CAPTURE_POLICY,
    };
  const capture = availability(row.agentBackend);
  const continuity = row.backendRef !== null;
  return {
    available: capture.available && continuity,
    mode: capture.mode,
    reason: !capture.available
      ? capture.reason
      : continuity
        ? null
        : "continuity_unavailable",
    policy: CHECKPOINT_CAPTURE_POLICY,
  };
}

export function createCoreCheckpoints(
  deps: CoreCheckpointDeps,
): CoreCheckpoints {
  const { log } = deps;
  const owned = new Map<string, OwnedBuild>();
  /** Captures of this process whose cleanup or audit waits for reconciliation, by conversation. */
  const heldCaptures = new Map<string, RetainedCapture>();
  const handoffEligibility = (row: ConversationState | null) =>
    captureEligibility(row, deps.captureAvailability);
  /**
   * The active phase each conversation's checkpoint slot last read as, for
   * the synchronous queue question; every durable read here refreshes it.
   */
  const slots = new Map<string, CheckpointPhase>();

  function remember(
    conversationId: string,
    phase: CheckpointPhase | null,
  ): void {
    if (phase === null) slots.delete(conversationId);
    else slots.set(conversationId, phase);
  }

  function storeIdentityOf(
    enrollment: InteractiveEnrollmentRecord,
  ): StoreIdentity {
    return {
      projectPath: enrollment.projectPath,
      sessionName: enrollment.sessionName,
      conversationId: enrollment.conversationId,
    };
  }

  async function repairQueue(identity: StoreIdentity): Promise<number> {
    return repairQueuedAcceptanceFromCheckpoint(identity, {
      repo: deps.repo(),
      readQueue: async (target) =>
        (await deps.readConversation(target))?.pendingQueue ?? null,
      confirmDelivery: (input) => deps.confirmQueuedDelivery(input),
      appendUserEntryOnce: (conversationId, entry) =>
        deps.appendUserEntryOnce(conversationId, entry),
      now: deps.now,
      log,
    });
  }

  /**
   * An applied checkpoint whose accepted continuation is gone: the row holds
   * no provider reference, no operation is active and the acceptance still
   * stands. The accepted operation is held for an explicit recovery built from
   * the recorded history since; returns it, or null when nothing was lost.
   */
  async function settleLostContinuation(
    key: CheckpointScopeKey,
    state: CheckpointAdmissionState,
    liveRef: string | null,
  ): Promise<CheckpointOperation | null> {
    if (
      state.active !== null ||
      state.latestAccepted === null ||
      liveRef !== null
    )
      return null;
    const accepted = state.latestAccepted;
    const repo = deps.repo();
    const held = await repo.recordOutcome({
      key,
      operationId: accepted.operationId,
      expectedPhase: "applied",
      phase: "needs_reconciliation",
      failure: {
        code: "continuation_lost",
        message:
          "the accepted provider continuation is no longer usable; run compact-context --recover with this operation id to build a fresh checkpoint from the recorded history",
      },
      at: deps.now(),
    });
    const operation = held.ok
      ? held.value
      : await repo.getOperation(key, accepted.operationId);
    if (operation === null || operation.phase !== "needs_reconciliation") {
      log.warn("checkpoint.continuation_loss_unrecorded", {
        ...checkpointKeyLogFields(key),
        operationId: accepted.operationId,
        refusal: held.ok ? null : held.refusal.code,
        phase: operation?.phase ?? null,
      });
      return null;
    }
    log.error("checkpoint.continuation_lost", {
      ...checkpointKeyLogFields(key),
      operationId: operation.id,
      ordinal: operation.ordinal,
      acceptedAttemptId: accepted.acceptance.attemptId,
    });
    return operation;
  }

  /**
   * What admission evaluates, over the row and the core. `self` is the
   * caller's own build, whose lease is not activity; `settle` lets a start
   * record a lost continuation and repair queued receipts first, which a
   * read-only check never does.
   */
  async function observe(
    identity: StoreIdentity,
    key: CheckpointScopeKey,
    request: { requestId: string | null; recover: string | null },
    options: { self?: OwnedBuild; settle: boolean },
  ): Promise<{
    observation: CheckpointAdmissionObservation;
    row: ConversationState | null;
  }> {
    const { conversationId } = identity;
    const repo = deps.repo();
    if (options.settle) await repairQueue(identity);
    const [row, initial, closeFailure] = await Promise.all([
      deps.readConversation(identity),
      repo.getStateForAdmission(key),
      deps.runtime.closeFailure(conversationId),
    ]);
    let state = initial;
    const liveRef = row?.backendRef?.ref ?? null;
    if (
      options.settle &&
      (await settleLostContinuation(key, state, liveRef)) !== null
    ) {
      state = await repo.getStateForAdmission(key);
    }
    remember(conversationId, activePhase(state.active));
    const build = owned.get(conversationId);
    // A lease held by this module's own build is the checkpoint, not a turn.
    const ours = options.self !== undefined || build !== undefined;
    const busy = deps.core.isBusy(conversationId);
    const turnActive = deps.core.runningAttempt(conversationId) !== null;
    return {
      row,
      observation: {
        requestId: request.requestId,
        recover: request.recover,
        conversation: observationFromRow(row),
        backendSupportsCheckpoint:
          row !== null && deps.backendSupportsCheckpoint(row.agentBackend),
        host: {
          idle: ours || !busy,
          turnActive,
          // A recovery retries the failed close of the runtime it supersedes; an ordinary checkpoint waits for it.
          busy:
            (closeFailure !== null && request.recover === null) ||
            (!ours && busy && !turnActive),
          trackedWork: false,
        },
        reservation:
          build === undefined || build === options.self
            ? null
            : { operationId: build.operationId },
        backgroundActivity: deps.background.activity(conversationId) !== null,
        queueReviewRequired:
          row?.pendingQueue.some(queuedMessageBlocksOrdinaryAdmission) ?? false,
        checkpoints: state,
        continuationLost:
          state.active === null &&
          state.latestAccepted !== null &&
          liveRef === null
            ? {
                operationId: state.latestAccepted.operationId,
                phase: state.latestAccepted.currentPhase,
              }
            : null,
      },
    };
  }

  function mutateCapture<T>(
    build: OwnedBuild,
    work: () => Promise<T>,
  ): Promise<T> {
    const result = build.captureMutation.then(work);
    build.captureMutation = result.catch(() => undefined);
    return result;
  }

  /** Stops a capture still pending or running, serialized with the build's own capture writes. */
  function stopCapture(
    build: OwnedBuild,
    key: CheckpointScopeKey,
    operationId: string,
    intent: "skip" | "cancel",
  ): Promise<CheckpointOperation | null> {
    return mutateCapture(build, async () => {
      const repo = deps.repo();
      const operation = await repo.getOperation(key, operationId);
      if (operation === null) return null;
      const handoff = operation.handoff;
      if (
        handoff === null ||
        operation.phase !== "building" ||
        (handoff.stage !== "pending" &&
          handoff.stage !== "running" &&
          handoff.stage !== "settling")
      ) {
        return operation;
      }
      const stopped = await repo.settleCapture({
        key,
        operationId,
        captureId: handoff.captureId,
        expectedSourceBasis: operation.sourceBasis,
        expectedStage: handoff.stage,
        settlement: { kind: "stop", intent },
        at: deps.now(),
      });
      if (!stopped.ok)
        throw new Error(`Capture stop refused: ${stopped.refusal.code}`);
      build.captureController.abort(intent);
      return stopped.value;
    });
  }

  function maintenanceHost(input: {
    identity: StoreIdentity;
    key: CheckpointScopeKey;
    target: ConversationTarget;
    worktreePath: string;
    row: ConversationState;
    build: OwnedBuild;
    lease: AbortSignal;
    recovers: boolean;
  }): CheckpointMaintenanceHost {
    const { conversationId } = input.identity;
    const { build } = input;
    const priorRef = input.row.backendRef;
    /** The row's own eligibility for this build, over the row as a fence or a capture reads it. */
    const durableRefusal = (
      conversation: ConversationState | null,
    ): CheckpointRefusalCode | null => {
      const refusal = evaluateCheckpointConversation(
        observationFromRow(conversation),
        conversation !== null &&
          deps.backendSupportsCheckpoint(conversation.agentBackend),
      )[0];
      if (refusal !== undefined) return refusal.code;
      // No core turn writes the row under the lease; a different reference came from elsewhere.
      return (conversation?.backendRef?.ref ?? null) === (priorRef?.ref ?? null)
        ? null
        : "conversation_busy";
    };
    return {
      key: input.key,
      target: input.target,
      projectPath: input.identity.projectPath,
      worktreePath: input.worktreePath,
      transcriptPath: input.row.transcriptPath,
      signal: build.controller.signal,
      captureSignal: build.captureController.signal,
      mutateCapture: (work) => mutateCapture(build, work),
      captureHandoff: (operation, captureInput, expected) =>
        captureCoreHandoff(
          {
            captureAvailability: deps.captureAvailability,
            appendCaptureEntryOnce: deps.appendCaptureEntryOnce,
            openForCapture: deps.runtime.openForCapture,
            release: deps.runtime.release,
            retryRelease: deps.runtime.retryRelease,
            now: deps.now,
            log,
          },
          {
            request: {
              identity: input.identity,
              target: input.target,
              worktreePath: input.worktreePath,
            },
            priorRef,
            settled: (captured) =>
              !input.lease.aborted &&
              deps.background.epoch(conversationId) ===
                captured.backgroundEpoch,
            async sourceRefusal(backend) {
              const row = await deps.readConversation(input.identity);
              const refusal = durableRefusal(row);
              if (refusal !== null) return refusal;
              if (row?.agentBackend !== backend) return "backend_changed";
              return deps.background.activity(conversationId) !== null
                ? "background_work"
                : null;
            },
            retain: (capture) => heldCaptures.set(conversationId, capture),
          },
          operation,
          captureInput,
          expected,
        ),
      settleReceipts: () => deps.settleTurnReceipts(conversationId),
      observe() {
        const reason: CheckpointRefusalCode | null = input.lease.aborted
          ? "conversation_busy"
          : deps.background.activity(conversationId) !== null
            ? "background_work"
            : null;
        return {
          settled: reason === null,
          reason,
          backendRef: priorRef?.ref ?? null,
          // No turn runs under the lease, and the core hosts no runtime between turns:
          // nothing can advance the conversation's activity while this build holds it.
          activityEpoch: 0,
          backgroundEpoch: deps.background.epoch(conversationId),
        };
      },
      observeDurable: durableRefusal,
      project(projection) {
        if (projection?.phase === "retiring") build.phase = "retiring";
        if (projection?.phase === "ready") build.phase = "publishing";
      },
      closeRuntime: () =>
        input.recovers
          ? deps.runtime.retryRelease(conversationId)
          : deps.runtime.release(conversationId),
      // The conversation and checkpoint rows are written by their repositories before they return.
      awaitDurable: async () => {},
      recordDurabilityFailure(error) {
        log.error("checkpoint.receipts_unsettled", {
          conversationId,
          ...checkpointErrorFields(error),
        });
      },
    };
  }

  async function reusedStart(
    key: CheckpointScopeKey,
    operation: CheckpointOperation,
    completion: Promise<CheckpointOperation | null>,
  ): Promise<ConversationCheckpointStart> {
    const receipt = await deps.repo().getReceipt(key, operation.id);
    if (receipt === null) throw new Error("Reused checkpoint has no receipt");
    return {
      kind: "reused",
      operation,
      receipt,
      completion: completion.then((settled) => settled ?? operation),
    };
  }

  /** The owned work after durable admission; never rejects. */
  async function runBuild(input: {
    conversationId: string;
    build: OwnedBuild;
    host: CheckpointMaintenanceHost;
    operation: CheckpointOperation;
    source: Awaited<ReturnType<typeof captureCheckpointSourceForHost>>;
    captured: ReturnType<CheckpointMaintenanceHost["observe"]>;
    fields: Record<string, unknown>;
  }): Promise<CheckpointOperation> {
    const { build, operation, conversationId } = input;
    try {
      const result = await runCheckpointMaintenance(
        {
          operation,
          source: input.source,
          captured: input.captured,
          host: input.host,
        },
        {
          repo: deps.repo(),
          readEntries: deps.readEntries,
          findArtifact: deps.findArtifact,
          resolveConfig: deps.resolveConfig,
          executeTaskRun: deps.taskLane(),
          generate: deps.generate,
          now: deps.now,
          log,
        },
      );
      // A held outcome needs no in-process hold: the core's refusal reads it from the row.
      remember(
        conversationId,
        result.released ? activePhase(result.operation) : result.hold.phase,
      );
      build.settle(result.operation);
      return result.operation;
    } catch (error) {
      // The outcome itself could not be written. The durable phase still says what the
      // build was doing, and a reconcile settles it from there.
      build.undurable = true;
      log.error("checkpoint.outcome_persist_failed", {
        ...input.fields,
        operationId: operation.id,
        ...checkpointErrorFields(error),
      });
      build.settle(operation);
      return operation;
    }
  }

  async function start(
    input: Parameters<CoreConversationCheckpoints["start"]>[0],
  ): Promise<ConversationCheckpointStart> {
    const identity = conversationStoreIdentity(input.address);
    const { conversationId } = identity;
    const key = checkpointScopeKeyForStoreIdentity(identity);
    const recover = input.recover ?? null;
    const fields = {
      ...conversationTargetLogFields(input.address.target),
      requestId: input.requestId,
    };
    const repo = deps.repo();
    const refuse = (
      refusal: CheckpointRefusal,
      codes?: CheckpointRefusalCode[],
    ) => {
      log.info("checkpoint.admission_refused", {
        ...fields,
        code: refusal.code,
        ...(codes ? { codes } : {}),
      });
      return { kind: "refused" as const, refusal };
    };

    const existing = owned.get(conversationId);
    if (existing !== undefined) {
      if (existing.requestId === input.requestId) {
        const operation = await existing.admitted;
        if (operation !== null)
          return reusedStart(key, operation, existing.work);
      }
      return refuse(
        checkpointRefusal(
          "checkpoint_pending",
          "a checkpoint already owns this conversation",
          existing.operationId === null
            ? null
            : await repo.getOperation(key, existing.operationId),
        ),
      );
    }

    const lease = deps.core.hold(conversationId, {
      kind: "checkpoint",
      requestId: input.requestId,
    });
    if (lease.kind === "busy") {
      // Still evaluated, so the refusal names what is running rather than only that something is.
      const { observation } = await observe(
        identity,
        key,
        { requestId: input.requestId, recover },
        { settle: false },
      );
      const verdict = evaluateCheckpointAdmission(observation);
      return verdict.eligible
        ? refuse(checkpointRefusal("conversation_busy", lease.reason))
        : refuse(
            verdict.refusals[0],
            verdict.refusals.map((entry) => entry.code),
          );
    }
    const build = createBuild(input.requestId);
    owned.set(conversationId, build);
    // The server stopping or the conversation going away cancels a build not yet frozen.
    const onLeaseAbort = () => build.controller.abort(lease.signal.reason);
    lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
    const finish = () => {
      lease.signal.removeEventListener("abort", onLeaseAbort);
      if (owned.get(conversationId) === build) owned.delete(conversationId);
      lease.release();
    };
    let admitted = false;
    try {
      const { observation, row } = await observe(
        identity,
        key,
        { requestId: input.requestId, recover },
        { self: build, settle: true },
      );
      const verdict = evaluateCheckpointAdmission(observation);
      if (!verdict.eligible)
        return refuse(
          verdict.refusals[0],
          verdict.refusals.map((entry) => entry.code),
        );
      if (verdict.reuse !== null)
        return reusedStart(key, verdict.reuse, Promise.resolve(verdict.reuse));
      if (row === null)
        return refuse(
          checkpointRefusal(
            "conversation_not_found",
            "the conversation does not exist",
          ),
        );

      const host = maintenanceHost({
        identity,
        key,
        target: input.address.target,
        worktreePath: await deps.worktreeOf(identity),
        row,
        build,
        lease: lease.signal,
        recovers: recover !== null,
      });
      let source: Awaited<ReturnType<typeof captureCheckpointSourceForHost>>;
      try {
        source = await captureCheckpointSourceForHost(host, {
          readEntries: deps.readEntries,
        });
      } catch (error) {
        return refuse(
          checkpointRefusal(
            "conversation_busy",
            `the conversation's receipts did not settle: ${getErrorMessage(error)}`,
          ),
        );
      }
      const captured = host.observe();
      if (!captured.settled) {
        const code = captured.reason ?? "conversation_busy";
        return refuse(
          checkpointRefusal(code, `the conversation is not settled: ${code}`),
        );
      }
      const requestedAt = deps.now();
      const handoff =
        input.handoff === undefined
          ? undefined
          : pendingCheckpointCapture({
              requestId: input.requestId,
              request: input.handoff,
              backend: row.agentBackend,
              modelSelection: await deps.resolveCaptureModel({
                agentBackend: row.agentBackend,
                transcriptPath: row.transcriptPath,
                projectPath: identity.projectPath,
              }),
              sourceBasis: source.basis,
              at: requestedAt,
            });
      const admission = {
        ...(handoff === undefined ? {} : { handoff }),
        key,
        requestId: input.requestId,
        sourceBasis: source.basis,
        priorBackendRef: captured.backendRef,
        requestedAt,
      };
      const result =
        recover === null
          ? await repo.admitOperation(admission)
          : await repo.admitRecovery({
              ...admission,
              recoversOperationId: recover,
            });
      if (!result.ok) return refuse(result.refusal);
      const { operation } = result.value;
      if (result.value.outcome === "reused")
        return reusedStart(key, operation, Promise.resolve(operation));

      admitted = true;
      build.operationId = operation.id;
      build.phase = "building";
      build.admit(operation);
      remember(conversationId, operation.phase);
      log.info(
        recover === null
          ? "checkpoint.admitted"
          : "checkpoint.recovery_admitted",
        {
          ...fields,
          operationId: operation.id,
          ordinal: operation.ordinal,
          capturedThroughSeq: operation.sourceBasis.capturedThroughSeq,
          ...(recover === null ? {} : { recoversOperationId: recover }),
        },
      );
      const completion = runBuild({
        conversationId,
        build,
        host,
        operation,
        source,
        captured,
        fields,
      }).finally(finish);
      const receipt = await repo.getReceipt(key, operation.id);
      if (receipt === null)
        throw new Error("Admitted checkpoint has no receipt");
      return { kind: "admitted", operation, receipt, completion };
    } finally {
      if (!admitted) {
        build.settle(null);
        finish();
      }
    }
  }

  async function reconcile(
    input: Parameters<CoreConversationCheckpoints["reconcile"]>[0],
  ): Promise<ConversationCheckpointReconcile> {
    const identity = conversationStoreIdentity(input.address);
    const { conversationId } = identity;
    const key = checkpointScopeKeyForStoreIdentity(identity);
    const repo = deps.repo();
    const fields = {
      ...conversationTargetLogFields(input.address.target),
      operationId: input.operationId,
    };
    const refuse = (
      code: CheckpointRefusalCode,
      reason: string,
      operation: CheckpointOperation | null = null,
    ) => {
      log.info("checkpoint.reconcile.refused", { ...fields, code });
      return refused(code, reason, operation);
    };

    const build = owned.get(conversationId);
    if (build !== undefined) {
      const named = await repo.getOperation(key, input.operationId);
      if (named === null)
        return refuse(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        );
      return build.operationId === input.operationId
        ? refuse(
            "conversation_busy",
            "the operation is still running; wait for its outcome",
            named,
          )
        : refuse(
            "checkpoint_pending",
            "another checkpoint operation owns this conversation",
            build.operationId === null
              ? null
              : await repo.getOperation(key, build.operationId),
          );
    }
    // The repair closes the runtime and moves the operation: nothing else may run meanwhile.
    const lease = deps.core.hold(conversationId, {
      kind: "checkpoint",
      requestId: `reconcile:${input.operationId}`,
    });
    if (lease.kind === "busy") {
      return refuse(
        "conversation_busy",
        lease.reason,
        await repo.getOperation(key, input.operationId),
      );
    }
    let operation: CheckpointOperation | null = null;
    try {
      // A delivery's acceptance receipt the last turn could not write is settled first.
      await deps.settleTurnReceipts(conversationId);
      operation = await repo.getOperation(key, input.operationId);
      if (operation === null)
        return refuse(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        );
      const row = await deps.readConversation(identity);
      const plan = planCheckpointReconcile(operation, {
        queueReviewRequired:
          row?.pendingQueue.some(queuedMessageBlocksOrdinaryAdmission) ?? false,
        captureExecutionStopped: input.captureExecutionStopped === true,
      });
      log.info("checkpoint.reconcile.started", {
        ...fields,
        phase: operation.phase,
        lastStablePhase: operation.lastStablePhase,
        plan: plan.kind,
      });
      const outcome = await perform(plan, operation);
      remember(
        conversationId,
        activePhase((await repo.getStateForAdmission(key)).active),
      );
      return outcome;
    } catch (error) {
      log.error("checkpoint.reconcile.failed", {
        ...fields,
        ...checkpointErrorFields(error),
      });
      const known =
        (await repo.getOperation(key, input.operationId).catch(() => null)) ??
        operation;
      if (known === null) throw error;
      return blocked(
        known,
        "reconciliation_failed",
        "the repair did not complete; retry checkpoint reconcile",
      );
    } finally {
      lease.release();
    }

    function blocked(
      held: CheckpointOperation,
      code: CheckpointRefusalCode,
      reason: string,
    ): ConversationCheckpointReconcile {
      log.warn("checkpoint.reconcile.blocked", {
        ...fields,
        code,
        phase: held.phase,
        lastStablePhase: held.lastStablePhase,
        attemptId: held.delivery?.attemptId ?? null,
      });
      return {
        kind: "blocked",
        operation: held,
        refusal: checkpointRefusal(code, reason, held),
      };
    }

    function repaired(
      settled: CheckpointOperation,
    ): ConversationCheckpointReconcile {
      log.info("checkpoint.reconcile.repaired", {
        ...fields,
        phase: settled.phase,
      });
      return { kind: "repaired", operation: settled };
    }

    /** A recovery build that ended without a checkpoint handed the conversation back to the operation it superseded. */
    async function settledBuild(
      settled: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> {
      if (settled.phase === "needs_reconciliation") {
        return blocked(
          settled,
          "recovery_required",
          "this operation needs explicit recovery; run compact-context --recover with this operation id",
        );
      }
      if (
        (settled.phase === "failed" || settled.phase === "cancelled") &&
        settled.recoversOperationId !== null
      ) {
        const prior = await repo.getOperation(key, settled.recoversOperationId);
        const reason = `recovery ${settled.id} ended ${settled.phase}; operation ${settled.recoversOperationId} still needs explicit recovery`;
        return {
          kind: "blocked",
          operation: settled,
          refusal:
            prior === null
              ? {
                  code: "recovery_required",
                  reason,
                  operationId: settled.recoversOperationId,
                  phase: "needs_reconciliation",
                }
              : checkpointRefusal("recovery_required", reason, prior),
        };
      }
      return repaired(settled);
    }

    async function perform(
      plan: CheckpointReconcilePlan,
      current: CheckpointOperation,
    ): Promise<ConversationCheckpointReconcile> {
      switch (plan.kind) {
        case "unchanged":
          return { kind: "unchanged", operation: current };
        case "refused":
          return refuse(plan.code, plan.reason, current);
        case "blocked":
          return blocked(current, plan.code, plan.reason);
        case "apply_restart_rules": {
          // A build no process owns is exactly what the restart rules settle.
          const hydration = await hydrateCheckpointAuthority(key, {
            repo,
            now: deps.now,
            log,
          });
          const settled = await repo.getOperation(key, current.id);
          log.info("checkpoint.restart.applied_on_demand", {
            ...fields,
            outcome: hydration.outcome.kind,
          });
          return settledBuild(settled ?? current);
        }
        case "finish_retirement": {
          try {
            await deps.runtime.retryRelease(conversationId);
          } catch (error) {
            log.error("checkpoint.reconcile.close_failed", {
              ...fields,
              ...checkpointErrorFields(error),
            });
            return blocked(
              current,
              "reconciliation_failed",
              "the retired runtime still did not close; retry checkpoint reconcile",
            );
          }
          const committed = await repo.commitReady({
            key,
            operationId: current.id,
            at: deps.now(),
          });
          if (committed.ok) return repaired(committed.value);
          const durable = (await repo.getOperation(key, current.id)) ?? current;
          return durable.phase === "ready"
            ? repaired(durable)
            : blocked(
                durable,
                "reconciliation_failed",
                `readiness was refused: ${committed.refusal.code}`,
              );
        }
        case "declare_ready": {
          const declared = await repo.recordOutcome({
            key,
            operationId: current.id,
            expectedPhase: "needs_reconciliation",
            phase: "ready",
            at: deps.now(),
          });
          return declared.ok
            ? repaired(declared.value)
            : blocked(
                current,
                "reconciliation_failed",
                declared.refusal.reason,
              );
        }
        case "observe_capture_cleanup": {
          const handoff = current.handoff;
          if (handoff === null)
            return blocked(
              current,
              "recovery_required",
              "this operation needs explicit recovery",
            );
          // Only the capture's own owner can observe its stop: an empty host after a restart
          // shows that ownership was lost, not that the capture's processes ended.
          const held = heldCaptures.get(conversationId);
          let observedStop = false;
          try {
            if (held?.captureId === handoff.captureId) {
              observedStop = await held.reconcile();
              if (observedStop) heldCaptures.delete(conversationId);
            } else {
              await deps.runtime.retryRelease(conversationId);
            }
          } catch (error) {
            log.error("checkpoint.reconcile.close_failed", {
              ...fields,
              ...checkpointErrorFields(error),
            });
            return blocked(
              current,
              "reconciliation_failed",
              "the capture's runtime did not close or its audit was not written; retry checkpoint reconcile",
            );
          }
          const at = deps.now();
          const settled = observedStop
            ? await repo.recordOutcome({
                key,
                operationId: current.id,
                expectedPhase: "needs_reconciliation",
                phase: "needs_reconciliation",
                captureCleanupObserved: { captureId: handoff.captureId },
                at,
              })
            : input.captureExecutionStopped === true
              ? await repo.recordOutcome({
                  key,
                  operationId: current.id,
                  expectedPhase: "needs_reconciliation",
                  phase: "needs_reconciliation",
                  captureExecutionStopAttestation: {
                    at,
                    source: input.source ?? "api",
                  },
                  at,
                })
              : null;
          if (settled?.ok === true) heldCaptures.delete(conversationId);
          if (settled === null)
            return blocked(
              current,
              "recovery_required",
              "capture execution remains uncertain; inspect and stop prior backend work, then reconcile with captureExecutionStopped acknowledgement",
            );
          if (!settled.ok)
            return blocked(
              current,
              "reconciliation_failed",
              settled.refusal.reason,
            );
          return blocked(
            settled.value,
            "recovery_required",
            "capture cleanup is settled; run compact-context --recover with this operation id for a fresh baseline checkpoint",
          );
        }
      }
    }
  }

  return {
    async check(address, options) {
      const identity = conversationStoreIdentity(address);
      const key = checkpointScopeKeyForStoreIdentity(identity);
      const { observation, row } = await observe(
        identity,
        key,
        { requestId: null, recover: options.recover },
        { settle: false },
      );
      const verdict = evaluateCheckpointAdmission(observation);
      const active = observation.checkpoints.active;
      return {
        handoff: handoffEligibility(row),
        eligible: verdict.eligible,
        refusals: verdict.eligible ? [] : verdict.refusals,
        active:
          active === null ? null : await deps.repo().getReceipt(key, active.id),
        // The core is the host of every conversation it runs.
        hosted: true,
      };
    },

    start,

    async cancel({ address, operationId }) {
      const identity = conversationStoreIdentity(address);
      const key = checkpointScopeKeyForStoreIdentity(identity);
      const repo = deps.repo();
      const build = owned.get(identity.conversationId);
      if (build !== undefined && build.operationId === operationId) {
        if (build.phase === "building") {
          build.controller.abort("cancelled");
          await stopCapture(build, key, operationId, "cancel");
        }
        // After the freeze the transition finishes forward; the caller learns which way it went.
        const operation =
          (await build.work) ?? (await repo.getOperation(key, operationId));
        if (operation === null)
          return refused(
            "checkpoint_not_found",
            "the operation no longer exists",
          );
        if (build.undurable) {
          return refused(
            "recovery_required",
            "the operation's outcome could not be made durable; run checkpoint reconcile",
            (await repo.getOperation(key, operationId)) ?? operation,
          );
        }
        return operation.phase === "cancelled"
          ? { kind: "cancelled", operation }
          : { kind: "completed", operation };
      }
      const operation = await repo.getOperation(key, operationId);
      if (operation === null)
        return refused(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        );
      if (operation.phase === "cancelled")
        return { kind: "cancelled", operation };
      if (operation.phase === "building" || operation.phase === "retiring") {
        return refused(
          "not_owned",
          "this operation is not owned by the running server; run checkpoint reconcile",
          operation,
        );
      }
      return refused(
        "not_cancellable",
        operation.phase === "needs_reconciliation"
          ? "this operation needs reconciliation or explicit recovery"
          : `a ${operation.phase} operation cannot be cancelled`,
        operation,
      );
    },

    async skipHandoff({ address, operationId }) {
      const identity = conversationStoreIdentity(address);
      const key = checkpointScopeKeyForStoreIdentity(identity);
      const build = owned.get(identity.conversationId);
      const building =
        build !== undefined &&
        build.operationId === operationId &&
        build.phase === "building";
      const operation = building
        ? await stopCapture(build, key, operationId, "skip")
        : await deps.repo().getOperation(key, operationId);
      if (operation === null)
        return refused(
          "checkpoint_not_found",
          "no such checkpoint operation in this scope",
        );
      const stage = operation.handoff?.stage;
      if (stage === "settling" && building)
        return { kind: "stopping", operation };
      if (stage === "pending" || stage === "running" || stage === "settling") {
        return refused(
          "not_owned",
          "capture requires reconciliation",
          operation,
        );
      }
      return { kind: "handoff_already_settled", operation };
    },

    reconcile,

    acceptsQueuedInput(conversationId) {
      return owned.has(conversationId) || slots.has(conversationId);
    },

    async refusal(conversationId, turn, options) {
      const enrollment = deps.enrollment(conversationId);
      if (enrollment === null) return null;
      const identity = storeIdentityOf(enrollment);
      const key = checkpointScopeKeyForStoreIdentity(identity);
      const repo = deps.repo();
      // A turn still running owns its receipts and its continuity, so they are repaired only
      // between turns (the caller may know it holds the conversation between two): a task asked
      // for meanwhile reads the slot as it stands.
      const betweenTurns =
        options?.betweenTurns ?? !deps.core.isBusy(conversationId);
      // A delivery's receipt an earlier turn could not write lands before the slot is read.
      if (betweenTurns) await deps.settleTurnReceipts(conversationId);
      let state = await repo.getStateForAdmission(key);
      if (
        betweenTurns &&
        state.active === null &&
        state.latestAccepted !== null
      ) {
        await repairQueue(identity);
        const row = await deps.readConversation(identity);
        const lost = await settleLostContinuation(
          key,
          state,
          row?.backendRef?.ref ?? null,
        );
        if (lost !== null) {
          remember(conversationId, lost.phase);
          return {
            code: "busy",
            message: `The applied checkpoint continuation was lost; run compact-context --recover ${lost.id}`,
          };
        }
        state = await repo.getStateForAdmission(key);
      }
      const active = state.active;
      remember(conversationId, activePhase(active));
      if (active === null) return null;
      if (active.phase === "ready") {
        // Only the next ordinary turn (a message, or a delivery from the queue) delivers it; a task,
        // a command or a collaboration's claim would run without it.
        return turn === "message" || turn === "delivery"
          ? null
          : {
              code: "busy",
              message:
                "A ready checkpoint is delivered by the next ordinary conversation turn",
            };
      }
      log.info("checkpoint.admission_held", {
        ...checkpointKeyLogFields(key),
        operationId: active.id,
        phase: active.phase,
        turn,
      });
      return {
        code: "busy",
        message: "Conversation checkpoint maintenance is in progress",
      };
    },

    async recover(enrollment) {
      const identity = storeIdentityOf(enrollment);
      const key = checkpointScopeKeyForStoreIdentity(identity);
      try {
        const hydration = await hydrateCheckpointAuthority(key, {
          repo: deps.repo(),
          now: deps.now,
          log,
        });
        remember(
          enrollment.conversationId,
          activePhase(hydration.state.active),
        );
        await repairQueue(identity);
      } catch (error) {
        // Unsettled, the operation keeps holding the conversation: its refusal reads it from the row.
        log.error("checkpoint.restart.hydration_failed", {
          ...checkpointKeyLogFields(key),
          ...checkpointErrorFields(error),
        });
      }
    },
  };
}

/** What a core conversation's next message continues from, and the receipt a delivered seed owes. */
export interface CoreContinuation {
  continuation: ContinuationSeed;
  /** The ready checkpoint's seed and its delivery receipt, exactly when `continuation` is a checkpoint. */
  seed: PreparedCheckpointSeed | null;
}

/**
 * What the conversation's next message continues from (see
 * `resolveContinuationSeed`): a ready checkpoint's frozen seed in a fresh
 * runtime, framed as its source's history when the conversation is that
 * checkpoint's fork; a fork's synthetic history; or ordinary resume. Any
 * other active phase fails the turn: the core's holds admit no message under
 * one.
 */
export function createCheckpointContinuation(deps: {
  repo(): ConversationCheckpointsRepo;
  transcript: ForkSeedDeps;
  /** Closes the runtime a delivery that never sent created, so nothing resumes it carrying the seed. */
  release(conversationId: string): Promise<void>;
  now(): string;
  log: Logger;
}): (input: {
  identity: ConversationIdentity;
  /** The backend the message runs on. */
  backend: AgentBackendId;
  row: {
    backendRef: unknown;
    transcriptPath: string | null;
    forkedFrom: ForkedFrom;
    checkpointFork: CheckpointForkOrigin | undefined;
  };
}) => Promise<CoreContinuation> {
  return async ({ identity, backend, row }) => {
    const key = checkpointScopeKeyForStoreIdentity({
      projectPath: identity.projectPath,
      sessionName: identity.storeSessionName,
      conversationId: identity.conversationId,
    });
    const repo = deps.repo();
    const { active } = await repo.getStateForAdmission(key);
    const continuation = await resolveContinuationSeed(
      {
        readPayload: (scope, operationId) =>
          repo.getPayload(scope, operationId),
        readContinuity: async (scope) => ({
          accepted:
            (await repo.getStateForAdmission(scope)).latestAccepted !== null,
        }),
        transcript: deps.transcript,
        log: deps.log,
      },
      {
        key,
        checkpoint: checkpointActorProjection(active),
        sessionName: identity.storeSessionName,
        agentBackend: backend,
        backendRef: row.backendRef,
        forkedFrom: row.forkedFrom,
        transcriptPath: row.transcriptPath,
      },
    );
    if (continuation.kind !== "checkpoint") return { continuation, seed: null };
    // The fork's admission certified its backend for this seed when its first message was submitted.
    const forkOrigin =
      row.checkpointFork?.operationId === continuation.operationId
        ? row.checkpointFork
        : undefined;
    return {
      continuation,
      seed: prepareCheckpointSeed(
        {
          checkpoint: { repo: async () => repo, now: deps.now },
          log: deps.log,
        },
        {
          key,
          operationId: continuation.operationId,
          payload: continuation.payload,
          ...(forkOrigin !== undefined ? { forkOrigin } : {}),
          closeAttemptedRuntime: () => deps.release(identity.conversationId),
        },
      ),
    };
  };
}
