/**
 * Background job lifecycle management for async merge, commit,
 * and conflict resolution operations.
 *
 * Jobs are dispatched synchronously (fire-and-forget) as XState actors via
 * the generic machine host (`machine-host.ts`). Merge and resolve-conflicts
 * jobs use the mergeMachine (Smart Merge pipeline); commit jobs use the
 * commitMachine (Smart Commit pipeline with validation).
 *
 * Jobs are ephemeral by decision (plan D12): machine actors exist only in
 * this process, a server restart does not rehydrate them, and no machine
 * snapshot is persisted. The durable record is the BackgroundJob row —
 * written on dispatch, finalized on terminal state — and jobs orphaned by a
 * restart or hang are closed out by stale-job recovery, never resumed.
 *
 * Status changes are broadcast via SSE so the UI can track progress in real
 * time. Storage uses globalThis Maps (HMR-safe singleton pattern) keyed by
 * "projectPath::sessionName".
 */

import { randomUUID } from "node:crypto";
import { createActor } from "xstate";
import { acquireSessionLock as defaultAcquireSessionLock } from "../prompt/single-flight";
import { publishEvent, type PublishFn } from "../events/publication";
import { createLogger } from "../logging";
import { createJobNotification } from "../notifications/service";
import { createMergeIntentsRepo } from "../merge-intents/repo";
import { getStateDb } from "../state-store/store";
import {
  createJobsRepo,
  deriveNotificationType,
  deriveNotificationTitle,
} from "./repo";
import {
  abortJobActor,
  dispatchMachineJob,
  tearDownJobActor,
  _resetJobActorRegistryForTesting,
  type JobDispatchError,
  type JobDispatchHost,
  type JobDispatchResult,
  type JobSubscriptionConfig,
} from "./machine-host";
import {
  mergeMachine,
  type MergeMachineType,
} from "../workflows/merge/machine";
import { provideRegisteredDeliveryGate } from "../workflows/merge/delivery-gate-port";
import { resolveRegisteredMergeAssociation } from "../workflows/merge/association-port";
import {
  notifyRegisteredMergeDelivered,
  resolveDeliveredMergeSha,
} from "../workflows/merge/delivery-lifecycle-port";
import type {
  MergeEntryMode,
  MergeInput,
  MergeContext,
  MergeOutput,
  MergePhase,
} from "../workflows/merge/types";
import {
  commitMachine,
  type CommitMachineType,
} from "../workflows/commit/machine";
import type {
  CommitInput,
  CommitContext,
  CommitOutput,
} from "../workflows/commit/types";
import {
  rebaseMachine,
  type RebaseMachineType,
} from "../workflows/rebase/machine";
import type {
  RebaseInput,
  RebaseContext,
  RebaseOutput,
} from "../workflows/rebase/types";
import type { RebaseOnto } from "@/lib/git/rebase";
import {
  deleteParkedMergeRef,
  PARKED_MERGE_REF_PREFIX,
} from "@/lib/git/worktree";
import { getErrorMessage } from "@/lib/shared/errors";
import { assertNever } from "../shared/assert-never";
import type { ConflictAnalysis } from "@/lib/git/schemas";
import type {
  BackgroundJob,
  JobRecord,
  JobStatusEvent,
  ConflictDecisionInput,
} from "./schemas";
import { getGlobalSingleton } from "../shared/global-singleton";

const logger = createLogger("background-jobs");

// ============================================================
// Constants
// ============================================================

/**
 * A running job that has reported nothing for this long is torn down (30
 * minutes). Every stage that can take real time is individually bounded — the
 * resolver turn, validation, the delivery gate — so this is the backstop for a
 * job nothing is driving any more, not a ceiling on how long work may take.
 */
const STALE_INACTIVITY_MS = 30 * 60 * 1000;

// ============================================================
// Dependency Types
// ============================================================

export type AcquireSessionLockFn = (
  projectPath: string,
  sessionName: string,
) => () => void;

// ============================================================
// globalThis Singleton Registries (HMR-safe)
// ============================================================

const JOB_REGISTRY_KEY = "__cc_background_jobs" as const;
const ANALYSIS_REGISTRY_KEY = "__cc_conflict_analysis" as const;

function getJobRegistry(): Map<string, BackgroundJob> {
  return getGlobalSingleton(
    JOB_REGISTRY_KEY,
    () => new Map<string, BackgroundJob>(),
  );
}

function getConflictAnalysisRegistry(): Map<string, ConflictAnalysis> {
  return getGlobalSingleton(
    ANALYSIS_REGISTRY_KEY,
    () => new Map<string, ConflictAnalysis>(),
  );
}

/** Build the canonical key for a session */
function sessionKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

// ============================================================
// Public API — Query
// ============================================================

/** Get the current background job for a session, if any */
export function getJob(
  projectPath: string,
  sessionName: string,
): BackgroundJob | undefined {
  return getJobRegistry().get(sessionKey(projectPath, sessionName));
}

/** Get all active (running) jobs from the in-memory registry */
export function getActiveJobs(): BackgroundJob[] {
  const registry = getJobRegistry();
  return Array.from(registry.values()).filter((j) => j.status === "running");
}

/**
 * The session's in-flight delivery merge, or null.
 *
 * The symmetric half of the delivery gate: while this job is running, the
 * session branch is being delivered under the project lock, so a workflow
 * launch must be refused — otherwise the two admit each other in the window
 * between the merge route's advisory lease check and the publish. Skipping
 * completion cleanup does not relax this exclusion.
 *
 * `finalizeSessionOnPublish` is read rather than `jobType` because a graph lane
 * merge is a merge job too, and it is the workflow's OWN work; blocking on it
 * would have the engine refuse itself. A `ready-to-land` candidate is parked
 * awaiting an operator decision and publishes nothing until a land re-entry
 * starts a new running job, so only `running` counts as in flight.
 */
export function getFinalizingSessionMergeJob(
  projectPath: string,
  sessionName: string,
): BackgroundJob | null {
  const job = getJob(projectPath, sessionName);
  if (job === undefined) return null;
  if (job.status !== "running") return null;
  return job.finalizeSessionOnPublish === true ? job : null;
}

