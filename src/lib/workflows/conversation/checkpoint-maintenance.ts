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
 * readiness commit → row and snapshot receipts → release. A failure before the
 * freeze leaves the source runtime, its reference and its history untouched; a
 * failure after the freeze stays owned as `needs_reconciliation`.
 *
 * Private to the manager: `boundaries.arch.test.ts` refuses imports of this
 * module from outside `lib/workflows/conversation/`, so the HTTP and CLI
 * surfaces reach a checkpoint only through `checkConversationCheckpoint`,
 * `startConversationCheckpoint` and `cancelConversationCheckpoint`. The work
 * ends at readiness: delivering the frozen seed to a fresh runtime, and
 * repairing an operation a restart interrupted, are separate owners over the
 * same repository.
 */

import type { CompactionConfig } from "@/lib/config/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { CheckpointRefusalCode } from "@/lib/conversation-checkpoints/admission";
import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
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
  /** Let owned receipts, queue drains, external frames and tracked work land before a read. */
  settleReceipts(): Promise<void>;
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
  const { host, source } = input;
  const { key } = host;
  const operationId = input.operation.id;
  const fields = {
    ...conversationTargetLogFields(host.target),
    operationId,
    ordinal: input.operation.ordinal,
  };
  const log = infra.log;

  /**
   * A failure or cancellation before the freeze. The source runtime, its
   * reference and its history are untouched; the queue is released only once
   * this outcome is durable, which is why a thrown write propagates rather
   * than releasing.
   */
  async function settleBuild(
    phase: "failed" | "cancelled",
    failure: CheckpointFailure,
    telemetry: CheckpointGenerationTelemetry,
  ): Promise<CheckpointMaintenanceResult> {
    const outcome = await infra.repo.recordOutcome({
      key,
      operationId,
      expectedPhase: "building",
      phase,
      failure,
      usage: telemetry.usage,
      generationPassCount: telemetry.generationPassCount,
      at: infra.now(),
    });
    // A recovery build that ends without a checkpoint hands the host back to
    // the operation it superseded: the repository restored that gate in the
    // same write, and the projection follows it so nothing drains.
    const restoredGate = restoredGateFor(input.operation);
    host.project(restoredGate);
    if (outcome.ok) {
      log.info(`checkpoint.build.${phase}`, {
        ...fields,
        code: failure.code,
        generationPassCount: telemetry.generationPassCount,
        ...(restoredGate === null
          ? {}
          : { restoredOperationId: restoredGate.operationId }),
      });
      return restoredGate === null
        ? { operation: outcome.value, released: true }
        : { operation: outcome.value, released: false, hold: restoredGate };
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

  if (host.signal.aborted) {
    return settleBuild("cancelled", cancelledFailure, NO_TELEMETRY);
  }

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
    if (observed.activityEpoch !== input.captured.activityEpoch) {
      return {
        code: "late_activity",
        message: "provider or owned activity occurred during the build",
      };
    }
    if (observed.backgroundEpoch !== input.captured.backgroundEpoch) {
      return {
        code: "late_activity",
        message:
          "background work appeared or finished during the build (background_work)",
      };
    }
    if (!checkpointSourceBasisMatches(source.basis, recaptured.basis)) {
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
