import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { computeDiff } from "./diff";
import { resolveMergeTarget } from "./merge-target";
import { getCommitLog, getCommitDiff } from "./commits";
import { commitRequestSchema } from "./schemas";
import {
  smartMergeRequestSchema,
  resolveConflictsRequestSchema,
} from "@/lib/jobs/schemas";
import {
  dispatchCommitJob,
  dispatchMergeJob,
  dispatchResolveConflictsJob,
  getJob,
} from "@/lib/jobs/queue";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
const diffLogger = createLogger("api.diff");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/** GET /api/projects/[name]/sessions/[session]/diff — get uncommitted diff */
export const getSessionDiff = withTracing(
  async (_request, { params }: RouteContext) => {
    const t0 = performance.now();
    const { name, session } = await params;
    const tParams = performance.now();

    const projectPath = await resolveProjectPath(name ?? "");
    const tResolve = performance.now();
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessionState = await getSession(projectPath, session ?? "");
    const tSession = performance.now();
    if (!sessionState) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const diff = await computeDiff(sessionState.worktreePath);
      const tDiff = performance.now();
      const response = NextResponse.json(diff);
      const tSerialize = performance.now();

      diffLogger.info("diff.timing", {
        paramsMs: +(tParams - t0).toFixed(2),
        resolveMs: +(tResolve - tParams).toFixed(2),
        sessionMs: +(tSession - tResolve).toFixed(2),
        diffMs: +(tDiff - tSession).toFixed(2),
        serializeMs: +(tSerialize - tDiff).toFixed(2),
        durationMs: +(tSerialize - t0).toFixed(2),
      });

      return response;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/**
 * GET /api/projects/[name]/diff — read-only uncommitted diff of the project's
 * main (repo-root) worktree, consumed by the project-conversation cockpit. The
 * main worktree is the project path itself (no session branch); the diff is the
 * same working-tree-vs-HEAD computation the session surface uses. Read-only:
 * this route exposes no commit/discard/reset — those live on the session path.
 */
export const getMainWorktreeDiff = withTracing(
  async (_request, { params }: RouteContext) => {
    const { name } = await params;

    const projectPath = await resolveProjectPath(name ?? "");
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const diff = await computeDiff(projectPath);
      return NextResponse.json(diff);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to compute diff";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/** GET /api/projects/[name]/sessions/[session]/commits — list commits since divergence */
export const listSessionCommits = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const commits = await getCommitLog(
        session.worktreePath,
        session.targetBranch,
      );
      return NextResponse.json({ commits });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch commits";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/** GET /api/projects/[name]/sessions/[session]/commits/[hash]/diff — per-commit diff */
export const getSessionCommitDiff = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const hash = resolvedParams["hash"] ?? "";

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (!hash) {
      return NextResponse.json(
        { error: "Commit hash is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const diff = await getCommitDiff(
        session.worktreePath,
        hash,
        session.targetBranch,
      );
      return NextResponse.json(diff);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch commit diff";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/** POST /api/projects/[name]/sessions/[session]/commit — dispatch async commit job */
export const commitSession = withTracing(
  async (request, { params }: RouteContext) => {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (session.finished) {
      return NextResponse.json(
        {
          error: "Session is finished and read-only",
          code: "SESSION_FINISHED",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: { message: string };
    try {
      body = commitRequestSchema.parse(await bodyPromise);
    } catch {
      return NextResponse.json(
        { error: "Commit message is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    const result = dispatchCommitJob({
      projectPath,
      projectName: name,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: body.message,
      targetBranch: session.targetBranch,
    });

    if (!result.ok) {
      const code = result.error;
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

    return NextResponse.json(
      {
        jobId: result.value.jobId,
        jobType: "commit" as const,
        branchName: session.branchName,
        startedAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  },
);

/** POST /api/projects/[name]/sessions/[session]/merge — dispatch async merge job */
export const mergeSession = withTracing(
  async (request, { params }: RouteContext) => {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (session.finished) {
      return NextResponse.json(
        {
          error: "Session is finished and read-only",
          code: "SESSION_FINISHED",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: { autoResolve: boolean };
    try {
      body = smartMergeRequestSchema.parse(await bodyPromise);
    } catch {
      return NextResponse.json(
        {
          error: "autoResolve flag is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const { targetBranch, targetWorktreePath } = await resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    const result = dispatchMergeJob({
      projectPath,
      projectName: name,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: mergeMessage,
      autoResolve: body.autoResolve,
      targetBranch,
      targetWorktreePath: targetWorktreePath ?? undefined,
    });

    if (!result.ok) {
      const code = result.error;
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

    return NextResponse.json(
      {
        jobId: result.value.jobId,
        jobType: "merge" as const,
        branchName: session.branchName,
        startedAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  },
);

/** POST /api/projects/[name]/sessions/[session]/resolve-conflicts — dispatch async conflict resolution job */
export const resolveSessionConflicts = withTracing(
  async (request, { params }: RouteContext) => {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: {
      decisions?: {
        file: string;
        decision: "approved" | "rejected" | "pending";
        feedback?: string;
      }[];
    };
    try {
      body = resolveConflictsRequestSchema.parse(await bodyPromise);
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" } satisfies ApiError,
        { status: 400 },
      );
    }

    const { targetBranch, targetWorktreePath } = await resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    // The conflicts-terminal merge job (still in the registry) carries the
    // intent notes generated at /merge time; reuse them for the retry.
    const priorJob = getJob(projectPath, sessionName);

    const result = dispatchResolveConflictsJob({
      projectPath,
      projectName: name,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      mergeMessage,
      decisions: body.decisions,
      targetBranch,
      targetWorktreePath: targetWorktreePath ?? undefined,
      resolutionContext: priorJob?.resolutionContext,
    });

    if (!result.ok) {
      const code = result.error;
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

    return NextResponse.json(
      {
        jobId: result.value.jobId,
        jobType: "resolve-conflicts" as const,
        branchName: session.branchName,
        startedAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  },
);

// ============================================================
// Land / Discard prepared merge — dispatch helpers + deps
// ============================================================

interface PreparedMergeRouteDeps {
  gitClient: GitClient;
}

let preparedMergeRouteDeps: PreparedMergeRouteDeps = {
  gitClient: defaultGitClient,
};

export function setPreparedMergeRouteDeps(
  deps: Partial<PreparedMergeRouteDeps>,
): void {
  preparedMergeRouteDeps = { ...preparedMergeRouteDeps, ...deps };
}

export function _resetPreparedMergeRouteDepsForTesting(): void {
  preparedMergeRouteDeps = { gitClient: defaultGitClient };
}

async function readParkedRefSha(
  projectPath: string,
  parkedRef: string,
): Promise<string | null> {
  try {
    const { stdout } = await preparedMergeRouteDeps.gitClient.git(
      ["rev-parse", "--verify", parkedRef],
      projectPath,
    );
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** POST /api/projects/[name]/sessions/[session]/merge/land — publish a prepared squash commit */
export const landSession = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const existingJob = getJob(projectPath, sessionName);
    if (!existingJob) {
      return NextResponse.json(
        { error: "No prepared merge for this session" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (existingJob.status !== "ready-to-land") {
      return NextResponse.json(
        {
          error: `Job is not ready to land (status: ${existingJob.status})`,
          code: "JOB_NOT_READY_TO_LAND",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const parkedRef =
      existingJob.parkedRef ?? `refs/cc-merges/${existingJob.jobId}`;
    const preparedSha = existingJob.preparedSha ?? null;
    if (!preparedSha) {
      return NextResponse.json(
        {
          error: "Prepared commit SHA missing from job record",
          code: "PREPARED_SHA_MISSING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const expectedTargetSha = existingJob.expectedTargetSha ?? null;
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

    const { targetBranch, targetWorktreePath } = await resolveMergeTarget(
      projectPath,
      session,
    );
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    const result = dispatchMergeJob({
      projectPath,
      projectName: name,
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
      resolutionContext: existingJob.resolutionContext,
    });

    if (!result.ok) {
      const code = result.error;
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

    return NextResponse.json(
      {
        jobId: result.value.jobId,
        jobType: "merge" as const,
        branchName: session.branchName,
        startedAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  },
);

/** POST /api/projects/[name]/sessions/[session]/merge/discard — drop a parked prepared commit */
export const discardSession = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const existingJob = getJob(projectPath, sessionName);
    if (!existingJob) {
      return NextResponse.json(
        { error: "No prepared merge for this session" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (existingJob.status !== "ready-to-land") {
      return NextResponse.json(
        {
          error: `Job is not ready to land (status: ${existingJob.status})`,
          code: "JOB_NOT_READY_TO_LAND",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const parkedRef =
      existingJob.parkedRef ?? `refs/cc-merges/${existingJob.jobId}`;
    const preparedSha = existingJob.preparedSha ?? null;
    if (!preparedSha) {
      return NextResponse.json(
        {
          error: "Prepared commit SHA missing from job record",
          code: "PREPARED_SHA_MISSING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const targetBranch = session.targetBranch ?? "main";
    const mergeMessage = `Discard prepared merge for ${session.branchName}`;

    const result = dispatchMergeJob({
      projectPath,
      projectName: name,
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

    if (!result.ok) {
      const code = result.error;
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

    return NextResponse.json(
      {
        jobId: result.value.jobId,
        jobType: "merge" as const,
        branchName: session.branchName,
        startedAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  },
);