/**
 * Job types whose machines carry the operator ABORT wiring. A rebase job is
 * deliberately absent: its machine ignores the event, and answering "stopped"
 * for a run that keeps going would be worse than refusing.
 */
const ABORTABLE_JOB_TYPES: ReadonlySet<BackgroundJob["jobType"]> = new Set<
  BackgroundJob["jobType"]
>(["merge", "resolve-conflicts", "commit"]);

export type AbortSessionJobResult =
  | { ok: true; jobId: string; delivery: "stopping" | "deferred" }
  | { ok: false; error: "NO_ABORTABLE_JOB" | "JOB_ACTOR_MISSING" };

/**
 * Stop the session's in-flight merge-family job. The machine's own terminal
 * projection does the rest — broadcast, persist, notification, lock release —
 * so an aborted job ends exactly like any other failure.
 *
 * `JOB_ACTOR_MISSING` separates "nothing is running" from "a record says
 * running but this process holds no actor for it" (a restart orphan): the
 * second is not a stop the caller may report as delivered. `delivery` carries
 * the same honesty one level finer — a machine in an unrecallable phase (a
 * merge already publishing) records the stop without ending the run, and the
 * caller must not describe that as stopped.
 */
export function abortSessionJob(
  projectPath: string,
  sessionName: string,
): AbortSessionJobResult {
  const job = getJob(projectPath, sessionName);
  if (
    job === undefined ||
    job.status !== "running" ||
    !ABORTABLE_JOB_TYPES.has(job.jobType)
  ) {
    return { ok: false, error: "NO_ABORTABLE_JOB" };
  }

  const delivery = abortJobActor(job.jobId);
  if (delivery === "no-actor") {
    logger.warn("job.abort_actor_missing", {
      jobId: job.jobId,
      jobType: job.jobType,
      sessionName,
    });
    return { ok: false, error: "JOB_ACTOR_MISSING" };
  }

  logger.info("job.abort_requested", {
    jobId: job.jobId,
    jobType: job.jobType,
    sessionName,
    phase: job.phase ?? null,
    delivery,
  });
  return { ok: true, jobId: job.jobId, delivery };
}

/** Get the stored conflict analysis for a session, if any */
export function getConflictAnalysis(
  projectPath: string,
  sessionName: string,
): ConflictAnalysis | undefined {
  return getConflictAnalysisRegistry().get(
    sessionKey(projectPath, sessionName),
  );
}

// ============================================================
// Broadcast Helper
// ============================================================

const defaultJobBroadcast: PublishFn = publishEvent;

/**
 * Record that the job moved. Every status broadcast and every durable progress
 * write is movement, and inactivity-based stale recovery reads nothing else —
 * a job that stops stamping is a job nothing is driving any more.
 */
function markProgress(job: BackgroundJob): void {
  job.lastProgressAt = new Date().toISOString();
}

function broadcastJobStatus(
  job: BackgroundJob,
  broadcast: PublishFn = defaultJobBroadcast,
): void {
  markProgress(job);
  const event: JobStatusEvent = {
    type: "job-status",
    jobType: job.jobType,
    status: job.status,
    projectName: job.projectName,
    sessionName: job.sessionName,
    jobId: job.jobId,
    branchName: job.branchName,
    ...(job.mergeHash && { mergeHash: job.mergeHash }),
    ...(job.commitHash && { commitHash: job.commitHash }),
    ...(job.conflictCount != null && { conflictCount: job.conflictCount }),
    ...(job.conflictFiles && { conflictFiles: job.conflictFiles }),
    ...(job.errorMessage && { errorMessage: job.errorMessage }),
    ...(job.phase && { phase: job.phase }),
    ...(job.parkedRef && { parkedRef: job.parkedRef }),
    ...(job.preparedSha && { preparedSha: job.preparedSha }),
    ...(job.expectedTargetSha && { expectedTargetSha: job.expectedTargetSha }),
    ...(job.refreshWarning && { refreshWarning: job.refreshWarning }),
    ...(job.upToDate && { upToDate: job.upToDate }),
    ...(job.haltReason && { haltReason: job.haltReason }),
    ...(job.lastProgressAt && { lastProgressAt: job.lastProgressAt }),
    ...(job.intentSource && { intentSource: job.intentSource }),
  };
  broadcast(event);

  // On terminal state: persist to DB and create notification
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "conflicts" ||
    job.status === "ready-to-land" ||
    job.status === "discarded"
  ) {
    persistTerminalState(job);
  }
}

// ============================================================
// Notification Persistence Helpers
// ============================================================

/** Persist a job record to the DB. Non-throwing — logs errors. */
function persistJobRecord(job: BackgroundJob): void {
  try {
    createJobsRepo(getStateDb()).createJobRecord(job);
  } catch (err) {
    logger.error("background-jobs.persist_job_record_failed", {
      jobId: job.jobId,
      error: getErrorMessage(err),
    });
  }
}

/** Persist candidate proof as soon as validation finishes, before gate I/O. */
function persistJobProgress(job: BackgroundJob): void {
  const candidateValidation = job.candidateValidation;
  if (candidateValidation === undefined) return;
  try {
    createJobsRepo(getStateDb()).persistCandidateValidation(
      job.jobId,
      candidateValidation,
    );
  } catch (err) {
    logger.error("background-jobs.persist_job_progress_failed", {
      jobId: job.jobId,
      executionId: job.executionId,
      validationRef: candidateValidation.validationRef,
      error: getErrorMessage(err),
    });
  }
}

