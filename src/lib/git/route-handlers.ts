import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { computeDiff } from "./diff";
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
} from "@/lib/jobs/queue";
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
        totalMs: +(tSerialize - t0).toFixed(2),
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

    const targetBranch = session.targetBranch ?? "main";
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    // Resolve parent worktree path when targeting a non-main branch
    let targetWorktreePath: string | undefined;
    if (targetBranch !== "main" && session.parentSessionName) {
      const parentSession = await getSession(
        projectPath,
        session.parentSessionName,
      );
      targetWorktreePath = parentSession?.worktreePath;
    }

    const result = dispatchMergeJob({
      projectPath,
      projectName: name,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: mergeMessage,
      autoResolve: body.autoResolve,
      targetBranch,
      targetWorktreePath,
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

    const targetBranch = session.targetBranch ?? "main";
    const mergeMessage = `Merge ${session.branchName} into ${targetBranch}`;

    // Resolve parent worktree path when targeting a non-main branch
    let targetWorktreePath: string | undefined;
    if (targetBranch !== "main" && session.parentSessionName) {
      const parentSession = await getSession(
        projectPath,
        session.parentSessionName,
      );
      targetWorktreePath = parentSession?.worktreePath;
    }

    const result = dispatchResolveConflictsJob({
      projectPath,
      projectName: name,
      sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      mergeMessage,
      decisions: body.decisions,
      targetBranch,
      targetWorktreePath,
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
