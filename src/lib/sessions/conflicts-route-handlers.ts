/**
 * Route handler for fetching the conflict analysis for a session.
 *
 * Returns the most recent conflict-analysis record produced by the jobs
 * queue for the resolved session, or 404 if none has been computed.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { getConflictAnalysis } from "@/lib/jobs/queue";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

/** GET /api/projects/[name]/sessions/[session]/conflicts — get conflict analysis */
export const getSessionConflicts = withTracing(async (_request, { params }) => {
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

  const analysis = getConflictAnalysis(projectPath, sessionName);
  if (!analysis) {
    return NextResponse.json(
      {
        error: "No conflict analysis found for this session",
      } satisfies ApiError,
      { status: 404 },
    );
  }

  return NextResponse.json(analysis);
});