/** Persist terminal state to DB and create a notification. Non-throwing. */
function persistTerminalState(job: BackgroundJob): void {
  try {
    createJobsRepo(getStateDb()).updateJobRecord(job.jobId, {
      status: job.status,
      mergeHash: job.mergeHash,
      commitHash: job.commitHash,
      conflictCount: job.conflictCount,
      conflictFiles: job.conflictFiles,
      errorMessage: job.errorMessage,
      executionId: job.executionId,
      // A ready-to-land terminal parks a real commit and hands the operator a
      // decision that can outlive this process, so its bookkeeping goes to the
      // row a land re-entry reads after a restart.
      parkedRef: job.parkedRef,
      preparedSha: job.preparedSha,
      expectedTargetSha: job.expectedTargetSha,
      candidateValidation: job.candidateValidation,
    });

    // A completed gate-passed final-publish merge IS the delivery: mark the
    // linked execution Delivered promptly rather than waiting for a status
    // read to reconcile. The gate ran before publish, so a completed delivering
    // merge + finalPublish implies gate-passed.
    const deliveredSha = resolveDeliveredMergeSha(job);
    if (
      (job.jobType === "merge" || job.jobType === "resolve-conflicts") &&
      job.status === "completed" &&
      deliveredSha !== null &&
      (job.executionId !== undefined || job.specExecutionId !== undefined) &&
      job.finalPublish === true
    ) {
      notifyRegisteredMergeDelivered(
        job.executionId,
        deliveredSha,
        job.specExecutionId,
      );
    }

    const notifType = deriveNotificationType(job.jobType, job.status);
    const title = deriveNotificationTitle(notifType);
    const message = buildNotificationMessage(job);

    createJobNotification({
      type: notifType,
      title,
      message,
      projectName: job.projectName,
      sessionName: job.sessionName,
      branchName: job.branchName,
      jobId: job.jobId,
      jobType: job.jobType,
      mergeHash: job.mergeHash,
      commitHash: job.commitHash,
      conflictCount: job.conflictCount,
      conflictFiles: job.conflictFiles,
      targetBranch: job.targetBranch,
      errorMessage: job.errorMessage,
    });
  } catch (err) {
    logger.error("background-jobs.persist_terminal_failed", {
      jobId: job.jobId,
      error: getErrorMessage(err),
    });
  }
}

function buildNotificationMessage(job: BackgroundJob): string {
  const branch = job.branchName;
  const target = job.targetBranch ?? "main";
  switch (job.status) {
    case "completed":
      if (job.upToDate === true) {
        // A no-op merge still ends the work it was asked to end, so the copy
        // names the outcome the operator gets — but only a finalizing merge
        // ends the session, and a graph lane's no-op does not.
        return job.finalizeSessionOnPublish === false
          ? `Branch ${branch} is already fully merged into ${target} (nothing new to merge)`
          : `Branch ${branch} is already fully merged into ${target} — session finished (nothing new to merge)`;
      }
      if (job.jobType === "merge")
        return `Branch ${branch} merged into ${target}${job.mergeHash ? ` (${job.mergeHash.slice(0, 7)})` : ""}`;
      if (job.jobType === "commit")
        return `Changes committed${job.commitHash ? ` (${job.commitHash.slice(0, 7)})` : ""}`;
      if (job.jobType === "rebase")
        return `Branch ${branch} rebased onto ${target}`;
      return `Conflicts on ${branch} resolved successfully (target: ${target})`;
    case "conflicts":
      return `${job.conflictCount ?? 0} conflict${(job.conflictCount ?? 0) !== 1 ? "s" : ""} detected merging ${branch} into ${target}`;
    case "failed":
      return job.errorMessage ?? `${job.jobType} failed on ${branch}`;
    case "running":
      return `${job.jobType} on ${branch}`;
    case "ready-to-land":
      return `Branch ${branch} prepared for ${target} — awaiting Land${job.preparedSha ? ` (${job.preparedSha.slice(0, 7)})` : ""}`;
    case "discarded":
      return `Prepared merge for ${branch} discarded`;
    default:
      return assertNever(job.status);
  }
}

// ============================================================
// Stale Job Detection
// ============================================================

/**
 * Close out a job that has stopped reporting progress: record the forced
 * terminal state, stop whatever is still running for it, and broadcast and
 * persist the verdict. Returns true when the job no longer holds the session's
 * registry slot — the session lock itself is released by the stopped machine's
 * own teardown, which is asynchronous, so a dispatch that triggers recovery may
 * still be refused as busy and succeed on the operator's retry. Waiting would
 * be worse: the next job would start in a worktree the previous machine is
 * still aborting a merge in.
 *
 * The verdict is written before the teardown so the machine's own projection
 * cannot answer for a job the host has already judged — a stopped actor that
 * published a `completed` merge here would contradict the failure the operator
 * was just shown.
 *
 * Inactivity is measured from the last progress stamp, falling back to
 * `startedAt` for a job registered before the stamp existed (the registry
 * outlives a module reload).
 */
function recoverStaleJob(
  key: string,
  existing: BackgroundJob,
  broadcast: PublishFn,
): boolean {
  if (existing.status !== "running") return false;

  const lastProgress = new Date(
    existing.lastProgressAt ?? existing.startedAt,
  ).getTime();
  const inactiveMs = Date.now() - lastProgress;
  if (inactiveMs < STALE_INACTIVITY_MS) return false;

  const stalledPhase = existing.phase ?? null;
  const inactiveMinutes = Math.round(inactiveMs / 60_000);
  existing.status = "failed";
  existing.errorMessage = `Job reported no progress for ${inactiveMinutes} minutes and was stopped (stale recovery)`;
  existing.phase = undefined;
  existing.completedAt = new Date().toISOString();

  // Remove the stale job entry so a new one can be registered
  getJobRegistry().delete(key);

  const teardown = tearDownJobActor(existing.jobId);

  logger.warn("background-jobs.stale_recovery", {
    jobId: existing.jobId,
    jobType: existing.jobType,
    sessionName: existing.sessionName,
    phase: stalledPhase,
    inactiveMs,
    elapsedMs: Date.now() - new Date(existing.startedAt).getTime(),
    teardown,
  });

  broadcastJobStatus(existing, broadcast);

  return true;
}

// ============================================================
// Superseded parked candidates
// ============================================================

