import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getCommitLog } from "@/lib/git-operations";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/commits — list commits since divergence */
export const GET = withTracing(async (_request, { params }) => {
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
});
