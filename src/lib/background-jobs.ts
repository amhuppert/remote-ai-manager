/**
 * Background job lifecycle management for async merge, commit,
 * and conflict resolution operations.
 *
 * Jobs are dispatched synchronously (fire-and-forget) using XState actors.
 * Merge and resolve-conflicts jobs use the mergeMachine (Smart Merge pipeline).
 * Commit jobs use a simple fromPromise actor.
 *
 * Status changes are broadcast via SSE so the UI can track progress in real
 * time. Storage uses globalThis Maps (HMR-safe singleton pattern) keyed by
 * "projectPath::sessionName".
 */

import { randomUUID } from "node:crypto";
import { createActor, fromPromise } from "xstate";
import { acquireSessionLock as defaultAcquireSessionLock } from "./lock";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "./sse-broadcaster";
import { createLogger } from "./logging";
import {
  createJobRecord,
  updateJobRecord,
  createNotification,
  deriveNotificationType,
  deriveNotificationTitle,
} from "./notification-db";
import { mergeMachine, type MergeMachineType } from "./workflows/merge/machine";
import type {
  MergeInput,
  MergeContext,
  MergeOutput,
} from "./workflows/merge/types";
import { getErrorMessage } from "@/lib/errors";
import { assertNever } from "./assert-never";
import type { BackgroundJob, ConflictAnalysis, JobStatusEvent } from "@/types";
import type { ConflictDecisionInput } from "@/lib/schemas";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("background-jobs");

// ============================================================
// Constants
// ============================================================

/** Jobs running longer than this are considered stale (10 minutes) */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================
// Result Type
// ============================================================

type JobDispatchError = "SESSION_BUSY" | "JOB_ALREADY_RUNNING";
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type AcquireSessionLockFn = (
  projectPath: string,
  sessionName: string,
) => () => void;

/** Default commit function — uses dynamic import for tree-shaking */
const defaultCommitFn = async (
  worktreePath: string,
  message: string,
): Promise<{ hash: string }> => {
  const { commitChanges } = await import("@/lib/git-operations");
  return commitChanges(worktreePath, message);
};

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

function broadcastJobStatus(
  job: BackgroundJob,
  broadcast: BroadcastFn = defaultBroadcast,
): void {
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
  };
  broadcast(event);

  // On terminal state: persist to DB and create notification
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "conflicts"
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
    createJobRecord(job);
  } catch (err) {
    logger.error("background-jobs.persist_job_record_failed", {
      jobId: job.jobId,
      error: getErrorMessage(err),
    });
  }
}