/**
 * Drop the parked candidate a new dispatch is taking the session's registry
 * slot from.
 *
 * A `ready-to-land` job holds a real commit under `refs/cc-merges/` plus a
 * durable row offering it to land. Once another job owns the session slot that
 * offer is void — the operator's next Land would resolve to the new job — so
 * leaving either behind means an unreachable commit accumulating in the
 * repository and, after a restart, a persisted candidate the land route would
 * happily publish. Both are ended here: the row is marked `discarded` (which
 * also broadcasts and notifies, so a UI still showing "awaiting Land" learns
 * the candidate is gone) and the ref is deleted.
 *
 * The delete is fire-and-forget because dispatch is synchronous; a failure is
 * logged and left to the startup sweep, which collects any ref with no
 * parked row.
 */
function discardSupersededParkedCandidate(params: {
  projectPath: string;
  existing: BackgroundJob;
  continuesParkedRef: string | undefined;
  broadcast: PublishFn;
}): void {
  const { projectPath, existing, continuesParkedRef, broadcast } = params;
  // The same derivation the land/discard routes use, so a parked job whose
  // record predates the stamped ref still names the ref prepare created.
  const parkedRef =
    existing.parkedRef ?? `${PARKED_MERGE_REF_PREFIX}${existing.jobId}`;
  // A land or discard re-entry IS this candidate's job: deleting the ref would
  // destroy the commit it exists to publish.
  if (continuesParkedRef === parkedRef) return;

  logger.info("merge.parked_candidate_superseded", {
    jobId: existing.jobId,
    jobType: existing.jobType,
    sessionName: existing.sessionName,
    parkedRef,
    fromRegistry: true,
  });

  void deleteParkedMergeRef(projectPath, parkedRef)
    .then((deleted) => {
      if (deleted) return;
      logger.warn("merge.parked_ref_delete_missing", {
        jobId: existing.jobId,
        parkedRef,
      });
    })
    .catch((err: unknown) => {
      logger.warn("merge.parked_ref_delete_failed", {
        jobId: existing.jobId,
        parkedRef,
        error: getErrorMessage(err),
      });
    });

  existing.status = "discarded";
  existing.phase = undefined;
  existing.completedAt = new Date().toISOString();
  broadcastJobStatus(existing, broadcast);
}

/**
 * End the parked candidates the registry no longer remembers.
 *
 * The registry entry dies with the process; the row and the commit it offers do
 * not, so after a restart a new dispatch is the only thing left that can
 * withdraw the offer — and until something does, the row keeps the startup
 * sweep from ever collecting the ref it claims.
 *
 * How loud the withdrawal is depends on the ref: one that was still there was a
 * live offer whose loss is news to whoever might land it, while one already
 * consumed by a land leaves nothing but a row to close, and announcing that as
 * a discard would describe a merge that landed as dropped.
 */
function discardPersistedParkedCandidates(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  continuesParkedRef: string | undefined;
  broadcast: PublishFn;
}): void {
  const { projectPath, projectName, sessionName, continuesParkedRef } = params;
  let parked: JobRecord[];
  try {
    parked = createJobsRepo(getStateDb()).listParkedJobRecords(
      projectName,
      sessionName,
    );
  } catch (err) {
    logger.error("merge.parked_candidate_lookup_failed", {
      sessionName,
      error: getErrorMessage(err),
    });
    return;
  }

  for (const record of parked) {
    const parkedRef =
      record.parkedRef ?? `${PARKED_MERGE_REF_PREFIX}${record.jobId}`;
    if (parkedRef === continuesParkedRef) continue;
    void endPersistedParkedCandidate({
      projectPath,
      record,
      parkedRef,
      broadcast: params.broadcast,
    });
  }
}

async function endPersistedParkedCandidate(params: {
  projectPath: string;
  record: JobRecord;
  parkedRef: string;
  broadcast: PublishFn;
}): Promise<void> {
  const { projectPath, record, parkedRef, broadcast } = params;
  let refWasLive = false;
  try {
    refWasLive = await deleteParkedMergeRef(projectPath, parkedRef);
  } catch (err) {
    logger.warn("merge.parked_ref_delete_failed", {
      jobId: record.jobId,
      parkedRef,
      error: getErrorMessage(err),
    });
  }

  logger.info("merge.parked_candidate_superseded", {
    jobId: record.jobId,
    jobType: record.jobType,
    sessionName: record.sessionName,
    parkedRef,
    fromRegistry: false,
    refWasLive,
  });

  if (refWasLive) {
    broadcastJobStatus(
      {
        ...record,
        status: "discarded",
        completedAt: new Date().toISOString(),
      },
      broadcast,
    );
    return;
  }

  try {
    createJobsRepo(getStateDb()).updateJobRecord(record.jobId, {
      status: "discarded",
    });
  } catch (err) {
    logger.error("background-jobs.persist_terminal_failed", {
      jobId: record.jobId,
      error: getErrorMessage(err),
    });
  }
}

// ============================================================
// Dispatch Guard
// ============================================================

/**
 * Validate that no active job exists for the session, acquire a
 * session lock, register the job, and broadcast "running".
 * Returns the registered job and release function on success.
 */
function prepareDispatch(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  branchName: string;
  jobType: BackgroundJob["jobType"];
  targetBranch?: string;
  decorateJob?(job: BackgroundJob): void;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  jobId?: string;
  continuesParkedRef?: string;
}): JobDispatchResult<{ job: BackgroundJob; release: () => void }> {
  const {
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType,
    targetBranch,
    decorateJob,
    broadcast = defaultJobBroadcast,
    acquireSessionLock = defaultAcquireSessionLock,
    jobId,
    continuesParkedRef,
  } = params;
  const key = sessionKey(projectPath, sessionName);
  const registry = getJobRegistry();

  // Check for existing active job
  const existing = registry.get(key);
  if (existing && existing.status === "running") {
    // Check if stale
    if (!recoverStaleJob(key, existing, broadcast)) {
      return { ok: false, error: "JOB_ALREADY_RUNNING" };
    }
  }

  // Acquire session lock. Nothing destructive may precede it: a dispatch the
  // lock refuses replaces nothing, so the candidate it would have superseded
  // has to still be landable afterwards.
  let release: () => void;
  try {
    release = acquireSessionLock(projectPath, sessionName);
  } catch {
    return { ok: false, error: "SESSION_BUSY" };
  }

  if (existing && existing.status === "ready-to-land") {
    discardSupersededParkedCandidate({
      projectPath,
      existing,
      continuesParkedRef,
      broadcast,
    });
  }
  // The registry answered for this process only; the durable rows answer for
  // every candidate parked before a restart, including the one just ended above
  // (its row is already `discarded` by now, so it is not found twice).
  discardPersistedParkedCandidates({
    projectPath,
    projectName,
    sessionName,
    continuesParkedRef,
    broadcast,
  });

  // Register the job
  const job: BackgroundJob = {
    jobId: jobId ?? randomUUID(),
    jobType,
    status: "running",
    projectName,
    sessionName,
    branchName,
    ...(targetBranch && { targetBranch }),
    startedAt: new Date().toISOString(),
  };
  decorateJob?.(job);

  registry.set(key, job);
  broadcastJobStatus(job, broadcast);
  persistJobRecord(job);

  return { ok: true, value: { job, release } };
}

