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
  dispatchMachineJob,
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
import { notifyRegisteredMergeDelivered } from "../workflows/merge/delivery-lifecycle-port";
import type {
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
import { getErrorMessage } from "@/lib/shared/errors";
import { assertNever } from "../shared/assert-never";
import type { ConflictAnalysis } from "@/lib/git/schemas";
import type {
  BackgroundJob,
  JobStatusEvent,
  ConflictDecisionInput,
} from "./schemas";
import { getGlobalSingleton } from "../shared/global-singleton";

const logger = createLogger("background-jobs");

// ============================================================
// Constants
// ============================================================

/** Jobs running longer than this are considered stale (10 minutes) */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

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

function broadcastJobStatus(
  job: BackgroundJob,
  broadcast: PublishFn = defaultJobBroadcast,
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
    ...(job.parkedRef && { parkedRef: job.parkedRef }),
    ...(job.preparedSha && { preparedSha: job.preparedSha }),
    ...(job.expectedTargetSha && { expectedTargetSha: job.expectedTargetSha }),
    ...(job.refreshWarning && { refreshWarning: job.refreshWarning }),
    ...(job.haltReason && { haltReason: job.haltReason }),
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
      candidateValidation: job.candidateValidation,
    });

    // A completed gate-passed final-publish merge IS the delivery: mark the
    // linked execution Delivered promptly rather than waiting for a status
    // read to reconcile. The gate ran before publish, so completed + mergeHash
    // + finalPublish implies gate-passed.
    if (
      (job.jobType === "merge" || job.jobType === "resolve-conflicts") &&
      job.status === "completed" &&
      job.mergeHash !== undefined &&
      job.executionId !== undefined &&
      job.finalPublish === true
    ) {
      notifyRegisteredMergeDelivered(job.executionId, job.mergeHash);
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
  decorateJob?(job: BackgroundJob): void;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  jobId?: string;
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
      persistJobProgress(job);
    },
  };
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
    job.executionId = context.executionId ?? undefined;
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
    // explain this commit to their conflict resolvers. Non-throwing.
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
          source: "session-merge",
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
  targetWorktreePath?: string;
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
  finalPublish?: boolean;
  candidateValidation?: BackgroundJob["candidateValidation"];
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
  finalPublish?: boolean;
}):
  | { ok: true; executionId?: string; finalPublish?: boolean }
  | { ok: false; error: MergeAssociationRefusedError } {
  if (input.executionId !== undefined) {
    return {
      ok: true,
      executionId: input.executionId,
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
      decorateJob(job) {
        if (input.resolutionContext) {
          job.resolutionContext = input.resolutionContext;
        }
        if (input.executionId) job.executionId = input.executionId;
        if (input.finalPublish === true) job.finalPublish = true;
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
    targetWorktreePath,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine: injectedMachine,
    entryMode,
    preparedSha,
    expectedTargetSha,
    parkedRef,
    resolutionContext,
    executionId,
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
    ...(finalPublish !== undefined && { finalPublish }),
  });
  if (!provenance.ok) return { ok: false, error: provenance.error };
  const resolvedExecutionId = provenance.executionId;
  const resolvedFinalPublish = provenance.finalPublish;

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
    decorateJob(job) {
      if (resolutionContext) job.resolutionContext = resolutionContext;
      if (resolvedExecutionId) job.executionId = resolvedExecutionId;
      if (resolvedFinalPublish === true) job.finalPublish = true;
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
        targetWorktreePath,
        ...(entryMode && { entryMode }),
        ...(preparedSha && { preparedSha }),
        ...(expectedTargetSha && { expectedTargetSha }),
        ...(parkedRef && { parkedRef }),
        ...(resolutionContext && { resolutionContext }),
        ...(resolvedExecutionId && { executionId: resolvedExecutionId }),
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
  targetBranch?: string;
  targetWorktreePath?: string;
  resolutionContext?: string;
  broadcast?: PublishFn;
  acquireSessionLock?: AcquireSessionLockFn;
  machine?: MergeMachineType;
  executionId?: string;
  finalPublish?: boolean;
  candidateValidation?: BackgroundJob["candidateValidation"];
}): MergeDispatchResult {
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
    resolutionContext,
    broadcast = defaultJobBroadcast,
    acquireSessionLock,
    machine: injectedMachine,
    executionId,
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
    ...(finalPublish !== undefined && { finalPublish }),
  });
  if (!provenance.ok) return { ok: false, error: provenance.error };
  const resolvedExecutionId = provenance.executionId;
  const resolvedFinalPublish = provenance.finalPublish;

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
      if (resolvedFinalPublish === true) job.finalPublish = true;
      if (candidateValidation) job.candidateValidation = candidateValidation;
    },
    logStart(job) {
      logger.info("resolve-conflicts.start", {
        jobId: job.jobId,
        sessionName,
        resolutionContextLength: resolutionContext?.length ?? 0,
        executionId: resolvedExecutionId,
        finalPublish: resolvedFinalPublish === true,
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
        autoResolve: false,
        validationMode: {
          mode: "run",
          source: "smart_merge",
          selection: { mode: "project-pre-merge" },
        },
        jobType: "resolve-conflicts",
        decisions,
        targetBranch,
        targetWorktreePath,
        ...(resolutionContext && { resolutionContext }),
        ...(resolvedExecutionId && { executionId: resolvedExecutionId }),
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
}

export type { JobDispatchError };
