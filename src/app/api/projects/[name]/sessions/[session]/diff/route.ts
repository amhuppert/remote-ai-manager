import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { computeDiff } from "@/lib/diff";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/diff — get uncommitted diff */
export const GET = withTracing(async (_request, { params }) => {
  const { name, session } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessionState = await getSession(projectPath, session ?? "");
  if (!sessionState) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  try {
    const diff = await computeDiff(sessionState.worktreePath);
    return NextResponse.json(diff);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to compute diff";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
