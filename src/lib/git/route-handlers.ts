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
} from "@/lib/jobs/schemas";
import type { JobDispatchResult } from "@/lib/jobs/machine-host";
import {
  dispatchCommitJob as defaultDispatchCommitJob,
  dispatchMergeJob as defaultDispatchMergeJob,
  dispatchResolveConflictsJob as defaultDispatchResolveConflictsJob,
  getJob as defaultGetJob,
  type MergeDispatchError,
  type MergeDispatchResult,
} from "@/lib/jobs/queue";
import { defaultGitClient, type GitClient } from "./client";
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
import { evaluateGraphWorkflowSessionDelivery } from "@/lib/workflow-graph/lifecycle-classifier";
import { createLogger, withTracing } from "@/lib/logging";
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
    targetWorktreePath?: string;
    entryMode?: "land" | "discard";
    preparedSha?: string;
    expectedTargetSha?: string;
    parkedRef?: string;
    resolutionContext?: string;
    executionId?: string;
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
    targetBranch?: string;
    targetWorktreePath?: string;
    resolutionContext?: string;
    executionId?: string;
    finalPublish?: boolean;
    /** Carried forward from the conflicted job this retry resumes. */
    finalizeSessionOnPublish?: boolean;
    candidateValidation?: BackgroundJob["candidateValidation"];
  }): MergeDispatchResult;
  getJob(projectPath: string, sessionName: string): BackgroundJob | undefined;
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
   * Precondition ladder shared by land/discard: a registered job in
   * `ready-to-land` state carrying its prepared-commit bookkeeping.
   */
  function resolvePreparedJob(
    projectPath: string,
    sessionName: string,
  ): RouteResolution<PreparedJob> {
    const job = deps.getJob(projectPath, sessionName);
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

    const parkedRef = job.parkedRef ?? `refs/cc-merges/${job.jobId}`;
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

    const deliveryDecision = evaluateGraphWorkflowSessionDelivery(
      await deps.getActiveGraphWorkflowExecution(projectPath, sessionName),
    );
    if (!deliveryDecision.allowed) {
      mergeLogger.warn("merge.active_graph_workflow_refused", {
        projectPath,
        sessionName,
        executionId: deliveryDecision.executionId,
        workflowStatus: deliveryDecision.status,
        remedy: deliveryDecision.remedy,
      });
      return NextResponse.json(
        {
          error: deliveryDecision.message,
          code: "GRAPH_WORKFLOW_ACTIVE",
          details: {
            executionId: deliveryDecision.executionId,
            status: deliveryDecision.status,
            // The act that clears the block, machine-readable beside the
            // sentence: this refusal is advisory and the publish actor repeats
            // it under the lock, so both refusals name one remedy.
            remedy: deliveryDecision.remedy,
          },
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

    const { targetBranch, targetWorktreePath } = await deps.resolveMergeTarget(
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
      targetWorktreePath: targetWorktreePath ?? undefined,
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

    const { targetBranch, targetWorktreePath } = await deps.resolveMergeTarget(
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
      targetBranch,
      targetWorktreePath: targetWorktreePath ?? undefined,
      resolutionContext: priorJob?.resolutionContext,
      executionId: priorJob?.executionId,
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

  /** POST /api/projects/[name]/sessions/[session]/merge/land — publish a prepared squash commit */
  async function landSession(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const r = await resolveRoute(context);
    if (!r.ok) return r.response;
    const { projectPath, projectName, sessionName, session } = r.value;

    const prepared = resolvePreparedJob(projectPath, sessionName);
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

    const actualSha = await readParkedRefSha(projectPath, parkedRef);
    if (actualSha === null || actualSha !== preparedSha) {
      return NextResponse.json(
        {
          error: `Parked ref ${parkedRef} no longer resolves to the prepared commit`,
          code: "PARKED_REF_MISSING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const { targetBranch, targetWorktreePath } = await deps.resolveMergeTarget(
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
      targetWorktreePath: targetWorktreePath ?? undefined,
      entryMode: "land",
      preparedSha,
      expectedTargetSha,
      parkedRef,
      resolutionContext: job.resolutionContext,
      executionId: job.executionId,
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

    const prepared = resolvePreparedJob(projectPath, sessionName);
    if (!prepared.ok) return prepared.response;
    const { parkedRef, preparedSha } = prepared.value;

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
export const landSession = withTracing(_defaultHandlers.landSession);
export const discardSession = withTracing(_defaultHandlers.discardSession);
