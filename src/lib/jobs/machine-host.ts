/**
 * Generic XState machine hosting for background jobs.
 *
 * A "job machine" is an ephemeral XState actor (merge, commit) whose progress
 * is projected onto a `BackgroundJob`: context phase changes become status
 * broadcasts, and the machine's terminal output becomes the job's terminal
 * record. This module owns that projection loop once, so each job type only
 * supplies what makes it different — how to read the phase, how to map the
 * output, and how to build the machine input.
 *
 * The host side (registry, locking, broadcast, persistence) stays in
 * `jobs/queue.ts` and is injected via the method-syntax host interfaces.
 */

import { captureTraceContext, createLogger, runAsTrace } from "../logging";
import type { BackgroundJob } from "./schemas";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("background-jobs");

// ============================================================
// Result vocabulary
// ============================================================

export type JobDispatchError = "SESSION_BUSY" | "JOB_ALREADY_RUNNING";

export type JobDispatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JobDispatchError };

// ============================================================
// Structural actor shapes (what hosting actually needs)
// ============================================================

/** The slice of an XState actor the phase-diff observer consumes. */
export interface PhaseObservableActor<TContext> {
  subscribe(observer: {
    next?(snapshot: { status: string; context: TContext }): void;
    complete?(): void;
    error?(err: unknown): void;
  }): unknown;
}

/** The slice of an XState actor job hosting consumes. */
export interface JobMachineActor<
  TContext,
  TOutput,
> extends PhaseObservableActor<TContext> {
  getSnapshot(): {
    status: string;
    context: TContext;
    output: TOutput | undefined;
  };
  start(): unknown;
}

// ============================================================
// Phase-diff observation
// ============================================================

/**
 * Build a snapshot handler that invokes `onPhaseChange` once per distinct
 * phase value while the actor is active. Snapshots that repeat the previous
 * phase are ignored, so consumers see phase *transitions*, not every machine
 * snapshot.
 */
function createPhaseDiffHandler<TContext, TPhase>(
  phaseOf: (context: TContext) => TPhase | undefined,
  onPhaseChange: (phase: TPhase | undefined) => void,
): (snapshot: { status: string; context: TContext }) => void {
  let lastPhase: TPhase | undefined = undefined;
  return (snapshot) => {
    if (snapshot.status !== "active") return;
    const phase = phaseOf(snapshot.context);
    if (phase === lastPhase) return;
    lastPhase = phase;
    onPhaseChange(phase);
  };
}

/**
 * Subscribe to an actor and report deduped phase transitions (see
 * `createPhaseDiffHandler`).
 */
export function observePhaseTransitions<TContext, TPhase>(
  actor: PhaseObservableActor<TContext>,
  phaseOf: (context: TContext) => TPhase | undefined,
  onPhaseChange: (phase: TPhase | undefined) => void,
): void {
  actor.subscribe({ next: createPhaseDiffHandler(phaseOf, onPhaseChange) });
}

// ============================================================
// Job actor subscription
// ============================================================

/** What makes one job machine's projection different from another's. */
export interface JobSubscriptionConfig<TContext, TOutput> {
  /** Read the broadcastable phase off the machine context. */
  phaseOf(context: TContext): string | undefined;
  /**
   * Project durable progress from an active machine snapshot onto the job.
   * Return true only when the durable record must be updated before the
   * machine continues to its next externally-observable operation.
   */
  projectActiveSnapshot?(job: BackgroundJob, context: TContext): boolean;
  /** Project the machine's terminal output onto the job record. */
  mapOutput(job: BackgroundJob, output: TOutput, context: TContext): void;
}

/** Host-side effects the subscription drives (owned by `jobs/queue.ts`). */
export interface JobSubscriptionHost {
  /** Broadcast the job's current state (and persist on terminal statuses). */
  publishStatus(job: BackgroundJob): void;
  /** Persist active-machine progress that later operations must resolve. */
  persistProgress(job: BackgroundJob): void;
  /** Release the session lock. Called exactly once, on terminal state. */
  release(): void;
}

export interface JobActorCallbacks<TContext, TOutput> {
  onPhaseChange?(phase: string | undefined, context: TContext): void;
  onComplete?(output: TOutput, context: TContext): void;
  onError?(error: unknown): void;
}

/**
 * Subscribe to a job machine actor and project it onto the BackgroundJob:
 * phase changes publish status updates; completion maps the output onto the
 * job and stamps `completedAt`; actor-level errors (which the machines handle
 * internally — this is defensive) fail the job. The session lock is released
 * on either terminal path.
 */
