import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getCommitDiff } from "@/lib/git-operations";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/commits/[hash]/diff — per-commit diff */
export const GET = withTracing(async (_request, { params }) => {
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
    const diff = await getCommitDiff(session.worktreePath, hash);
    return NextResponse.json(diff);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch commit diff";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
