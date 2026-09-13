import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getActiveGraphWorkflowExecution as defaultGetActiveGraphWorkflowExecution,
  getSession as defaultGetSession,
} from "@/lib/state-store";
import { computeDiff as defaultComputeDiff } from "./diff";
import { resolveMergeTarget as defaultResolveMergeTarget } from "./merge-target";
import {
  getCommitLog as defaultGetCommitLog,
  getCommitDiff as defaultGetCommitDiff,
} from "./commits";
import { commitRequestSchema } from "./schemas";
import type { SessionDiff, CommitLogEntry } from "./schemas";
import type { MergeTarget } from "./merge-target";
import {
  smartMergeRequestSchema,
  resolveConflictsRequestSchema,
  type BackgroundJob,
  type ConflictDecisionInput,
  type JobRecord,
} from "@/lib/jobs/schemas";
import type { JobDispatchResult } from "@/lib/jobs/machine-host";
import {
  abortSessionJob as defaultAbortSessionJob,
  dispatchCommitJob as defaultDispatchCommitJob,
  dispatchMergeJob as defaultDispatchMergeJob,
  dispatchResolveConflictsJob as defaultDispatchResolveConflictsJob,
  getJob as defaultGetJob,
  type AbortSessionJobResult,
  type MergeDispatchError,
  type MergeDispatchResult,
} from "@/lib/jobs/queue";
import { defaultGitClient, type GitClient } from "./client";
import { PARKED_MERGE_REF_PREFIX } from "./worktree";
import {
  resolveSessionRoute,
  type ResolvedSessionRoute,
} from "@/lib/conversations/route-resolution";
import {
  resolveProjectOr404,
  parseJsonBody,
  jsonError,
  notFound,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { evaluateMergeInitiation } from "@/lib/workflows/merge/initiation";
import { createLogger, withTracing } from "@/lib/logging";
import { createJobsRepo } from "@/lib/jobs/repo";
import { getStateDb } from "@/lib/state-store/store";
import type { ApiError } from "@/lib/api/errors";

const diffLogger = createLogger("api.diff");
const mergeLogger = createLogger("git-merge-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface GitRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * The delivery gate reads tenure, not status, so the halt reason and
   * abandonment travel with it: a status alone cannot separate a resumable halt
   * (still holding the lease) from a non-resumable or abandoned one, which holds
   * nothing and must not block the merge. `definitionApproval` rides along
   * because the refusal names the canonical remedy, and a run parked awaiting a
   * definition decision is cleared by approving it, not by completing it.
   */
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<Pick<
    GraphWorkflowExecution,
    "id" | "status" | "haltReason" | "abandonment" | "definitionApproval"
  > | null>;
  computeDiff(worktreePath: string): Promise<SessionDiff>;
  getCommitLog(
    worktreePath: string,
    targetBranch: string,
  ): Promise<CommitLogEntry[]>;
  getCommitDiff(
    worktreePath: string,
    commitHash: string,
    targetBranch: string,
  ): Promise<SessionDiff>;
  resolveMergeTarget(
    projectPath: string,
    session: SessionState,
  ): Promise<MergeTarget>;
  dispatchCommitJob(params: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    worktreePath: string;
    branchName: string;
    message: string;
    targetBranch?: string;
  }): JobDispatchResult<{ jobId: string }>;
  dispatchMergeJob(params: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    worktreePath: string;
    branchName: string;
    message: string;
    autoResolve: boolean;
    targetBranch?: string;
    entryMode?: "land" | "discard";
    preparedSha?: string;
    expectedTargetSha?: string;
    parkedRef?: string;
    resolutionContext?: string;
    executionId?: string;
    specExecutionId?: string;
    finalPublish?: boolean;
    /** Carried forward from the job a re-entry resumes; see the land handler. */
    finalizeSessionOnPublish?: boolean;
    candidateValidation?: BackgroundJob["candidateValidation"];
  }): MergeDispatchResult;
  dispatchResolveConflictsJob(params: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    worktreePath: string;
    branchName: string;
    mergeMessage: string;
    decisions?: ConflictDecisionInput[];
    /** Carried forward from the conflicted job this retry resumes. */
    conflictFiles?: string[];
    targetBranch?: string;
    resolutionContext?: string;
    executionId?: string;
    specExecutionId?: string;
    finalPublish?: boolean;
    /** Carried forward from the conflicted job this retry resumes. */
    finalizeSessionOnPublish?: boolean;
    candidateValidation?: BackgroundJob["candidateValidation"];
  }): MergeDispatchResult;
  getJob(projectPath: string, sessionName: string): BackgroundJob | undefined;
  /**
   * The session's most recent job as persisted — the durable stand-in for the
   * registry entry, read only when the registry holds nothing for the session.
   * The registry dies with the process, while the parked commit and the row
   * describing it do not.
   */
  findLatestJobRecordForSession(
    projectName: string,
    sessionName: string,
  ): JobRecord | null;
  abortSessionJob(
    projectPath: string,
    sessionName: string,
  ): AbortSessionJobResult;
  gitClient: GitClient;
}

