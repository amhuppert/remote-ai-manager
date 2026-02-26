import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, updateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { fixPlanTaskSchema } from "@/lib/schemas";
import { broadcast } from "@/lib/sse-broadcaster";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const updateFixPlanSchema = z.object({
  fixPlan: z.array(fixPlanTaskSchema),
});

/** PUT — Update fix plan (only during planning or paused) */
export const PUT = withTracing(async (request, { params }) => {
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
    session.workflow.status !== "planning" &&
    session.workflow.status !== "paused"
  ) {
    return NextResponse.json(
      {
        error: "Fix plan can only be edited during planning or paused phases",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: z.infer<typeof updateFixPlanSchema>;
  try {
    body = updateFixPlanSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid fix plan data" } satisfies ApiError,
      { status: 400 },
    );
  }

  session.workflow.fixPlan = body.fixPlan;
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);

  try {
    broadcast({
      type: "workflow-fix-plan-updated",
      projectName: name,
      sessionName,
      fixPlan: session.workflow.fixPlan,
      source: "user",
    });
  } catch {
    // fire-and-forget
  }

  return NextResponse.json({ fixPlan: session.workflow.fixPlan });
});