/** Persist terminal state to DB and create a notification. Non-throwing. */
function persistTerminalState(job: BackgroundJob): void {
  try {
    updateJobRecord(job.jobId, {
      status: job.status,
      mergeHash: job.mergeHash,
      commitHash: job.commitHash,
      conflictCount: job.conflictCount,
      conflictFiles: job.conflictFiles,
      errorMessage: job.errorMessage,
    });

    const notifType = deriveNotificationType(job.jobType, job.status);
    const title = deriveNotificationTitle(notifType);
    const message = buildNotificationMessage(job);

    createNotification({
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
      if (job.jobType === "merge")
        return `Branch ${branch} merged into ${target}${job.mergeHash ? ` (${job.mergeHash.slice(0, 7)})` : ""}`;
      if (job.jobType === "commit")
        return `Changes committed${job.commitHash ? ` (${job.commitHash.slice(0, 7)})` : ""}`;
      return `Conflicts on ${branch} resolved successfully (target: ${target})`;
    case "conflicts":
      return `${job.conflictCount ?? 0} conflict${(job.conflictCount ?? 0) !== 1 ? "s" : ""} detected merging ${branch} into ${target}`;
    case "failed":
      return job.errorMessage ?? `${job.jobType} failed on ${branch}`;
    case "running":
      return `${job.jobType} on ${branch}`;
    default:
      return assertNever(job.status);
  }
}

// ============================================================
// Stale Job Detection
// ============================================================

/**
 * Check if a job is stale (running longer than JOB_TIMEOUT_MS).
 * If stale, force-transition to "failed" and return true.
 */
function recoverStaleJob(key: string, existing: BackgroundJob): boolean {
  if (existing.status !== "running") return false;

  const elapsed = Date.now() - new Date(existing.startedAt).getTime();
  if (elapsed < JOB_TIMEOUT_MS) return false;

  logger.warn("background-jobs.stale_recovery", {
    jobId: existing.jobId,
    jobType: existing.jobType,
    sessionName: existing.sessionName,
    elapsedMs: elapsed,
  });

  existing.status = "failed";
  existing.errorMessage = "Job timed out (stale recovery)";
  existing.completedAt = new Date().toISOString();

  // Remove the stale job entry so a new one can be registered
  getJobRegistry().delete(key);

  return true;
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
  broadcast?: BroadcastFn;
  acquireSessionLock?: AcquireSessionLockFn;
}): Result<{ job: BackgroundJob; release: () => void }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType,
    targetBranch,
    broadcast = defaultBroadcast,
    acquireSessionLock = defaultAcquireSessionLock,
  } = params;
  const key = sessionKey(projectPath, sessionName);
  const registry = getJobRegistry();

  // Check for existing active job
  const existing = registry.get(key);
  if (existing && existing.status === "running") {
    // Check if stale
    if (!recoverStaleJob(key, existing)) {
      return { ok: false, error: "JOB_ALREADY_RUNNING" };
    }
  }

  // Acquire session lock
  let release: () => void;
  try {
    release = acquireSessionLock(projectPath, sessionName);
  } catch {
    return { ok: false, error: "SESSION_BUSY" };
  }

  // Register the job
  const job: BackgroundJob = {
    jobId: randomUUID(),
    jobType,
    status: "running",
    projectName,
    sessionName,
    branchName,
    ...(targetBranch && { targetBranch }),
    startedAt: new Date().toISOString(),
  };

  registry.set(key, job);
  broadcastJobStatus(job, broadcast);
  persistJobRecord(job);

  return { ok: true, value: { job, release } };
}

// ============================================================
// XState Actor Helpers
// ============================================================

/**
 * Subscribe to a merge machine actor and update the BackgroundJob registry
 * on state changes and completion. Releases the session lock on terminal state.
 */
function subscribeMergeActor(
  actor: ReturnType<typeof createActor<MergeMachineType>>,
  job: BackgroundJob,
  release: () => void,
  broadcast: BroadcastFn = defaultBroadcast,
): void {
  let lastPhase: string | undefined = undefined;

  actor.subscribe({
    next(snapshot) {
      if (snapshot.status === "active") {
        const phase = (snapshot.context as MergeContext).phase ?? undefined;
        if (phase !== lastPhase) {
          lastPhase = phase;
          job.phase = phase;
          broadcastJobStatus(job, broadcast);
        }
      }
    },
    complete() {
      const snapshot = actor.getSnapshot();
      const output = snapshot.output as MergeOutput;
      const ctx = snapshot.context as MergeContext;

      // Map output → BackgroundJob
      job.status = output.status;
      job.mergeHash = output.mergeHash ?? undefined;
      job.commitHash = output.commitHash ?? undefined;
      job.errorMessage = output.error ?? undefined;
      job.phase = undefined;
      job.completedAt = new Date().toISOString();

      if (output.conflictFiles.length > 0) {
        job.conflictFiles = output.conflictFiles;
        job.conflictCount = output.conflictFiles.length;
      }

      // Store conflict analysis if available
      if (output.conflictAnalysis) {
        storeConflictAnalysis(
          ctx.projectPath,
          ctx.sessionName,
          job.jobId,
          ctx.projectName,
          output.conflictAnalysis,
        );
      }

      broadcastJobStatus(job, broadcast);
      release();
    },
    error(err) {
      // Shouldn't happen — machine handles errors internally as "failed" state.
      // But handle defensively.
      job.status = "failed";
      job.errorMessage = err instanceof Error ? err.message : "Unknown error";
      job.phase = undefined;
      job.completedAt = new Date().toISOString();
      broadcastJobStatus(job, broadcast);
      release();
    },
  });
}

// ============================================================
// Public API — Dispatch
// ============================================================