function defaultDeps(): GitRouteDeps {
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getSession: defaultGetSession,
    getActiveGraphWorkflowExecution: defaultGetActiveGraphWorkflowExecution,
    computeDiff: defaultComputeDiff,
    getCommitLog: defaultGetCommitLog,
    getCommitDiff: defaultGetCommitDiff,
    resolveMergeTarget: defaultResolveMergeTarget,
    dispatchCommitJob: defaultDispatchCommitJob,
    dispatchMergeJob: defaultDispatchMergeJob,
    dispatchResolveConflictsJob: defaultDispatchResolveConflictsJob,
    getJob: defaultGetJob,
    findLatestJobRecordForSession: (projectName, sessionName) =>
      createJobsRepo(getStateDb()).findLatestJobRecordForSession(
        projectName,
        sessionName,
      ),
    abortSessionJob: defaultAbortSessionJob,
    gitClient: defaultGitClient,
  };
}

/** 409 for a dispatch rejected by the session lock / job registry. */
function jobDispatchConflict(code: string): Response {
  return NextResponse.json(
    {
      error:
        code === "SESSION_BUSY"
          ? "Session is busy"
          : "A job is already running for this session",
      code,
    } satisfies ApiError,
    { status: 409 },
  );
}

/**
 * Merge dispatch errors: lock/registry conflicts stay the plain 409, while an
 * association refusal renders the specs refusal envelope (unmetConditions +
 * instruction) the client already knows how to surface.
 */
function mergeDispatchErrorResponse(error: MergeDispatchError): Response {
  if (typeof error === "string") return jobDispatchConflict(error);
  return NextResponse.json(
    {
      error: error.reason,
      code: error.code,
      unmetConditions: [error.reason],
      instruction: error.instruction,
    },
    { status: 409 },
  );
}

function jobAccepted(
  jobId: string,
  jobType: "commit" | "merge" | "resolve-conflicts",
  branchName: string,
): Response {
  return NextResponse.json(
    { jobId, jobType, branchName, startedAt: new Date().toISOString() },
    { status: 202 },
  );
}

/** 409 for a finished (read-only) session addressed by a mutating route. */
function finishedSessionConflict(): Response {
  return NextResponse.json(
    {
      error: "Session is finished and read-only",
      code: "SESSION_FINISHED",
    } satisfies ApiError,
    { status: 409 },
  );
}

interface PreparedJob {
  job: BackgroundJob;
  parkedRef: string;
  preparedSha: string;
}

