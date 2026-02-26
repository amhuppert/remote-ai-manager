import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { dispatchPlanGeneration } from "@/lib/ralph-loop/plan-generator";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST — Trigger AI plan generation */
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
        error: "Plan generation only available during planning phase",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  // Mark generation in progress so the UI can show a loading state
  await mutateSession(
    projectPath,
    sessionName,
    "generatePlan.setGenerating",
    (sess) => {
      if (sess.workflow) sess.workflow.generatingPlan = true;
      return null;
    },
  );

  dispatchPlanGeneration({ projectPath, session, workflow: session.workflow });

  return NextResponse.json({ status: "generating" }, { status: 202 });
});