export function createJobActorSubscription<TContext, TOutput>(
  actor: JobMachineActor<TContext, TOutput>,
  job: BackgroundJob,
  host: JobSubscriptionHost,
  config: JobSubscriptionConfig<TContext, TOutput>,
  callbacks: JobActorCallbacks<TContext, TOutput> = {},
): void {
  const onPhaseSnapshot = createPhaseDiffHandler(config.phaseOf, (phase) => {
    job.phase = phase;
    host.publishStatus(job);
    callbacks.onPhaseChange?.(phase, actor.getSnapshot().context);
  });

  actor.subscribe({
    next(snapshot) {
      if (snapshot.status !== "active") return;
      const mustPersist =
        config.projectActiveSnapshot?.(job, snapshot.context) ?? false;
      if (mustPersist) host.persistProgress(job);
      onPhaseSnapshot(snapshot);
    },
    complete() {
      const snapshot = actor.getSnapshot();
      if (snapshot.output === undefined) {
        logger.error("job.machine_completed_without_output", {
          jobId: job.jobId,
          jobType: job.jobType,
        });
        job.status = "failed";
        job.errorMessage = "Machine completed without producing output";
        job.phase = undefined;
      } else {
        config.mapOutput(job, snapshot.output, snapshot.context);
      }
      job.completedAt = new Date().toISOString();
      host.publishStatus(job);
      host.release();
      if (snapshot.output !== undefined) {
        callbacks.onComplete?.(snapshot.output, snapshot.context);
      }
    },
    error(err) {
      logger.error("job.machine_actor_error", {
        jobId: job.jobId,
        jobType: job.jobType,
        error: getErrorMessage(err),
      });
      job.status = "failed";
      job.errorMessage = err instanceof Error ? err.message : "Unknown error";
      job.phase = undefined;
      job.completedAt = new Date().toISOString();
      host.publishStatus(job);
      host.release();
      callbacks.onError?.(err);
    },
  });
}

// ============================================================
// Generic dispatch
// ============================================================

/** Session identity a dispatch registers the job under. */
export interface JobDispatchSession {
  projectPath: string;
  projectName: string;
  sessionName: string;
  branchName: string;
  targetBranch?: string;
}

/** Host-side dispatch effects (owned by `jobs/queue.ts`). */
export interface JobDispatchHost {
  /**
   * Guard against concurrent jobs, acquire the session lock, register the
   * job, and broadcast "running".
   */
  prepare(
    params: JobDispatchSession & {
      jobType: BackgroundJob["jobType"];
      decorateJob?(job: BackgroundJob): void;
    },
  ): JobDispatchResult<{ job: BackgroundJob; release(): void }>;
  /** Broadcast the job's current state (and persist on terminal statuses). */
  publishStatus(job: BackgroundJob): void;
  /** Persist active-machine progress before downstream operations consume it. */
  persistProgress(job: BackgroundJob): void;
}

export interface DispatchMachineJobParams<TContext, TOutput> {
  jobType: BackgroundJob["jobType"];
  session: JobDispatchSession;
  host: JobDispatchHost;
  /** Build the started-not-yet-running actor for the registered job id. */
  createJobActor(jobId: string): JobMachineActor<TContext, TOutput>;
  /** Stamp job-type-specific fields before the job is registered and persisted. */
  decorateJob?(job: BackgroundJob): void;
  /** Emit the job type's start log line. */
  logStart(job: BackgroundJob): void;
  subscription: JobSubscriptionConfig<TContext, TOutput>;
  callbacks?: JobActorCallbacks<TContext, TOutput>;
}

/**
 * Dispatch a background job hosted on an XState machine, fire-and-forget:
 * guard + register via the host, create the actor, wire the job projection,
 * and start it. Runs under a `job:<type>` trace inheriting the caller's
 * trace context so the background actor's timings aggregate with the request
 * that triggered the dispatch.
 */
export function dispatchMachineJob<TContext, TOutput>(
  params: DispatchMachineJobParams<TContext, TOutput>,
): JobDispatchResult<{ jobId: string }> {
  return runAsTrace(
    `job:${params.jobType}`,
    () => dispatchMachineJobImpl(params),
    captureTraceContext(),
  );
}

function dispatchMachineJobImpl<TContext, TOutput>(
  params: DispatchMachineJobParams<TContext, TOutput>,
): JobDispatchResult<{ jobId: string }> {
  const { jobType, session, host } = params;

  const prepared = host.prepare({
    ...session,
    jobType,
    decorateJob: params.decorateJob,
  });
  if (!prepared.ok) {
    logger.info("job.dispatch_rejected", {
      jobType,
      sessionName: session.sessionName,
      reason: prepared.error,
    });
    return prepared;
  }

  const { job, release } = prepared.value;
  params.logStart(job);

  const actor = params.createJobActor(job.jobId);
  createJobActorSubscription(
    actor,
    job,
    {
      publishStatus: (j) => host.publishStatus(j),
      persistProgress: (j) => host.persistProgress(j),
      release,
    },
    params.subscription,
    params.callbacks,
  );
  actor.start();

  return { ok: true, value: { jobId: job.jobId } };
}