/**
 * Dispatch a merge job using the Smart Merge XState machine.
 * The machine handles: commit uncommitted → merge main → detect/resolve
 * conflicts → validate → fix validation → squash merge.
 */
export function dispatchMergeJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  autoResolve: boolean;
  targetBranch?: string;
  targetWorktreePath?: string;
  broadcast?: BroadcastFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: MergeMachineType;
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    autoResolve,
    targetBranch,
    targetWorktreePath,
    broadcast = defaultBroadcast,
    acquireSessionLock,
    machine = mergeMachine,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "merge",
    targetBranch,
    broadcast,
    acquireSessionLock,
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  logger.info("merge.start", {
    jobId: job.jobId,
    sessionName,
    worktreePath,
    branchName,
    autoResolve,
  });

  // Create and start the merge machine actor
  const input: MergeInput = {
    jobId: job.jobId,
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    autoResolve,
    jobType: "merge",
    targetBranch,
    targetWorktreePath,
  };

  const actor = createActor(
    machine.provide({
      actions: { onTerminal: () => {} },
    }),
    { input },
  );

  subscribeMergeActor(actor, job, release, broadcast);
  actor.start();

  return { ok: true, value: { jobId: job.jobId } };
}

/**
 * Dispatch a commit job using a fromPromise XState actor.
 */
export function dispatchCommitJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  broadcast?: BroadcastFn;
  acquireSessionLock?: AcquireSessionLockFn;
  commitFn?: (
    worktreePath: string,
    message: string,
  ) => Promise<{ hash: string }>;
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    broadcast = defaultBroadcast,
    acquireSessionLock,
    commitFn = defaultCommitFn,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "commit",
    broadcast,
    acquireSessionLock,
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  logger.info("commit.start", {
    jobId: job.jobId,
    sessionName,
    worktreePath,
  });

  // Create a simple fromPromise actor for the commit operation
  const commitLogic = fromPromise<
    { hash: string },
    { worktreePath: string; message: string }
  >(async ({ input: commitInput }) => {
    return commitFn(commitInput.worktreePath, commitInput.message);
  });

  const actor = createActor(commitLogic, {
    input: { worktreePath, message },
  });

  actor.subscribe({
    next() {
      // No intermediate states for commit
    },
    complete() {
      const snapshot = actor.getSnapshot();
      const output = snapshot.output as { hash: string };
      job.status = "completed";
      job.commitHash = output.hash;
      job.completedAt = new Date().toISOString();
      logger.info("commit.completed", { jobId: job.jobId, hash: output.hash });
      broadcastJobStatus(job, broadcast);
      release();
    },
    error(err) {
      job.status = "failed";
      const errObj = err as Error & { gitOutput?: string };
      const parts: string[] = [errObj.message ?? "Unknown error"];
      if (errObj.gitOutput) {
        parts.push(errObj.gitOutput);
      }
      job.errorMessage = parts.join("\n");
      job.completedAt = new Date().toISOString();
      logger.error("commit.failed", {
        jobId: job.jobId,
        error: job.errorMessage,
      });
      broadcastJobStatus(job, broadcast);
      release();
    },
  });

  actor.start();

  return { ok: true, value: { jobId: job.jobId } };
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
  targetBranch?: string;
  targetWorktreePath?: string;
  broadcast?: BroadcastFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: MergeMachineType;
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    mergeMessage,
    decisions,
    targetBranch,
    targetWorktreePath,
    broadcast = defaultBroadcast,
    acquireSessionLock,
    machine = mergeMachine,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "resolve-conflicts",
    targetBranch,
    broadcast,
    acquireSessionLock,
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  logger.info("resolve-conflicts.start", {
    jobId: job.jobId,
    sessionName,
  });

  // Create the merge machine with resolve-conflicts routing
  const input: MergeInput = {
    jobId: job.jobId,
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message: mergeMessage,
    autoResolve: false,
    jobType: "resolve-conflicts",
    decisions,
    targetBranch,
    targetWorktreePath,
  };

  const actor = createActor(
    machine.provide({
      actions: { onTerminal: () => {} },
    }),
    { input },
  );

  subscribeMergeActor(actor, job, release, broadcast);
  actor.start();

  return { ok: true, value: { jobId: job.jobId } };
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
}