// ============================================================
// Machine-Host Wiring
// ============================================================

/** Bind the dispatch guard and status broadcast to one broadcast target. */
function createDispatchHost(
  broadcast: PublishFn,
  acquireSessionLock?: AcquireSessionLockFn,
  jobId?: string,
): JobDispatchHost {
  return {
    prepare(params) {
      return prepareDispatch({
        ...params,
        broadcast,
        acquireSessionLock,
        ...(jobId !== undefined ? { jobId } : {}),
      });
    },
    publishStatus(job) {
      broadcastJobStatus(job, broadcast);
    },
    persistProgress(job) {
      markProgress(job);
      persistJobProgress(job);
    },
  };
}

/**
 * Whether a merge-family dispatch's publish also finishes the session.
 *
 * One owner because two readers consult the answer for the same job — the
 * workflow launch guard reads the job fact, the publish actor reads the machine
 * context — and they must not be able to disagree. Omitted means the
 * user-driven session merge, which is finalizing by definition; a re-entry
 * (land, conflict retry) passes forward the fact of the job it continues,
 * because a graph lane merge parked as ready-to-land is still the workflow's own
 * work when an operator lands it. A discard publishes nothing and deletes the
 * parked commit, so it finishes no session whatever it was asked for.
 */
function resolveFinalizeSessionOnPublish(input: {
  entryMode?: MergeEntryMode;
  requested?: boolean;
}): boolean {
  if (input.entryMode === "discard") return false;
  return input.requested ?? true;
}

/** Merge-machine → BackgroundJob projection (merge and resolve-conflicts). */
const mergeSubscription: JobSubscriptionConfig<MergeContext, MergeOutput> = {
  phaseOf(context) {
    return context.phase ?? undefined;
  },
  projectActiveSnapshot(job, context) {
    const candidateValidation = context.candidateValidation ?? undefined;
    if (candidateValidation === undefined) return false;
    if (
      job.candidateValidation?.validationRef ===
      candidateValidation.validationRef
    ) {
      return false;
    }
    job.candidateValidation = candidateValidation;
    return true;
  },
  mapOutput(job, output, context) {
    job.status = output.status;
    job.mergeHash = output.mergeHash ?? undefined;
    job.commitHash = output.commitHash ?? undefined;
    job.errorMessage = output.error ?? undefined;
    job.phase = output.phase ?? undefined;
    job.preparedSha = output.preparedSha ?? undefined;
    job.expectedTargetSha = output.expectedTargetSha ?? undefined;
    job.parkedRef = output.parkedRef ?? undefined;
    job.refreshWarning = output.refreshWarning ?? undefined;
    job.upToDate = output.upToDate === true ? true : undefined;
    job.executionId = context.executionId ?? undefined;
    job.specExecutionId = context.specExecutionId ?? undefined;
    job.candidateValidation = output.candidateValidation ?? undefined;
    job.haltReason = output.haltReason ?? undefined;

    if (output.conflictFiles.length > 0) {
      job.conflictFiles = output.conflictFiles;
      job.conflictCount = output.conflictFiles.length;
    }

    // Store conflict analysis if available
    if (output.conflictAnalysis) {
      storeConflictAnalysis(
        context.projectPath,
        context.sessionName,
        job.jobId,
        context.projectName,
        output.conflictAnalysis,
      );
    }

    // Attach the intent brief to the landed commit so future merges can
    // explain this commit to their conflict resolvers. The one recording site
    // for every merge-family host, attributed from the dispatch's own fact.
    // Non-throwing.
    if (
      output.status === "completed" &&
      output.mergeHash &&
      context.resolutionContext
    ) {
      try {
        createMergeIntentsRepo(getStateDb()).recordMergeIntent({
          projectPath: context.projectPath,
          commitSha: output.mergeHash,
          intent: context.resolutionContext,
          source: job.intentSource ?? "session-merge",
        });
      } catch (err) {
        logger.error("background-jobs.record_merge_intent_failed", {
          jobId: job.jobId,
          mergeHash: output.mergeHash,
          error: getErrorMessage(err),
        });
      }
    }
  },
};

/** Commit-machine → BackgroundJob projection. */
const commitSubscription: JobSubscriptionConfig<CommitContext, CommitOutput> = {
  phaseOf(context) {
    return context.phase ?? undefined;
  },
  mapOutput(job, output) {
    job.status = output.status;
    job.commitHash = output.commitHash ?? undefined;
    job.errorMessage = output.error ?? undefined;
    job.phase = undefined;
  },
};

/** Rebase-machine → BackgroundJob projection. */
const rebaseSubscription: JobSubscriptionConfig<RebaseContext, RebaseOutput> = {
  phaseOf(context) {
    return context.phase ?? undefined;
  },
  mapOutput(job, output) {
    job.status = output.status;
    job.errorMessage = output.error ?? undefined;
    job.phase = output.phase ?? undefined;
    if (output.conflictFiles.length > 0) {
      job.conflictFiles = output.conflictFiles;
      job.conflictCount = output.conflictFiles.length;
    }
  },
};

// ============================================================
// Public API — Dispatch
// ============================================================

