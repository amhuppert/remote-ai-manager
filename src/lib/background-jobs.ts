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
import { broadcast } from "./sse-broadcaster";
import { setSessionFinished } from "./state";
import { createLogger } from "./logging";
import type { BackgroundJob, ConflictAnalysis, JobStatusEvent } from "@/types";
import type { ConflictDecisionInput } from "@/lib/schemas";

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

const JOB_REGISTRY_KEY = "__csm_background_jobs" as const;
const ANALYSIS_REGISTRY_KEY = "__csm_conflict_analysis" as const;

function getJobRegistry(): Map<string, BackgroundJob> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[JOB_REGISTRY_KEY]) {
    g[JOB_REGISTRY_KEY] = new Map<string, BackgroundJob>();
  }
  return g[JOB_REGISTRY_KEY] as Map<string, BackgroundJob>;
}

function getConflictAnalysisRegistry(): Map<string, ConflictAnalysis> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[ANALYSIS_REGISTRY_KEY]) {
    g[ANALYSIS_REGISTRY_KEY] = new Map<string, ConflictAnalysis>();
  }
  return g[ANALYSIS_REGISTRY_KEY] as Map<string, ConflictAnalysis>;
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
  };
  broadcast(event);
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

  await setSessionFinished(projectPath, sessionName);
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

      // Phase 0: Commit uncommitted changes in the worktree
      if (await hasUncommittedChanges(worktreePath)) {
        logger.info("merge.commit_uncommitted", {
          jobId: job.jobId,
          worktreePath,
        });
        await commitChanges(worktreePath, "WIP: uncommitted changes");
      }

      // Phase 1: Merge main into feature branch
      logger.info("merge.phase1_merge_main", { jobId: job.jobId });
      const mergeResult = await mergeMainIntoFeature(worktreePath);

      if (mergeResult.status === "clean") {
        // Phase 2: Squash merge into main
        logger.info("merge.phase2_squash", { jobId: job.jobId });
        await executePhase2(job, projectPath, branchName, message, sessionName);

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
            await commitChanges(worktreePath, "resolve merge conflicts");

            // Phase 2: Squash merge into main
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
      job.status = "failed";
      job.errorMessage = err instanceof Error ? err.message : "Unknown error";
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
        await commitChanges(worktreePath, "resolve merge conflicts");

        // Phase 2: Squash merge into main
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
