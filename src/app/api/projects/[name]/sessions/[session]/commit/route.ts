import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { acquireSessionLock } from "@/lib/lock";
import { commitRequestSchema } from "@/lib/schemas";
import { commitChanges, hasUncommittedChanges } from "@/lib/git-operations";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/commit — commit all changes */
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
    body = commitRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Commit message is required" } satisfies ApiError,
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
    const hasChanges = await hasUncommittedChanges(session.worktreePath);
    if (!hasChanges) {
      return NextResponse.json(
        {
          error: "No uncommitted changes to commit",
          code: "NO_CHANGES",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const result = await commitChanges(session.worktreePath, body.message);
    return NextResponse.json({ success: true, hash: result.hash });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to commit changes";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  } finally {
    release?.();
  }
});
