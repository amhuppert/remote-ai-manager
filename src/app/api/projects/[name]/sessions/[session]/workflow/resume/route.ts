import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { startOrchestrator } from "@/lib/ralph-loop/orchestrator";
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
    session.workflow.haltReason = null;
  }

  startOrchestrator({
    projectPath,
    session,
    workflow: session.workflow,
  });

  return NextResponse.json({ workflow: session.workflow }, { status: 202 });
});
