/**
 * Background job lifecycle management for async merge, commit,
 * and conflict resolution operations.
 *
 * Jobs are dispatched synchronously (fire-and-forget) and run in
 * un-awaited Promises. Status changes are broadcast via SSE so the
 * UI can track progress in real time.
 *
 * Storage uses globalThis Maps (HMR-safe singleton pattern) keyed by
 * "projectPath::sessionName".
 */

import { randomUUID } from "node:crypto";
import { acquireSessionLock, acquireProjectLock } from "./lock";
import {
  mergeMainIntoFeature,
  squashMerge,
  commitChanges,
  hasUncommittedChanges,
} from "./git-operations";
import { resolveConflicts } from "./conflict-resolution";
import { fixValidationErrors } from "./validation-fix";
import { runPreMergeValidation } from "./repo-config";
import { readConfig } from "./config";
import { broadcast } from "./sse-broadcaster";
import { setSessionFinished } from "./state";
import { stopAllForSession } from "./dev-server-registry";
import { createLogger } from "./logging";
import {
  createJobRecord,
  updateJobRecord,
  createNotification,
  deriveNotificationType,
  deriveNotificationTitle,
} from "./notification-db";
import { getErrorMessage } from "@/lib/errors";
import type { BackgroundJob, ConflictAnalysis, JobStatusEvent } from "@/types";
import type { ConflictDecisionInput } from "@/lib/schemas";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("background-jobs");

// ============================================================
// Constants
// ============================================================

/** Jobs running longer than this are considered stale (10 minutes) */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Max wait time for project lock retry (30 seconds) */
const PROJECT_LOCK_MAX_WAIT_MS = 30_000;

/** Retry interval for project lock acquisition */
const PROJECT_LOCK_RETRY_INTERVAL_MS = 100;

// ============================================================
// Result Type
// ============================================================

type JobDispatchError = "SESSION_BUSY" | "JOB_ALREADY_RUNNING";
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

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

function broadcastJobStatus(job: BackgroundJob): void {
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
  switch (job.status) {
    case "completed":
      if (job.jobType === "merge")
        return `Branch ${branch} merged successfully${job.mergeHash ? ` (${job.mergeHash.slice(0, 7)})` : ""}`;
      if (job.jobType === "commit")
        return `Changes committed${job.commitHash ? ` (${job.commitHash.slice(0, 7)})` : ""}`;
      return `Conflicts on ${branch} resolved successfully`;
    case "conflicts":
      return `${job.conflictCount ?? 0} conflict${(job.conflictCount ?? 0) !== 1 ? "s" : ""} detected during merge of ${branch}`;
    case "failed":
      return job.errorMessage ?? `${job.jobType} failed on ${branch}`;
    default:
      return `${job.jobType} on ${branch}`;
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
// Project Lock with Retry
// ============================================================

async function acquireProjectLockWithRetry(
  projectPath: string,
): Promise<() => void> {
  const start = Date.now();
  while (Date.now() - start < PROJECT_LOCK_MAX_WAIT_MS) {
    try {
      return acquireProjectLock(projectPath);
    } catch {
      await new Promise((r) => setTimeout(r, PROJECT_LOCK_RETRY_INTERVAL_MS));
    }
  }
  throw new Error(
    "Another merge is in progress for this project. Please retry.",
  );
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
}): Result<{ job: BackgroundJob; release: () => void }, JobDispatchError> {
  const { projectPath, projectName, sessionName, branchName, jobType } = params;
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
    startedAt: new Date().toISOString(),
  };

  registry.set(key, job);
  broadcastJobStatus(job);
  persistJobRecord(job);

  return { ok: true, value: { job, release } };
}

// ============================================================
// Phase 2: Squash Merge (shared by merge and resolve-conflicts)
// ============================================================

async function executePhase2(
  job: BackgroundJob,
  projectPath: string,
  branchName: string,
  message: string,
  sessionName: string,
): Promise<void> {
  const releaseProject = await acquireProjectLockWithRetry(projectPath);
  try {
    const { mergeHash } = await squashMerge(projectPath, branchName, message);
    job.mergeHash = mergeHash;
  } finally {
    releaseProject();
  }

  // Stop all dev servers before marking session as finished (best-effort)
  try {
    await stopAllForSession({ projectPath, sessionName });
  } catch {
    // best-effort: don't block merge
  }

  await setSessionFinished(projectPath, sessionName);
}

// ============================================================
// Validation with Auto-Recovery
// ============================================================

/**
 * Run pre-merge validation with optional auto-recovery.
 *
 * If validation fails and autoResolve is true, invokes Claude to fix
 * the issues and re-runs validation once. If the retry also fails,
 * the original error is thrown.
 */
