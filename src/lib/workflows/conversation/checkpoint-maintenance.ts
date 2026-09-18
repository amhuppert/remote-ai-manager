/**
 * The owned asynchronous work of one checkpoint operation: capture, build,
 * recheck, freeze, retire, publish.
 *
 * Not a scheduler. The conversation manager reserves the host, admits the
 * operation and runs this exactly once per admitted operation; every host
 * effect — the actor's checkpoint projection, the runtime close, the row and
 * snapshot barrier — goes back through the manager-supplied host, so this
 * module never reaches an actor, a runtime handle or a queue itself.
 *
 * The order is the design's: durable admission → immutable payload plus
 * `retiring` → awaited runtime close → actor projection and reference clear →
 * readiness commit → row and snapshot receipts → release. Optional capture
 * settles its execution and audit before generation. A failed build preserves
 * recorded history and releases only resumable continuity; uncertain cleanup,
 * lost continuity and failures after freeze stay owned for reconciliation.
 *
 * Private to the manager: `boundaries.arch.test.ts` refuses imports of this
 * module from outside `lib/workflows/conversation/`, so the HTTP and CLI
 * surfaces reach a checkpoint only through `checkConversationCheckpoint`,
 * `startConversationCheckpoint` and `cancelConversationCheckpoint`. The work
 * ends at readiness: delivering the frozen seed to a fresh runtime, and
 * repairing an operation a restart interrupted, are separate owners over the
 * same repository.
 */

import { isDeepStrictEqual } from "node:util";
import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import {
  buildHandoffPrompt,
  validateHandoffCandidate,
} from "@/lib/conversation-checkpoints/handoff";
import type { CaptureHandoffInput } from "@/lib/agent-backends/conversation";
import type { CaptureHandoffResult } from "@/lib/agent-backends/schemas";

