/**
 * Route handler for fetching the conflict analysis for a session.
 *
 * Returns the most recent conflict-analysis record produced by the jobs
 * queue for the resolved session, or 404 if none has been computed.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { getConflictAnalysis } from "@/lib/jobs/queue";
import { withTracing } from "@/lib/logging";

/** GET /api/projects/[name]/sessions/[session]/conflicts — get conflict analysis */
export const getSessionConflicts = withTracing(async (_request, { params }) => {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const resolved = await resolveProjectSessionOr404(
    { resolveProjectPath, getSession },
    name,
    sessionName,
  );
  if (!resolved.ok) return resolved.response;
  const { projectPath } = resolved.value;

  const analysis = getConflictAnalysis(projectPath, sessionName);
  if (!analysis) {
    return notFound("No conflict analysis found for this session");
  }

  return NextResponse.json(analysis);
});