async function runValidationWithRecovery(params: {
  job: BackgroundJob;
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  timeoutMs: number;
  autoResolve: boolean;
}): Promise<void> {
  const {
    job,
    projectPath,
    worktreePath,
    sessionName,
    branchName,
    timeoutMs,
    autoResolve,
  } = params;

  job.phase = "validating";
  broadcastJobStatus(job);

  try {
    await runPreMergeValidation({
      projectPath,
      worktreePath,
      sessionName,
      branchName,
      timeoutMs,
    });
    return; // Validation passed on first try
  } catch (err) {
    if (!autoResolve) throw err; // No recovery — re-throw

    const errObj = err as Error & { gitOutput?: string };
    const validationOutput = [errObj.message, errObj.gitOutput]
      .filter(Boolean)
      .join("\n");

    logger.info("merge.validation_failed_attempting_fix", {
      jobId: job.jobId,
      sessionName,
    });

    // Broadcast that we're fixing validation errors
    job.phase = "fixing-validation";
    broadcastJobStatus(job);

    // Invoke Claude to fix the issues
    const fixResult = await fixValidationErrors({
      worktreePath,
      validationOutput,
    });

    if (fixResult.status === "failed") {
      logger.warn("merge.validation_fix_failed", {
        jobId: job.jobId,
        error: fixResult.error,
      });
      // Claude couldn't fix it — throw the original error
      throw err;
    }

    // Commit Claude's fixes
    if (await hasUncommittedChanges(worktreePath)) {
      await commitChanges(worktreePath, "auto-fix: validation errors", {
        skipHooks: true,
      });
    }

    // Re-run validation (one retry only — if this fails, it fails for real)
    job.phase = "re-validating";
    broadcastJobStatus(job);

    logger.info("merge.re_validating", {
      jobId: job.jobId,
      sessionName,
    });

    await runPreMergeValidation({
      projectPath,
      worktreePath,
      sessionName,
      branchName,
      timeoutMs,
    });

    logger.info("merge.validation_fix_succeeded", {
      jobId: job.jobId,
      sessionName,
    });
  }
}

// ============================================================
// Public API — Dispatch
// ============================================================

/**
 * Dispatch a merge job (merge main into feature, optionally auto-resolve,
 * then squash merge into main).
 */
export function dispatchMergeJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  autoResolve: boolean;
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
    autoResolve,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "merge",
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  // Fire-and-forget background pipeline
  void (async () => {
    try {
      logger.info("merge.start", {
        jobId: job.jobId,
        sessionName,
        worktreePath,
        branchName,
        autoResolve,
      });

      // Phase 0: Commit uncommitted changes in the worktree.
      // Skip pre-commit hooks — this is a WIP commit that will be
      // squash-merged; running lint/test here blocks the pipeline
      // and leaves the worktree in a half-staged state on failure.
      if (await hasUncommittedChanges(worktreePath)) {
        logger.info("merge.commit_uncommitted", {
          jobId: job.jobId,
          worktreePath,
        });
        await commitChanges(worktreePath, "WIP: uncommitted changes", {
          skipHooks: true,
        });
      }

      // Phase 1: Merge main into feature branch
      logger.info("merge.phase1_merge_main", { jobId: job.jobId });
      const mergeResult = await mergeMainIntoFeature(worktreePath);

      if (mergeResult.status === "clean") {
        // Phase 2: Pre-merge validation (with auto-recovery if enabled)
        const config = await readConfig();
        await runValidationWithRecovery({
          job,
          projectPath,
          worktreePath,
          sessionName,
          branchName,
          timeoutMs: config.preMergeTimeoutMs ?? 300_000,
          autoResolve,
        });

        // Phase 3: Squash merge into main
        job.phase = "squash-merging";
        broadcastJobStatus(job);
        logger.info("merge.phase2_squash", { jobId: job.jobId });
        await executePhase2(job, projectPath, branchName, message, sessionName);

        job.phase = undefined;
        job.status = "completed";
        logger.info("merge.completed", {
          jobId: job.jobId,
          mergeHash: job.mergeHash,
        });
        broadcastJobStatus(job);
      } else {
        // Conflicts detected
        logger.info("merge.conflicts_detected", {
          jobId: job.jobId,
          conflictFiles: mergeResult.conflictFiles,
          autoResolve,
        });

        if (autoResolve) {
          const result = await resolveConflicts({ worktreePath });

          if (result.status === "resolved") {
            // Store conflict analysis
            storeConflictAnalysis(
              projectPath,
              sessionName,
              job.jobId,
              projectName,
              result.conflicts,
            );

            // Commit the resolution
            await commitChanges(worktreePath, "resolve merge conflicts", {
              skipHooks: true,
            });

            // Pre-merge validation (with auto-recovery)
            const resolveConfig = await readConfig();
            await runValidationWithRecovery({
              job,
              projectPath,
              worktreePath,
              sessionName,
              branchName,
              timeoutMs: resolveConfig.preMergeTimeoutMs ?? 300_000,
              autoResolve: true,
            });

            // Squash merge into main
            job.phase = "squash-merging";
            broadcastJobStatus(job);
            logger.info("merge.phase2_squash_after_resolve", {
              jobId: job.jobId,
            });
            await executePhase2(
              job,
              projectPath,
              branchName,
              message,
              sessionName,
            );

            job.phase = undefined;
            job.status = "completed";
            logger.info("merge.completed", {
              jobId: job.jobId,
              mergeHash: job.mergeHash,
            });
            broadcastJobStatus(job);
          } else {
            // Auto-resolve failed — store partial results if available
            if (result.partialConflicts) {
              storeConflictAnalysis(
                projectPath,
                sessionName,
                job.jobId,
                projectName,
                result.partialConflicts,
              );
            }

            // Fall back to conflicts status
            job.status = "conflicts";
            job.conflictFiles = mergeResult.conflictFiles;
            job.conflictCount = mergeResult.conflictFiles.length;
            broadcastJobStatus(job);
          }
        } else {
          // No auto-resolve — report conflicts
          job.status = "conflicts";
          job.conflictFiles = mergeResult.conflictFiles;
          job.conflictCount = mergeResult.conflictFiles.length;
          broadcastJobStatus(job);
        }
      }
    } catch (err) {
      job.phase = undefined;
      job.status = "failed";
      const errObj = err as Error & { gitOutput?: string };
      const parts: string[] = [errObj.message ?? "Unknown error"];
      if (errObj.gitOutput) {
        parts.push(errObj.gitOutput);
      }
      job.errorMessage = parts.join("\n");
      logger.error("merge.failed", {
        jobId: job.jobId,
        error: job.errorMessage,
      });
      broadcastJobStatus(job);
    } finally {
      job.completedAt = new Date().toISOString();
      release();
    }
  })();

  return { ok: true, value: { jobId: job.jobId } };
}