/**
 * Dispatch a merge job using the Smart Merge XState machine.
 * The machine handles: commit uncommitted → merge main → detect/resolve
 * conflicts → validate → fix validation → squash merge.
 */
export interface DispatchMergeParams {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  autoResolve: boolean;
  targetBranch?: string;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: MergeMachineType;
  entryMode?: "merge" | "land" | "discard";
  preparedSha?: string;
  expectedTargetSha?: string;
  parkedRef?: string;
  /** Agent-written intent notes for a conflict-resolution turn. */
  resolutionContext?: string;
  executionId?: string;
  specExecutionId?: string;
  finalPublish?: boolean;
  candidateValidation?: BackgroundJob["candidateValidation"];
  /**
   * Whether this job's publish also finishes the session. Omitted means the
   * user-driven session merge; skipMarkMerged can suppress its cleanup. A re-entry
   * (land, conflict retry) passes the fact forward from the job it continues,
   * because a graph lane merge parked as ready-to-land is still the workflow's
   * own work when an operator lands it.
   */
  finalizeSessionOnPublish?: boolean;
  skipMarkMerged?: boolean;
}

/**
 * A merge refused at dispatch by the registered association resolver: the
 * session hosts spec-execution state the delivery gate could never evaluate
 * from this merge (not started, or ambiguous). No job is created.
 */
export interface MergeAssociationRefusedError {
  code: "MERGE_ASSOCIATION_REFUSED";
  reason: string;
  instruction: string;
}

export type MergeDispatchError =
  | JobDispatchError
  | MergeAssociationRefusedError;

export type MergeDispatchResult =
  | { ok: true; value: { jobId: string } }
  | { ok: false; error: MergeDispatchError };

/**
 * Resolve merge association once, at dispatch. Explicit caller provenance is
 * authoritative; otherwise the registered resolver decides, and its refusal
 * aborts dispatch before any job or lock exists.
 */
function resolveDispatchProvenance(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  targetBranch?: string;
  executionId?: string;
  specExecutionId?: string;
  finalPublish?: boolean;
}):
  | {
      ok: true;
      executionId?: string;
      specExecutionId?: string;
      finalPublish?: boolean;
    }
  | { ok: false; error: MergeAssociationRefusedError } {
  if (input.executionId !== undefined || input.specExecutionId !== undefined) {
    return {
      ok: true,
      executionId: input.executionId,
      specExecutionId: input.specExecutionId,
      finalPublish: input.finalPublish,
    };
  }
  const association = resolveRegisteredMergeAssociation({
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    ...(input.targetBranch !== undefined && {
      targetBranch: input.targetBranch,
    }),
  });
  if (association.kind === "refused") {
    logger.warn("merge.association_refused", {
      sessionName: input.sessionName,
      reason: association.reason,
    });
    return {
      ok: false,
      error: {
        code: "MERGE_ASSOCIATION_REFUSED",
        reason: association.reason,
        instruction: association.instruction,
      },
    };
  }
  if (association.kind === "linked") {
    return {
      ok: true,
      executionId: association.executionId,
      specExecutionId: association.specExecutionId,
      finalPublish: association.finalPublish,
    };
  }
  return { ok: true, finalPublish: input.finalPublish };
}

export interface RegisteredMergeJobInput {
  machine: MergeMachineType;
  input: MergeInput;
  broadcast?: PublishFn;
  onPhase?(phase: MergePhase): void;
}

/**
 * Run a graph-owned merge through the canonical background-job host while the
 * graph join retains ownership of the outer git locks. The registered job is
 * what lets a ready-to-land candidate re-enter later through the session merge
 * surface with its execution linkage and validation fact intact.
 */
export function runRegisteredMergeJob(
  params: RegisteredMergeJobInput,
): Promise<MergeOutput> {
  return new Promise<MergeOutput>((resolve, reject) => {
    const { input } = params;
    const result = dispatchMachineJob<MergeContext, MergeOutput>({
      jobType: "merge",
      session: {
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        branchName: input.branchName,
        targetBranch: input.targetBranch,
      },
      host: createDispatchHost(
        params.broadcast ?? defaultJobBroadcast,
        () => () => {},
        input.jobId,
      ),
      ...(input.parkedRef !== undefined
        ? { continuesParkedRef: input.parkedRef }
        : {}),
      decorateJob(job) {
        if (input.resolutionContext) {
          job.resolutionContext = input.resolutionContext;
        }
        if (input.executionId) job.executionId = input.executionId;
        if (input.specExecutionId) job.specExecutionId = input.specExecutionId;
        if (input.finalPublish === true) job.finalPublish = true;
        job.finalizeSessionOnPublish = resolveFinalizeSessionOnPublish({
          ...(input.entryMode !== undefined
            ? { entryMode: input.entryMode }
            : {}),
          ...(input.finalizeSessionOnPublish !== undefined
            ? { requested: input.finalizeSessionOnPublish }
            : {}),
        });
        // This host exists for graph-owned merges; the lane's intent brief is
        // the join's, not a session merge's.
        job.intentSource = "graph-join";
        if (input.candidateValidation) {
          job.candidateValidation = input.candidateValidation;
        }
      },
      logStart(job) {
        logger.info("graph-merge.start", {
          jobId: job.jobId,
          sessionName: input.sessionName,
          branchName: input.branchName,
          targetBranch: input.targetBranch,
          executionId: input.executionId,
          specExecutionId: input.specExecutionId,
          finalPublish: input.finalPublish === true,
        });
      },
      createJobActor() {
        return createActor(params.machine, { input });
      },
      subscription: mergeSubscription,
      callbacks: {
        onPhaseChange(_phase, context) {
          if (context.phase !== null) params.onPhase?.(context.phase);
        },
        onComplete(output) {
          resolve(output);
        },
        onError(error) {
          reject(error);
        },
      },
    });
    if (!result.ok) {
      reject(
        new Error(
          `Graph merge job ${input.jobId} could not start: ${result.error}`,
        ),
      );
    }
  });
}

