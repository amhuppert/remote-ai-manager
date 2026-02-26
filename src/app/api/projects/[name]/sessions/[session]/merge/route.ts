import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { smartMergeRequestSchema } from "@/lib/schemas";
import { dispatchMergeJob } from "@/lib/background-jobs";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/merge — dispatch async merge job */
export const POST = withTracing(async (request, { params }) => {
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
    body = smartMergeRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      {
        error: "autoResolve flag is required",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  const mergeMessage = `Merge ${session.branchName} into main`;

  const result = dispatchMergeJob({
    projectPath,
    projectName: name,
    sessionName,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    message: mergeMessage,
    autoResolve: body.autoResolve,
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
});
