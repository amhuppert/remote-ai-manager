import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { startWorkflow } from "@/lib/workflows/ralph-loop/workflow-manager";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Confirm plan and start the XState workflow actor */
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

  // Start the XState workflow actor
  startWorkflow({
    projectPath,
    projectName: projectPath.split("/").pop() ?? projectPath,
    sessionName,
    objective: session.workflow.objective,
    config: session.workflow.config,
    fixPlan: session.workflow.fixPlan,
    worktreePath: session.worktreePath,
    iterations: session.workflow.iterations,
    circuitBreaker: session.workflow.circuitBreaker,
    totalCostUsd: session.workflow.totalCostUsd,
    totalDurationMs: session.workflow.totalDurationMs,
  });

  return NextResponse.json({ workflow: session.workflow }, { status: 202 });
});