export function dispatchMergeJob(
  params: DispatchMergeParams,
): MergeDispatchResult {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    autoResolve,
    targetBranch,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine: injectedMachine,
    entryMode,
    preparedSha,
    expectedTargetSha,
    parkedRef,
    resolutionContext,
    executionId,
    specExecutionId,
    finalPublish,
    candidateValidation,
  } = params;
  const machine =
    injectedMachine ?? provideRegisteredDeliveryGate(mergeMachine);

  const provenance = resolveDispatchProvenance({
    projectPath,
    projectName,
    sessionName,
    ...(targetBranch !== undefined && { targetBranch }),
    ...(executionId !== undefined && { executionId }),
    ...(specExecutionId !== undefined && { specExecutionId }),
    ...(finalPublish !== undefined && { finalPublish }),
  });
  if (!provenance.ok) return { ok: false, error: provenance.error };
  const resolvedExecutionId = provenance.executionId;
  const resolvedSpecExecutionId = provenance.specExecutionId;
  const resolvedFinalPublish = provenance.finalPublish;
  // Decided once and threaded into BOTH the job fact and the machine input, so
  // the launch guard's reader and the publish actor's gate read one decision.
  const finalizeSessionOnPublish = resolveFinalizeSessionOnPublish({
    ...(entryMode !== undefined ? { entryMode } : {}),
    ...(params.finalizeSessionOnPublish !== undefined
      ? { requested: params.finalizeSessionOnPublish }
      : {}),
  });

  return dispatchMachineJob<MergeContext, MergeOutput>({
    jobType: "merge",
    session: {
      projectPath,
      projectName,
      sessionName,
      branchName,
      targetBranch,
    },
    host: createDispatchHost(broadcast, acquireSessionLock),
    // A land or discard re-entry continues the parked candidate rather than
    // superseding it, so the host must not drop the ref it is about to use.
    ...(parkedRef !== undefined ? { continuesParkedRef: parkedRef } : {}),
    decorateJob(job) {
      if (resolutionContext) job.resolutionContext = resolutionContext;
      if (resolvedExecutionId) job.executionId = resolvedExecutionId;
      if (resolvedSpecExecutionId)
        job.specExecutionId = resolvedSpecExecutionId;
      if (resolvedFinalPublish === true) job.finalPublish = true;
      job.finalizeSessionOnPublish = finalizeSessionOnPublish;
      job.skipMarkMerged = params.skipMarkMerged ?? false;
      job.intentSource = "session-merge";
      if (candidateValidation) job.candidateValidation = candidateValidation;
    },
    logStart(job) {
      logger.info("merge.start", {
        jobId: job.jobId,
        sessionName,
        worktreePath,
        branchName,
        autoResolve,
        entryMode: entryMode ?? "merge",
        executionId: resolvedExecutionId,
        finalPublish: resolvedFinalPublish === true,
        skipMarkMerged: params.skipMarkMerged ?? false,
      });
    },
    createJobActor(jobId) {
      const input: MergeInput = {
        jobId,
        projectPath,
        projectName,
        sessionName,
        worktreePath,
        branchName,
        message,
        autoResolve,
        validationMode: {
          mode: "run",
          source: "smart_merge",
          selection: { mode: "project-pre-merge" },
        },
        jobType: "merge",
        targetBranch,
        finalizeSessionOnPublish,
        skipMarkMerged: params.skipMarkMerged ?? false,
        ...(entryMode && { entryMode }),
        ...(preparedSha && { preparedSha }),
        ...(expectedTargetSha && { expectedTargetSha }),
        ...(parkedRef && { parkedRef }),
        ...(resolutionContext && { resolutionContext }),
        ...(resolvedExecutionId && { executionId: resolvedExecutionId }),
        ...(resolvedSpecExecutionId && {
          specExecutionId: resolvedSpecExecutionId,
        }),
        ...(resolvedFinalPublish !== undefined && {
          finalPublish: resolvedFinalPublish,
        }),
        ...(candidateValidation && { candidateValidation }),
      };
      return createActor(machine, { input });
    },
    subscription: mergeSubscription,
  });
}

/**
 * Dispatch a commit job using the Smart Commit XState machine.
 * The machine handles: commit → validate → auto-fix validation → re-validate.
 */
export function dispatchCommitJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  targetBranch?: string;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: CommitMachineType;
}): JobDispatchResult<{ jobId: string }> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    targetBranch,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine = commitMachine,
  } = params;

  return dispatchMachineJob<CommitContext, CommitOutput>({
    jobType: "commit",
    session: { projectPath, projectName, sessionName, branchName },
    host: createDispatchHost(broadcast, acquireSessionLock),
    logStart(job) {
      logger.info("commit.start", {
        jobId: job.jobId,
        sessionName,
        worktreePath,
      });
    },
    createJobActor(jobId) {
      const input: CommitInput = {
        jobId,
        projectPath,
        projectName,
        sessionName,
        worktreePath,
        branchName,
        message,
        validationMode: {
          mode: "run",
          source: "smart_commit",
          selection: { mode: "project-pre-merge" },
        },
        targetBranch,
      };
      return createActor(machine, { input });
    },
    subscription: commitSubscription,
  });
}

/**
 * Dispatch a resolve-conflicts job using the Smart Merge XState machine
 * with jobType "resolve-conflicts". The routing state skips directly to
 * conflict resolution, then proceeds through validation and squash merge.
 */
