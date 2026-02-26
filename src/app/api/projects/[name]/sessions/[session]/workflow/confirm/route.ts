import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { startOrchestrator } from "@/lib/ralph-loop/orchestrator";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Confirm plan and start the orchestrator loop */
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

  if (!session.workflow) {
    return NextResponse.json(
      { error: "No workflow exists" } satisfies ApiError,
      { status: 404 },
    );
  }

  if (session.workflow.status !== "planning") {
    return NextResponse.json(
      {
        error: "Workflow can only be confirmed during planning phase",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  // Validate prerequisites
  if (!session.workflow.objective.trim()) {
    return NextResponse.json(
      { error: "Objective cannot be empty" } satisfies ApiError,
      { status: 400 },
    );
  }

  if (session.workflow.fixPlan.length === 0) {
    return NextResponse.json(
      { error: "Fix plan must have at least one task" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Dispatch the orchestrator
  startOrchestrator({
    projectPath,
    session,
    workflow: session.workflow,
  });

  return NextResponse.json({ workflow: session.workflow }, { status: 202 });
});
