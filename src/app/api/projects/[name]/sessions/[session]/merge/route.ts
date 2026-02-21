import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, setSessionFinished } from "@/lib/state";
import { acquireSessionLock } from "@/lib/lock";
import { mergeRequestSchema } from "@/lib/schemas";
import {
  hasUncommittedChanges,
  getCommitLog,
  squashMerge,
} from "@/lib/git-operations";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/merge — squash merge into main */
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

  let body: { message: string };
  try {
    body = mergeRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Merge message is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  let release: (() => void) | undefined;
  try {
    release = acquireSessionLock(projectPath, sessionName);
  } catch {
    return NextResponse.json(
      { error: "Session is busy", code: "SESSION_BUSY" } satisfies ApiError,
      { status: 409 },
    );
  }

  try {
    // Check worktree has no uncommitted changes
    const hasChanges = await hasUncommittedChanges(session.worktreePath);
    if (hasChanges) {
      return NextResponse.json(
        {
          error: "Uncommitted changes must be committed before merging",
          code: "UNCOMMITTED_CHANGES",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    // Check there are commits to merge
    const commits = await getCommitLog(session.worktreePath);
    if (commits.length === 0) {
      return NextResponse.json(
        {
          error: "No commits to merge",
          code: "NO_COMMITS",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    // Execute squash merge (checks project root is clean internally)
    const result = await squashMerge(
      projectPath,
      session.branchName,
      body.message,
    );

    // Mark session as finished + archived
    await setSessionFinished(projectPath, sessionName);

    return NextResponse.json({
      success: true,
      mergeHash: result.mergeHash,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to merge session";

    // Surface specific pre-condition errors as 409
    if (message.includes("Merge conflicts detected")) {
      return NextResponse.json(
        { error: message, code: "MERGE_CONFLICT" } satisfies ApiError,
        { status: 409 },
      );
    }

    if (
      message.includes("Main branch has uncommitted changes") ||
      message.includes("uncommitted")
    ) {
      return NextResponse.json(
        { error: message, code: "MAIN_DIRTY" } satisfies ApiError,
        { status: 409 },
      );
    }

    const gitOutput = (err as Error & { gitOutput?: string }).gitOutput;
    const errorResponse: ApiError = { error: message };
    if (gitOutput) errorResponse.output = gitOutput;
    return NextResponse.json(errorResponse, { status: 500 });
  } finally {
    release?.();
  }
});