import type { CompactionConfig } from "@/lib/config/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { CheckpointRefusalCode } from "@/lib/conversation-checkpoints/admission";
import type {
  ConversationCheckpointsRepo,
  RecordCheckpointOutcomeInput,
} from "@/lib/conversation-checkpoints/repo";
import {
  generateCheckpoint,
  type CheckpointGenerationTelemetry,
} from "@/lib/conversation-checkpoints/generation";
import {
  captureCheckpointSource,
  checkpointSourceBasisMatches,
  type CapturedCheckpointSource,
} from "@/lib/conversation-checkpoints/source";
import {
  EMPTY_CHECKPOINT_USAGE,
  type CheckpointActorProjection,
  type CheckpointFailure,
  type CheckpointOperation,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import {
  conversationTargetLogFields,
  conversationTargetStoreSessionName,
  targetFromStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { Logger } from "@/lib/logging";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";

import type { ExecuteWorkflowTaskRunInput } from "./execute-workflow-task-run";
import type { TaskRunResult } from "./turn-result";

export interface CheckpointMaintenanceInfrastructure {
  repo: ConversationCheckpointsRepo;
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
  findArtifact(conversationId: string): Promise<ContextArtifactRow | null>;
  resolveConfig(projectPath: string): Promise<CompactionConfig>;
  /** The synthetic generation lane; routed through the same manager as every task run. */
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  generate: typeof generateCheckpoint;
  now(): string;
  log: Logger;
}

export interface CheckpointHostObservation {
  /** The host is idle with no admitted, running, external, tracked or background work. */
  settled: boolean;
  reason: CheckpointRefusalCode | null;
  /** The live opaque provider reference, or null when the host holds none. */
  backendRef: string | null;
  /** `ManagedConversationRuntime.activityEpoch` at this observation. */
  activityEpoch: number;
  /**
   * The background-activity channel's epoch at this observation: work that
   * appeared and finished during the build leaves no live entry, only a
   * moved epoch.
   */
  backgroundEpoch: number;
}

/**
 * What the manager lends the maintenance for one operation. Every method is
 * the manager's own effect on its host; nothing here exposes the actor.
 */
export interface CheckpointMaintenanceHost {
  readonly key: CheckpointScopeKey;
  readonly target: ConversationTarget;
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly transcriptPath: string | null;
  /** Cancels a build that has not frozen; retirement ignores it. */
  readonly signal: AbortSignal;
  readonly captureSignal: AbortSignal;
  mutateCapture<T>(work: () => Promise<T>): Promise<T>;
  /** Let owned receipts, queue drains, external frames and tracked work land before a read. */
  settleReceipts(): Promise<void>;
  captureHandoff(
    operation: CheckpointOperation,
    input: Omit<CaptureHandoffInput, "mode" | "onTranscript">,
    expected: Pick<
      CheckpointHostObservation,
      "activityEpoch" | "backgroundEpoch"
    >,
  ): Promise<
    CaptureHandoffResult & { auditEntryIds: string[]; sourceChanged: boolean }
  >;
  /** Synchronous: safe to call inside the repository's freeze fence. */
  observe(): CheckpointHostObservation;
  /**
   * The durable row's own eligibility — archival, ownership, backend, debug,
   * question — over the row as the freeze transaction sees it. Synchronous
   * so it can run inside the repository's fence.
   */
  observeDurable(
    conversation: ConversationState | null,
  ): CheckpointRefusalCode | null;
  /** Update the actor's projection; `ready` also retires its continuation. */
  project(projection: CheckpointActorProjection | null): void;
  closeRuntime(): Promise<void>;
  /** The row and snapshot receipts for the actor's latest projection. */
  awaitDurable(): Promise<void>;
  recordDurabilityFailure(error: unknown): void;
}

export type CheckpointMaintenanceResult =
  /** Ordinary admission may resume. */
  | { operation: CheckpointOperation; released: true }
  /**
   * The host stays owned under `hold`: either this operation is
   * `needs_reconciliation` and only an explicit reconcile or recovery may
   * release it, or this was a recovery build that failed or was cancelled and
   * the gate it superseded is restored — `hold` then names that prior
   * operation, and the queue is not released into uncertain continuity.
   */
  | {
      operation: CheckpointOperation;
      released: false;
      hold: CheckpointActorProjection;
    };

export async function captureCheckpointSourceForHost(
  host: Pick<
    CheckpointMaintenanceHost,
    "target" | "transcriptPath" | "settleReceipts"
  >,
  infra: Pick<CheckpointMaintenanceInfrastructure, "readEntries">,
): Promise<CapturedCheckpointSource> {
  await host.settleReceipts();
  return captureCheckpointSource(
    {
      conversationId: host.target.conversationId,
      transcriptPath: host.transcriptPath,
    },
    { readEntries: infra.readEntries },
  );
}

/**
 * The hold a recovery build hands the host back to when it ends without a
 * checkpoint: the operation it superseded, whose gate the repository restores
 * in the same outcome write. Null for an ordinary checkpoint.
 */
export function restoredGateFor(
  operation: Pick<CheckpointOperation, "recoversOperationId">,
): CheckpointActorProjection | null {
  return operation.recoversOperationId === null
    ? null
    : {
        operationId: operation.recoversOperationId,
        phase: "needs_reconciliation",
      };
}

const NO_TELEMETRY: CheckpointGenerationTelemetry = {
  generationPassCount: 0,
  usage: EMPTY_CHECKPOINT_USAGE,
};

export async function runCheckpointMaintenance(
  input: {
    operation: CheckpointOperation;
    source: CapturedCheckpointSource;
    /** The host as observed when `source` was captured; the fence compares against it. */
    captured: Pick<
      CheckpointHostObservation,
      "activityEpoch" | "backgroundEpoch"
    >;
    host: CheckpointMaintenanceHost;
  },
  infra: CheckpointMaintenanceInfrastructure,
): Promise<CheckpointMaintenanceResult> {
  const { host } = input;
  let source = input.source;
  let operation = input.operation;
  let captured = input.captured;
  let continuationUnusable = false;
  const { key } = host;
  const operationId = input.operation.id;
  const fields = {
    ...conversationTargetLogFields(host.target),
    operationId,
    ordinal: input.operation.ordinal,
  };
  const log = infra.log;

  /**
   * A failure or cancellation before the freeze preserves the recorded
   * archive. Release requires a durable outcome and usable source continuity;
   * a capture that lost its prior continuation must retain the recovery hold.
   */
  async function settleBuild(
    phase: "failed" | "cancelled",
    failure: CheckpointFailure,
    telemetry: CheckpointGenerationTelemetry,
  ): Promise<CheckpointMaintenanceResult> {
    const lostContinuationHold =
      continuationUnusable && input.operation.recoversOperationId === null;
    const outcome = await infra.repo.recordOutcome({
      key,
      operationId,
      expectedPhase: "building",
      phase: lostContinuationHold ? "needs_reconciliation" : phase,
      failure: lostContinuationHold
        ? {
            code:
              phase === "cancelled" ? "cancelled" : "capture_continuation_lost",
            message: `The captured continuation is unavailable after checkpoint failure (${failure.code})`,
          }
        : failure,
      usage: telemetry.usage,
      generationPassCount: telemetry.generationPassCount,
      at: infra.now(),
    });
    // A recovery build that ends without a checkpoint hands the host back to
    // the operation it superseded: the repository restored that gate in the
    // same write, and the projection follows it so nothing drains.
    const restoredGate = restoredGateFor(input.operation);
    const effectiveGate = lostContinuationHold
      ? { operationId, phase: "needs_reconciliation" as const }
      : restoredGate;
    host.project(effectiveGate);
    if (outcome.ok) {
      log.info(`checkpoint.build.${phase}`, {
        ...fields,
        code: failure.code,
        generationPassCount: telemetry.generationPassCount,
        ...(restoredGate === null
          ? {}
          : { restoredOperationId: restoredGate.operationId }),
      });
      return effectiveGate === null
        ? { operation: outcome.value, released: true }
        : { operation: outcome.value, released: false, hold: effectiveGate };
    }
    // The operation already left `building` under another writer (a
    // deletion trigger or a restart's reconciliation); whatever it is now,
    // this build no longer owns the host.
    log.warn("checkpoint.build.outcome_superseded", {
      ...fields,
      code: failure.code,
      refusal: outcome.refusal.code,
    });
    const current = await infra.repo.getOperation(key, operationId);
    return restoredGate === null
      ? { operation: current ?? input.operation, released: true }
      : {
          operation: current ?? input.operation,
          released: false,
          hold: restoredGate,
        };
  }

  /** A failure after the freeze: the operation stays owned for reconciliation. */
  async function holdForReconciliation(
    expectedPhase: "retiring" | "ready",
    failure: CheckpointFailure,
  ): Promise<CheckpointMaintenanceResult> {
    const outcome = await infra.repo.recordOutcome({
      key,
      operationId,
      expectedPhase,
      phase: "needs_reconciliation",
      failure,
      at: infra.now(),
    });
    if (!outcome.ok && outcome.refusal.code === "checkpoint_not_found") {
      // The conversation was deleted mid-operation and the trigger took the
      // operation with it; there is no obligation left to hold.
      host.project(null);
      log.warn("checkpoint.retirement_orphaned", {
        ...fields,
        code: failure.code,
      });
      return { operation: input.operation, released: true };
    }
    const hold: CheckpointActorProjection = {
      operationId,
      phase: "needs_reconciliation",
    };
    host.project(hold);
    const operation = outcome.ok
      ? outcome.value
      : ((await infra.repo.getOperation(key, operationId)) ?? input.operation);
    log.error("checkpoint.reconciliation_required", {
      ...fields,
      code: failure.code,
      lastStablePhase: operation.lastStablePhase,
    });
    return { operation, released: false, hold };
  }

  /**
   * An exception before the freeze is a failed build, not a persistence
   * failure. Neither the receipt nor the log repeats what it said: the receipt
   * is public, and the exception itself may quote the input or the provider,
   * so the log gets the error's class and code and the receipt gets a code.
   */
  function buildError(error: unknown): CheckpointFailure {
    log.warn("checkpoint.build.error", {
      ...fields,
      ...checkpointErrorFields(error),
    });
    return {
      code: "build_error",
      message:
        "the build failed before freezing; the checkpoint.build.error log entry names the fault",
    };
  }
  const cancelledFailure: CheckpointFailure = {
    code: "cancelled",
    message: "checkpoint generation was cancelled",
  };

  if (host.signal.aborted && operation.handoff === null) {
    return settleBuild("cancelled", cancelledFailure, NO_TELEMETRY);
  }

  if (operation.handoff !== null) {
    let handoff = operation.handoff;
    let captureObservation: RecordCheckpointOutcomeInput["captureObservation"];
    const captureController = new AbortController();
    const abortCapture = () => captureController.abort(host.signal.reason);
    host.signal.addEventListener("abort", abortCapture, { once: true });
    const skipCapture = () =>
      captureController.abort(host.captureSignal.reason);
    host.captureSignal.addEventListener("abort", skipCapture, { once: true });
    if (host.captureSignal.aborted) skipCapture();
    if (host.signal.aborted) abortCapture();
    try {
      const prompt = buildHandoffPrompt(handoff.captureId);
      if (!prompt.ok)
        throw new Error("Capture prompt exceeds fixed input budget");
      await host.mutateCapture(async () => {
        const current = await infra.repo.getOperation(key, operationId);
        if (!current?.handoff) throw new Error("Capture operation disappeared");
        operation = current;
        handoff = current.handoff;
        if (handoff.requestedMode !== null && handoff.stage === "pending") {
          const running = await infra.repo.beginCapture({
            key,
            operationId,
            captureId: handoff.captureId,
            expectedSourceBasis: source.basis,
            at: infra.now(),
          });
          if (!running.ok || running.value.handoff === null)
            throw new Error("Capture start refused");
          operation = running.value;
          handoff = running.value.handoff;
        }
      });
      const result = await host.captureHandoff(
        operation,
        {
          captureId: handoff.captureId,
          promptText: prompt.promptText,
          outputSchema: prompt.outputSchema,
          limits: CHECKPOINT_CAPTURE_LIMITS,
          signal: captureController.signal,
        },
        captured,
      );
      captureObservation = {
        captureId: handoff.captureId,
        modeEstablished: result.modeEstablished,
        submitted: result.submitted,
        correlatedCompletion: result.correlatedCompletion,
        activity: result.activity,
        usage: result.usage,
        continuationDisposition: result.continuation.disposition,
      };
      if (!result.executionSettled || result.cleanupFailure)
        throw new Error("Capture cleanup unverified");
      continuationUnusable =
        result.continuation.disposition === "clear" &&
        operation.protectedReferences.priorBackendRef !== null;
      await host.settleReceipts();
      const finalSource = await captureCheckpointSourceForHost(host, infra);
      const appended = finalSource.captured.entries.slice(
        source.captured.entries.length,
      );
      const ownedExtension =
        isDeepStrictEqual(
          finalSource.captured.entries.slice(0, source.captured.entries.length),
          source.captured.entries,
        ) &&
        appended.every(
          (entry) =>
            entry.origin?.source === "checkpoint_capture" &&
            entry.origin.checkpointCapture?.captureId === handoff.captureId &&
            entry.origin.checkpointCapture.operationId === operationId,
        );
      const observation = host.observe();
      const sourceValid =
        !result.sourceChanged &&
        ownedExtension &&
        isDeepStrictEqual(
          appended.map((entry) => entry.entryId),
          result.auditEntryIds,
        ) &&
        observation.settled &&
        observation.activityEpoch === captured.activityEpoch &&
        observation.backgroundEpoch === captured.backgroundEpoch &&
        observation.backendRef ===
          operation.protectedReferences.priorBackendRef &&
        (result.continuation.disposition !== "retain" ||
          (result.continuation.backendRef?.ref ===
            operation.protectedReferences.priorBackendRef &&
            result.continuation.backendRef.backend === handoff.backend));
      const valid =
        result.candidateText === null
          ? null
          : validateHandoffCandidate({
              answerText: result.candidateText,
              entries: source.captured.entries,
            });
      const settled = await host.mutateCapture(async () => {
        const current = await infra.repo.getOperation(key, operationId);
        if (!current?.handoff) throw new Error("Capture operation disappeared");
        handoff = current.handoff;
        if (
          handoff.stage !== "pending" &&
          handoff.stage !== "running" &&
          handoff.stage !== "settling"
        )
          throw new Error("Capture already settled");
        const omissionReason =
          handoff.stopIntent === "cancel"
            ? "cancelled"
            : handoff.stopIntent === "skip"
              ? "skipped"
              : !sourceValid
                ? "checkpoint_failed"
                : host.signal.aborted
                  ? "cancelled"
                  : (result.omissionReason ??
                    (valid?.ok ? null : (valid?.reason ?? "invalid_output")));
        const at = infra.now();
        return infra.repo.settleCapture({
          key,
          operationId,
          captureId: handoff.captureId,
          expectedSourceBasis: source.basis,
          expectedStage: handoff.stage,
          at,
          settlement: {
            kind: "result",
            handoff: {
              ...handoff,
              stage: omissionReason === null ? "captured" : "omitted",
              omissionReason,
              modeEstablished: result.modeEstablished,
              submitted: result.submitted,
              correlatedCompletion: result.correlatedCompletion,
              executionSettled: true,
              auditDurable: true,
              settledAt: at,
              activity: result.activity,
              usage: result.usage,
              continuationDisposition: result.continuation.disposition,
              candidate:
                omissionReason === null && valid?.ok ? valid.candidate : null,
              contentHash:
                omissionReason === null && valid?.ok ? valid.contentHash : null,
              acceptedOutputBytes:
                omissionReason === null && valid?.ok ? valid.outputBytes : null,
              sourceCoverage:
                sourceValid && appended[0]
                  ? {
                      seqStart: appended[0].seq,
                      seqEnd: appended.at(-1)?.seq ?? appended[0].seq,
                      entryIds: appended
                        .flatMap((entry) =>
                          entry.entryId === null ? [] : [entry.entryId],
                        )
                        .slice(0, 256),
                    }
                  : null,
              finalSourceBasis: sourceValid ? finalSource.basis : source.basis,
            },
          },
        });
      });
      if (!settled.ok)
        throw new Error(`Capture settlement refused: ${settled.refusal.code}`);
      operation = settled.value;
      captureObservation = undefined;
      if (!sourceValid) {
        return settleBuild(
          "failed",
          {
            code: "source_changed",
            message: "Unrelated activity changed the capture source",
          },
          NO_TELEMETRY,
        );
      }
      source = finalSource;
      captured = observation;
    } catch (error) {
      const held = await infra.repo.recordOutcome({
        key,
        operationId,
        ...(captureObservation ? { captureObservation } : {}),
        expectedPhase: "building",
        phase: "needs_reconciliation",
        failure: {
          code: "capture_cleanup_unverified",
          message:
            "Capture execution or required audit writes could not be verified",
        },
        at: infra.now(),
      });
      if (!held.ok)
        throw new Error(
          `Capture reconciliation write refused: ${held.refusal.code}`,
        );
      const hold = { operationId, phase: "needs_reconciliation" as const };
      host.project(hold);
      log.error("checkpoint.capture.unsettled", {
        ...fields,
        ...checkpointErrorFields(error),
      });
      return {
        operation: held.value,
        released: false,
        hold,
      };
    } finally {
      host.signal.removeEventListener("abort", abortCapture);
      host.captureSignal.removeEventListener("abort", skipCapture);
    }
  }

  if (host.signal.aborted)
    return settleBuild("cancelled", cancelledFailure, NO_TELEMETRY);

  let generated: Awaited<ReturnType<typeof infra.generate>>;
  try {
    const [config, existingArtifact] = await Promise.all([
      infra.resolveConfig(host.projectPath),
      infra.findArtifact(host.target.conversationId),
    ]);
    log.info("checkpoint.build.started", {
      ...fields,
      capturedThroughSeq: source.basis.capturedThroughSeq,
      backend: config.backend,
      artifactCandidate: existingArtifact !== null,
    });
    generated = await infra.generate(
      {
        identity: {
          conversationId: host.target.conversationId,
          checkpointId: operationId,
          ordinal: input.operation.ordinal,
          scope: key.scope,
        },
        source,
        ...(operation.handoff?.candidate
          ? { agentHandoff: operation.handoff.candidate }
          : {}),
        existingArtifact,
        lane: {
          address: {
            projectPath: host.projectPath,
            target: targetFromStoreSessionName(
              host.target.projectName,
              conversationTargetStoreSessionName(host.target),
              `checkpoint-${operationId}`,
            ),
          },
          worktreePath: host.worktreePath,
          backend: config.backend,
        },
        config,
        createdAt: infra.now(),
      },
      { executeTaskRun: infra.executeTaskRun, signal: host.signal, log },
    );
  } catch (error) {
    return settleBuild("failed", buildError(error), NO_TELEMETRY);
  }
  const telemetry: CheckpointGenerationTelemetry = {
    generationPassCount: generated.generationPassCount,
    usage: generated.usage,
  };
  if (!generated.ok) {
    return settleBuild(
      generated.failure.code === "cancelled" ? "cancelled" : "failed",
      generated.failure,
      telemetry,
    );
  }

  // Recheck before the freeze. The asynchronous part — settling receipts and
  // re-reading the archive — runs first; everything else is checked inside
  // the freeze's own critical section, over the conversation row as that
  // transaction sees it, so neither an in-process change nor a durable one
  // can land between the check and the commit that retires the runtime.
  try {
    await host.settleReceipts();
  } catch (error) {
    host.recordDurabilityFailure(error);
    return settleBuild(
      "failed",
      {
        code: "receipts_unsettled",
        message: "the conversation's durable receipts did not settle",
      },
      telemetry,
    );
  }
  let recaptured: CapturedCheckpointSource;
  try {
    recaptured = await captureCheckpointSource(
      {
        conversationId: host.target.conversationId,
        transcriptPath: host.transcriptPath,
      },
      { readEntries: infra.readEntries },
    );
  } catch (error) {
    return settleBuild("failed", buildError(error), telemetry);
  }

  const fence = (
    conversation: ConversationState | null,
  ): CheckpointFailure | null => {
    if (host.signal.aborted) return cancelledFailure;
    if (
      operation.handoff &&
      conversation?.agentBackend !== operation.handoff.backend
    ) {
      return {
        code: "source_changed",
        message: "The selected source backend changed during generation",
      };
    }
    const durableRefusal = host.observeDurable(conversation);
    if (durableRefusal !== null) {
      return {
        code: durableRefusal,
        message: `the conversation is no longer eligible (${durableRefusal})`,
      };
    }
    const observed = host.observe();
    if (!observed.settled) {
      return {
        code: "late_activity",
        message: `the conversation changed during the build (${observed.reason ?? "host_changed"})`,
      };
    }
    if (
      observed.backendRef !==
      input.operation.protectedReferences.priorBackendRef
    ) {
      return {
        code: "continuation_changed",
        message: "the provider continuation changed during the build",
      };
    }
    if (observed.activityEpoch !== captured.activityEpoch) {
      return {
        code: "late_activity",
        message: "provider or owned activity occurred during the build",
      };
    }
    if (observed.backgroundEpoch !== captured.backgroundEpoch) {
      return {
        code: "late_activity",
        message:
          "background work appeared or finished during the build (background_work)",
      };
    }
    if (
      !checkpointSourceBasisMatches(source.basis, recaptured.basis) ||
      source.archiveFingerprint !== recaptured.archiveFingerprint
    ) {
      return {
        code: "source_changed",
        message: `the archive changed during the build (captured through ${source.basis.capturedThroughSeq}, now ${recaptured.basis.capturedThroughSeq})`,
      };
    }
    return null;
  };
  const fenced: { failure: CheckpointFailure | null } = { failure: null };
  const frozen = await infra.repo.freezePayload({
    key,
    operationId,
    payload: generated.payload,
    ...(generated.handoffDecision
      ? { handoffDecision: generated.handoffDecision }
      : {}),
    usage: generated.usage,
    at: infra.now(),
    fence: (conversation) => {
      fenced.failure = fence(conversation);
      return fenced.failure;
    },
  });
  if (!frozen.ok) {
    const failure = fenced.failure ?? {
      code: "freeze_refused",
      message: `the payload could not be frozen: ${frozen.refusal.code}`,
    };
    return settleBuild(
      failure.code === "cancelled" ? "cancelled" : "failed",
      failure,
      telemetry,
    );
  }
  host.project({ operationId, phase: "retiring" });
  log.info("checkpoint.frozen", {
    ...fields,
    seedBytes: generated.payload.sectionBytes.total,
    seedSha256: generated.payload.seedSha256,
    generationPassCount: generated.generationPassCount,
  });

  // From here the transition finishes forward: cancellation no longer applies,
  // and a failure holds the operation rather than reopening the old runtime.
  try {
    await host.closeRuntime();
  } catch (error) {
    log.error("checkpoint.runtime_close_failed", {
      ...fields,
      ...checkpointErrorFields(error),
    });
    return holdForReconciliation("retiring", {
      code: "runtime_close_failed",
      message: "the retired runtime did not close; run checkpoint reconcile",
    });
  }
  log.info("checkpoint.runtime_closed", fields);

  host.project({ operationId, phase: "ready" });
  try {
    await host.awaitDurable();
  } catch (error) {
    host.recordDurabilityFailure(error);
    log.error("checkpoint.readiness_receipts_failed", {
      ...fields,
      ...checkpointErrorFields(error),
    });
    return holdForReconciliation("retiring", {
      code: "readiness_receipts_failed",
      message:
        "row or snapshot receipts did not settle before readiness; run checkpoint reconcile",
    });
  }
  let committed: Awaited<
    ReturnType<ConversationCheckpointsRepo["commitReady"]>
  >;
  try {
    committed = await infra.repo.commitReady({
      key,
      operationId,
      at: infra.now(),
    });
  } catch (error) {
    log.error("checkpoint.readiness_commit_failed", {
      ...fields,
      ...checkpointErrorFields(error),
    });
    return holdForReconciliation("retiring", {
      code: "readiness_commit_failed",
      message: "readiness could not be committed; run checkpoint reconcile",
    });
  }
  if (!committed.ok) {
    return holdForReconciliation("retiring", {
      code: "readiness_commit_refused",
      message: `readiness was refused: ${committed.refusal.code}`,
    });
  }
  log.info("checkpoint.ready", {
    ...fields,
    seedSha256: generated.payload.seedSha256,
    seedBytes: generated.payload.sectionBytes.total,
  });
  return { operation: committed.value, released: true };
}
