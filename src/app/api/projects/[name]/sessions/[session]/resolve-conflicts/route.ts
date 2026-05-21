import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { resolveConflictsRequestSchema } from "@/lib/schemas";
import { dispatchResolveConflictsJob } from "@/lib/background-jobs";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/resolve-conflicts — dispatch async conflict resolution job */
export const POST = withTracing(async (request, { params }) => {
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
});
