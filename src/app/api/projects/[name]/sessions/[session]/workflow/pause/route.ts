import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { requestPause } from "@/lib/ralph-loop/orchestrator-registry";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Pause a running workflow (stops after current iteration) */
export const POST = withTracing(async (_request, { params }) => {
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

  if (!session.workflow || session.workflow.status !== "running") {
    return NextResponse.json(
      { error: "Workflow is not running" } satisfies ApiError,
      { status: 409 },
    );
  }

  const paused = requestPause(projectPath, sessionName);
  if (!paused) {
    return NextResponse.json(
      { error: "Workflow not found in orchestrator registry" } satisfies ApiError,
      { status: 409 },
    );
  }

  return NextResponse.json({ status: "pause_requested" });
});