export function dispatchResolveConflictsJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  mergeMessage: string;
  decisions?: ConflictDecisionInput[];
  /**
   * Files the conflicted merge this retry resumes reported. The retry's own
   * run never sees that merge, so without them its post-resolution
   * ground-truth check has no list of files to hold the agent to.
   */
  conflictFiles?: string[];
  targetBranch?: string;
  resolutionContext?: string;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: MergeMachineType;
  executionId?: string;
  specExecutionId?: string;
  finalPublish?: boolean;
  candidateValidation?: BackgroundJob["candidateValidation"];
  /** The resumed merge's own fact; see {@link DispatchMergeParams}. */
  finalizeSessionOnPublish?: boolean;
  skipMarkMerged?: boolean;
}): MergeDispatchResult {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    mergeMessage,
    decisions,
    conflictFiles,
    targetBranch,
    resolutionContext,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine: injectedMachine,
    executionId,
    specExecutionId,
    finalPublish,
    candidateValidation,
  } = params;
  const machine =
    injectedMachine ?? provideRegisteredDeliveryGate(mergeMachine);

  const provenance = resolveDispatchProvenance({
    projectPath,
    projectName,
    sessionName,
    ...(targetBranch !== undefined && { targetBranch }),
    ...(executionId !== undefined && { executionId }),
    ...(specExecutionId !== undefined && { specExecutionId }),
    ...(finalPublish !== undefined && { finalPublish }),
  });
  if (!provenance.ok) return { ok: false, error: provenance.error };
  const resolvedExecutionId = provenance.executionId;
  const resolvedSpecExecutionId = provenance.specExecutionId;
  const resolvedFinalPublish = provenance.finalPublish;
  // Conflict resolution continues a merge that already exists, so its publish
  // finalizes the session exactly as the merge it resumes would have — which is
  // not at all when the conflicted merge was a graph lane's.
  const finalizeSessionOnPublish = resolveFinalizeSessionOnPublish({
    ...(params.finalizeSessionOnPublish !== undefined
      ? { requested: params.finalizeSessionOnPublish }
      : {}),
  });

  return dispatchMachineJob<MergeContext, MergeOutput>({
    jobType: "resolve-conflicts",
    session: {
      projectPath,
      projectName,
      sessionName,
      branchName,
      targetBranch,
    },
    host: createDispatchHost(broadcast, acquireSessionLock),
    decorateJob(job) {
      if (resolutionContext) job.resolutionContext = resolutionContext;
      if (resolvedExecutionId) job.executionId = resolvedExecutionId;
      if (resolvedSpecExecutionId)
        job.specExecutionId = resolvedSpecExecutionId;
      if (resolvedFinalPublish === true) job.finalPublish = true;
      job.finalizeSessionOnPublish = finalizeSessionOnPublish;
      job.skipMarkMerged = params.skipMarkMerged ?? false;
      job.intentSource = "session-merge";
      if (candidateValidation) job.candidateValidation = candidateValidation;
    },
    logStart(job) {
      logger.info("resolve-conflicts.start", {
        jobId: job.jobId,
        sessionName,
        resolutionContextLength: resolutionContext?.length ?? 0,
        executionId: resolvedExecutionId,
        finalPublish: resolvedFinalPublish === true,
        skipMarkMerged: params.skipMarkMerged ?? false,
      });
    },
    createJobActor(jobId) {
      const input: MergeInput = {
        jobId,
        projectPath,
        projectName,
        sessionName,
        worktreePath,
        branchName,
        message: mergeMessage,
        // The conflicts are the operator's decision to re-run, not this job's
        // to detect; the fix loop still belongs to it, because the merge it
        // resumes was dispatched with one.
        autoResolve: false,
        autoFixValidation: true,
        validationMode: {
          mode: "run",
          source: "smart_merge",
          selection: { mode: "project-pre-merge" },
        },
        jobType: "resolve-conflicts",
        decisions,
        ...(conflictFiles && { conflictFiles }),
        targetBranch,
        finalizeSessionOnPublish,
        skipMarkMerged: params.skipMarkMerged ?? false,
        ...(resolutionContext && { resolutionContext }),
        ...(resolvedExecutionId && { executionId: resolvedExecutionId }),
        ...(resolvedSpecExecutionId && {
          specExecutionId: resolvedSpecExecutionId,
        }),
        ...(resolvedFinalPublish !== undefined && {
          finalPublish: resolvedFinalPublish,
        }),
        ...(candidateValidation && { candidateValidation }),
      };
      return createActor(machine, { input });
    },
    subscription: mergeSubscription,
  });
}

/**
 * Dispatch a rebase job using the Rebase XState machine. The machine replays
 * the session branch onto the target, auto-resolving conflicts per replayed
 * commit; it never lands into or otherwise modifies the target branch.
 */
export interface DispatchRebaseParams {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  /** Where to replay the session's commits onto. */
  onto: RebaseOnto;
  /** Human label for the target (`main` / `origin/main`), shown in notices. */
  targetLabel: string;
  conversationId?: string;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: RebaseMachineType;
  maxConflictRounds?: number;
}

export function dispatchRebaseJob(
  params: DispatchRebaseParams,
): JobDispatchResult<{ jobId: string }> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    onto,
    targetLabel,
    conversationId,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine = rebaseMachine,
    maxConflictRounds,
  } = params;

  return dispatchMachineJob<RebaseContext, RebaseOutput>({
    jobType: "rebase",
    session: {
      projectPath,
      projectName,
      sessionName,
      branchName,
      targetBranch: targetLabel,
    },
    host: createDispatchHost(broadcast, acquireSessionLock),
    logStart(job) {
      logger.info("rebase.start", {
        jobId: job.jobId,
        sessionName,
        worktreePath,
        branchName,
        targetLabel,
      });
    },
    createJobActor(jobId) {
      const input: RebaseInput = {
        jobId,
        projectPath,
        projectName,
        sessionName,
        worktreePath,
        branchName,
        onto,
        ...(conversationId && { conversationId }),
        ...(maxConflictRounds && { maxConflictRounds }),
      };
      return createActor(machine, { input });
    },
    subscription: rebaseSubscription,
  });
}

// ============================================================
// Internal Helpers
// ============================================================

function storeConflictAnalysis(
  projectPath: string,
  sessionName: string,
  jobId: string,
  projectName: string,
  conflicts: ConflictAnalysis["conflicts"],
): void {
  const key = sessionKey(projectPath, sessionName);
  getConflictAnalysisRegistry().set(key, {
    jobId,
    projectName,
    sessionName,
    conflicts,
  });
}

// ============================================================
// Testing Helper
// ============================================================

/** Reset all in-memory state — for test isolation only */
export function _resetForTesting(): void {
  getJobRegistry().clear();
  getConflictAnalysisRegistry().clear();
  _resetJobActorRegistryForTesting();
}

export type { JobDispatchError };
