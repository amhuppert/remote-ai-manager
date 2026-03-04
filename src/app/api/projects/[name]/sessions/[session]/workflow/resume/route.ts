import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { resumeWorkflow } from "@/lib/workflows/ralph-loop/workflow-manager";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Resume a paused or halted workflow */
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

  if (
    session.workflow.status !== "paused" &&
    session.workflow.status !== "halted"
  ) {
    return NextResponse.json(
      {
        error: "Workflow must be paused or halted to resume",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  // Clear halt reason when resuming from halted
  if (session.workflow.status === "halted") {
    await mutateSession(
      projectPath,
      sessionName,
      "workflow.clearHaltForResume",
      (sess) => {
        if (sess.workflow) {
          sess.workflow.haltReason = null;
        }
      },
    );
  }

  // Resume or create new actor with existing state
  resumeWorkflow({
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
