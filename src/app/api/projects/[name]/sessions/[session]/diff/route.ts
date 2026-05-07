import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { computeDiff } from "@/lib/diff";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const logger = createLogger("api.diff");

/** GET /api/projects/[name]/sessions/[session]/diff — get uncommitted diff */
export const GET = withTracing(async (_request, { params }) => {
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

    logger.info("diff.timing", {
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
});