export function createGitRouteHandlers(deps: GitRouteDeps = defaultDeps()) {
  async function readParkedRefSha(
    projectPath: string,
    parkedRef: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await deps.gitClient.git(
        ["rev-parse", "--verify", parkedRef],
        projectPath,
      );
      const sha = stdout.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Precondition ladder shared by land/discard: a job in `ready-to-land` state
   * carrying its prepared-commit bookkeeping, from the in-memory registry or —
   * when a restart emptied it — from the durable row.
   *
   * The registry is consulted first and wins outright: a session whose current
   * job is running or already finished has no parked candidate to act on, and
   * falling through to an older row would resurrect a superseded decision. The
   * durable fallback answers the same question the same way — the session's
   * LATEST job, judged by the same ladder — because a land or discard runs as a
   * new job for the session, so a candidate that has been acted on is no longer
   * the latest row and must not be offered a second time.
   *
   * `parkedRefPolicy` is the caller's, because the same missing ref means
   * opposite things to the two callers. Landing a commit that is gone is
   * impossible, so land requires the ref. Discarding it is idempotent cleanup —
   * refusing there would strand the session showing a candidate no act can
   * clear — so discard tolerates its absence and skips the probe.
   */
  async function resolvePreparedJob(
    route: { projectPath: string; projectName: string; sessionName: string },
    parkedRefPolicy: "require" | "tolerate-missing",
  ): Promise<RouteResolution<PreparedJob>> {
    const { projectPath, projectName, sessionName } = route;
    const registered = deps.getJob(projectPath, sessionName);
    const job: BackgroundJob | null =
      registered ??
      deps.findLatestJobRecordForSession(projectName, sessionName);
    if (!job) {
      return {
        ok: false,
        response: notFound("No prepared merge for this session"),
      };
    }

    if (job.status !== "ready-to-land") {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `Job is not ready to land (status: ${job.status})`,
            code: "JOB_NOT_READY_TO_LAND",
          } satisfies ApiError,
          { status: 409 },
        ),
      };
    }

    const parkedRef = job.parkedRef ?? `${PARKED_MERGE_REF_PREFIX}${job.jobId}`;
    const preparedSha = job.preparedSha ?? null;
    if (!preparedSha) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Prepared commit SHA missing from job record",
            code: "PREPARED_SHA_MISSING",
          } satisfies ApiError,
          { status: 409 },
        ),
      };
    }

    if (parkedRefPolicy === "require") {
      const actualSha = await readParkedRefSha(projectPath, parkedRef);
      if (actualSha !== preparedSha) {
        mergeLogger.warn("merge.parked_ref_unresolvable", {
          projectPath,
          sessionName,
          jobId: job.jobId,
          parkedRef,
          resolved: actualSha,
          fromRegistry: registered !== undefined,
        });
        return {
          ok: false,
          response: NextResponse.json(
            {
              error: `Parked ref ${parkedRef} no longer resolves to prepared commit ${preparedSha} — the prepared merge is gone. Run the merge again to prepare a new candidate.`,
              code: "PARKED_REF_MISSING",
            } satisfies ApiError,
            { status: 409 },
          ),
        };
      }
    }

    return { ok: true, value: { job, parkedRef, preparedSha } };
  }

  async function resolveRoute(
    context: RouteContext,
  ): Promise<RouteResolution<ResolvedSessionRoute & { projectName: string }>> {
    const resolved = await resolveSessionRoute(deps, context);
    if (!resolved.ok) return resolved;
    const params = await context.params;
    return {
      ok: true,
      value: { ...resolved.value, projectName: params["name"] ?? "" },
    };
  }

  /** GET /api/projects/[name]/sessions/[session]/diff — get uncommitted diff */
  async function getSessionDiff(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const t0 = performance.now();
    const r = await resolveRoute(context);
    const tResolve = performance.now();
    if (!r.ok) return r.response;

    try {
      const diff = await deps.computeDiff(r.value.session.worktreePath);
      const tDiff = performance.now();
      const response = NextResponse.json(diff);
      const tSerialize = performance.now();

      diffLogger.info("diff.timing", {
        resolveMs: +(tResolve - t0).toFixed(2),
        diffMs: +(tDiff - tResolve).toFixed(2),
        serializeMs: +(tSerialize - tDiff).toFixed(2),
        durationMs: +(tSerialize - t0).toFixed(2),
      });

      return response;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return jsonError(message, 500);
    }
  }

  /**
   * GET /api/projects/[name]/diff — read-only uncommitted diff of the project's
   * main (repo-root) worktree, consumed by the project-conversation cockpit. The
   * main worktree is the project path itself (no session branch); the diff is the
   * same working-tree-vs-HEAD computation the session surface uses. Read-only:
   * this route exposes no commit/discard/reset — those live on the session path.
   */
  async function getMainWorktreeDiff(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const project = await resolveProjectOr404(deps, params["name"] ?? "");
    if (!project.ok) return project.response;

    try {
      const diff = await deps.computeDiff(project.value);
      return NextResponse.json(diff);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return jsonError(message, 500);
    }
  }

  /** GET /api/projects/[name]/sessions/[session]/commits — list commits since divergence */
  async function listSessionCommits(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;

    try {
      const commits = await deps.getCommitLog(
        r.value.session.worktreePath,
        r.value.session.targetBranch,
      );
      return NextResponse.json({ commits });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch commits";
      return jsonError(message, 500);
    }
  }

  /** GET /api/projects/[name]/sessions/[session]/commits/[hash]/diff — per-commit diff */
  async function getSessionCommitDiff(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;

    const params = await context.params;
    const hash = params["hash"] ?? "";
    if (!hash) {
      return jsonError("Commit hash is required", 400);
    }

    try {
      const diff = await deps.getCommitDiff(
        r.value.session.worktreePath,
        hash,
        r.value.session.targetBranch,
      );
      return NextResponse.json(diff);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch commit diff";
      return jsonError(message, 500);
    }
  }

  /** POST /api/projects/[name]/sessions/[session]/commit — dispatch async commit job */
  async function commitSession(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    if (session.finished) return finishedSessionConflict();

    const body = await parseJsonBody(
      request,
      commitRequestSchema,
      "Commit message is required",
    );
    if (!body.ok) return body.response;

    const result = deps.dispatchCommitJob({
      projectPath,
      projectName,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: body.value.message,
      targetBranch: session.targetBranch,
    });

    if (!result.ok) return jobDispatchConflict(result.error);
    return jobAccepted(result.value.jobId, "commit", session.branchName);
  }

  /** POST /api/projects/[name]/sessions/[session]/merge — dispatch async merge job */
  async function mergeSession(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    if (session.finished) return finishedSessionConflict();

    const admission = await evaluateMergeInitiation({
      projectPath,
      projectName,
      sessionName,
      surface: "merge-route",
      readActiveExecution: deps.getActiveGraphWorkflowExecution,
    });
    if (!admission.admitted) {
      const { refusal } = admission;
      return NextResponse.json(
        {
          error: refusal.message,
          code: refusal.code,
          details:
            refusal.code === "GRAPH_WORKFLOW_ACTIVE"
              ? {
                  executionId: refusal.executionId,
                  status: refusal.status,
                  remedy: refusal.remedy,
                }
              : { reviewUrl: refusal.reviewUrl, blockers: refusal.blockers },
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const body = await parseJsonBody(
      request,
      smartMergeRequestSchema,
      "autoResolve flag is required",
    );
    if (!body.ok) return body.response;

    const { targetBranch } = await deps.resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    const result = deps.dispatchMergeJob({
      projectPath,
      projectName,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: mergeMessage,
      autoResolve: body.value.autoResolve,
      targetBranch,
    });

    if (!result.ok) return mergeDispatchErrorResponse(result.error);
    return jobAccepted(result.value.jobId, "merge", session.branchName);
  }

  /** POST /api/projects/[name]/sessions/[session]/resolve-conflicts — dispatch async conflict resolution job */
  async function resolveSessionConflicts(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    const body = await parseJsonBody(
      request,
      resolveConflictsRequestSchema,
      "Invalid request body",
    );
    if (!body.ok) return body.response;

    const { targetBranch } = await deps.resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    // The conflicts-terminal merge job (still in the registry) carries the
    // intent notes generated at /merge time plus the merge's execution
    // provenance and validation fact; the retry must keep all of them or the
    // delivery gate silently loses its linkage.
    const priorJob = deps.getJob(projectPath, sessionName);

    const result = deps.dispatchResolveConflictsJob({
      projectPath,
      projectName,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      mergeMessage,
      decisions: body.value.decisions,
      // The retry never sees the merge that produced these, so the ground-truth
      // check after the agent claims resolution has nothing to hold it to
      // unless the conflicted job's own list rides along.
      conflictFiles: priorJob?.conflictFiles,
      targetBranch,
      resolutionContext: priorJob?.resolutionContext,
      executionId: priorJob?.executionId,
      specExecutionId: priorJob?.specExecutionId,
      finalPublish: priorJob?.finalPublish,
      // Whether the publish finishes the session is the RESUMED merge's fact,
      // not this route's assumption: a conflicted graph lane merge retried here
      // is still the workflow's own work, and calling it session-finalizing
      // would both false-block the engine's next launch and point the session
      // delivery gate at the workflow's own Current run.
      finalizeSessionOnPublish: priorJob?.finalizeSessionOnPublish,
      candidateValidation: priorJob?.candidateValidation,
    });

    if (!result.ok) return mergeDispatchErrorResponse(result.error);
    return jobAccepted(
      result.value.jobId,
      "resolve-conflicts",
      session.branchName,
    );
  }

  /**
   * POST /api/projects/[name]/sessions/[session]/merge/abort — stop the
   * session's in-flight merge-family job.
   *
   * The job registry holds one job per session, so this reaches the running
   * merge, conflict-resolution retry, or Smart Commit alike; the machine's
   * terminal projection turns the stop into the same failed record any other
   * failure produces.
   *
   * `delivery` distinguishes a run that is winding down from one whose current
   * operation cannot be recalled (a merge already publishing): the second only
   * takes effect if that operation comes back without landing.
   */
  async function abortSessionMergeJob(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, sessionName } = r.value;

    const result = deps.abortSessionJob(projectPath, sessionName);
    if (!result.ok) {
      if (result.error === "NO_ABORTABLE_JOB") {
        return notFound("No running merge or commit job for this session");
      }
      return NextResponse.json(
        {
          error:
            "The running job has no live actor in this process; it cannot be stopped from here",
          code: "JOB_ACTOR_MISSING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      delivery: result.delivery,
      ...(result.delivery === "deferred"
        ? {
            message:
              "The job is publishing and cannot be recalled; the stop applies only if the publish does not land.",
          }
        : {}),
    });
  }

  /** POST /api/projects/[name]/sessions/[session]/merge/land — publish a prepared squash commit */
  async function landSession(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    const prepared = await resolvePreparedJob(
      { projectPath, projectName, sessionName },
      "require",
    );
    if (!prepared.ok) return prepared.response;
    const { job, parkedRef, preparedSha } = prepared.value;

    const expectedTargetSha = job.expectedTargetSha ?? null;
    if (!expectedTargetSha) {
      return NextResponse.json(
        {
          error: "Expected target SHA missing from job record",
          code: "EXPECTED_TARGET_SHA_MISSING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const { targetBranch } = await deps.resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    const result = deps.dispatchMergeJob({
      projectPath,
      projectName,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: mergeMessage,
      autoResolve: false,
      targetBranch,
      entryMode: "land",
      preparedSha,
      expectedTargetSha,
      parkedRef,
      resolutionContext: job.resolutionContext,
      executionId: job.executionId,
      specExecutionId: job.specExecutionId,
      finalPublish: job.finalPublish,
      // Landing continues the parked merge, so it inherits that merge's own
      // finalization fact rather than assuming the session ends here.
      finalizeSessionOnPublish: job.finalizeSessionOnPublish,
      candidateValidation: job.candidateValidation,
    });

    if (!result.ok) return mergeDispatchErrorResponse(result.error);
    return jobAccepted(result.value.jobId, "merge", session.branchName);
  }

  /** POST /api/projects/[name]/sessions/[session]/merge/discard — drop a parked prepared commit */
  async function discardSession(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    const prepared = await resolvePreparedJob(
      { projectPath, projectName, sessionName },
      "tolerate-missing",
    );
    if (!prepared.ok) return prepared.response;
    const { parkedRef, preparedSha } = prepared.value;

    // The session's own recorded target, deliberately NOT `resolveMergeTarget`:
    // a discard deletes a parked ref and touches no target branch, so resolving
    // the parent session's checkout would buy a state-store read for a value
    // nothing here can act on. The branch name only labels the notification.
    const targetBranch = session.targetBranch ?? "main";
    const mergeMessage = `Discard prepared merge for ${session.branchName}`;

    const result = deps.dispatchMergeJob({
      projectPath,
      projectName,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: mergeMessage,
      autoResolve: false,
      targetBranch,
      entryMode: "discard",
      preparedSha,
      parkedRef,
    });

    if (!result.ok) return mergeDispatchErrorResponse(result.error);
    return jobAccepted(result.value.jobId, "merge", session.branchName);
  }

  return {
    getSessionDiff,
    getMainWorktreeDiff,
    listSessionCommits,
    getSessionCommitDiff,
    commitSession,
    mergeSession,
    resolveSessionConflicts,
    abortSessionMergeJob,
    landSession,
    discardSession,
  };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultHandlers = createGitRouteHandlers();
export const getSessionDiff = withTracing(_defaultHandlers.getSessionDiff);
export const getMainWorktreeDiff = withTracing(
  _defaultHandlers.getMainWorktreeDiff,
);
export const listSessionCommits = withTracing(
  _defaultHandlers.listSessionCommits,
);
export const getSessionCommitDiff = withTracing(
  _defaultHandlers.getSessionCommitDiff,
);
export const commitSession = withTracing(_defaultHandlers.commitSession);
export const mergeSession = withTracing(_defaultHandlers.mergeSession);
export const resolveSessionConflicts = withTracing(
  _defaultHandlers.resolveSessionConflicts,
);
export const abortSessionMergeJob = withTracing(
  _defaultHandlers.abortSessionMergeJob,
);
export const landSession = withTracing(_defaultHandlers.landSession);
export const discardSession = withTracing(_defaultHandlers.discardSession);