/**
 * Dispatch a commit job (stage + commit changes in worktree).
 */
export function dispatchCommitJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    message,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "commit",
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  // Fire-and-forget background pipeline
  void (async () => {
    try {
      logger.info("commit.start", {
        jobId: job.jobId,
        sessionName,
        worktreePath,
      });
      const { hash } = await commitChanges(worktreePath, message);
      job.status = "completed";
      job.commitHash = hash;
      logger.info("commit.completed", { jobId: job.jobId, hash });
      broadcastJobStatus(job);
    } catch (err) {
      job.status = "failed";
      const errObj = err as Error & { gitOutput?: string };
      const parts: string[] = [errObj.message ?? "Unknown error"];
      if (errObj.gitOutput) {
        parts.push(errObj.gitOutput);
      }
      job.errorMessage = parts.join("\n");
      logger.error("commit.failed", {
        jobId: job.jobId,
        error: job.errorMessage,
      });
      broadcastJobStatus(job);
    } finally {
      job.completedAt = new Date().toISOString();
      release();
    }
  })();

  return { ok: true, value: { jobId: job.jobId } };
}

/**
 * Dispatch a resolve-conflicts job (invoke Claude to resolve conflicts,
 * commit the resolution, then squash merge into main).
 */
export function dispatchResolveConflictsJob(params: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  mergeMessage: string;
  decisions?: ConflictDecisionInput[];
}): Result<{ jobId: string }, JobDispatchError> {
  const {
    projectPath,
    projectName,
    sessionName,
    worktreePath,
    branchName,
    mergeMessage,
    decisions,
  } = params;

  const prepared = prepareDispatch({
    projectPath,
    projectName,
    sessionName,
    branchName,
    jobType: "resolve-conflicts",
  });
  if (!prepared.ok) return prepared;

  const { job, release } = prepared.value;

  // Fire-and-forget background pipeline
  void (async () => {
    try {
      logger.info("resolve-conflicts.start", {
        jobId: job.jobId,
        sessionName,
      });
      const result = await resolveConflicts({ worktreePath, decisions });

      if (result.status === "resolved") {
        // Store conflict analysis
        storeConflictAnalysis(
          projectPath,
          sessionName,
          job.jobId,
          projectName,
          result.conflicts,
        );

        // Commit the resolution
        await commitChanges(worktreePath, "resolve merge conflicts", {
          skipHooks: true,
        });

        // Pre-merge validation
        const rcConfig = await readConfig();
        await runPreMergeValidation({
          projectPath,
          worktreePath,
          sessionName,
          branchName,
          timeoutMs: rcConfig.preMergeTimeoutMs ?? 300_000,
        });

        // Squash merge into main
        logger.info("resolve-conflicts.phase2_squash", {
          jobId: job.jobId,
        });
        await executePhase2(
          job,
          projectPath,
          branchName,
          mergeMessage,
          sessionName,
        );

        job.status = "completed";
        logger.info("resolve-conflicts.completed", {
          jobId: job.jobId,
          mergeHash: job.mergeHash,
        });
        broadcastJobStatus(job);
      } else {
        // Resolution failed — store partial results if available
        if (result.partialConflicts) {
          storeConflictAnalysis(
            projectPath,
            sessionName,
            job.jobId,
            projectName,
            result.partialConflicts,
          );
        }

        job.status = "conflicts";
        broadcastJobStatus(job);
      }
    } catch (err) {
      job.status = "failed";
      job.errorMessage = err instanceof Error ? err.message : "Unknown error";
      logger.error("resolve-conflicts.failed", {
        jobId: job.jobId,
        error: job.errorMessage,
      });
      broadcastJobStatus(job);
    } finally {
      job.completedAt = new Date().toISOString();
      release();
    }
  })();

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
