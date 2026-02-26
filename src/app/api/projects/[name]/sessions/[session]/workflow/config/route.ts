import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, updateSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import { ralphLoopConfigSchema } from "@/lib/schemas";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** PUT — Update workflow configuration (only during planning or paused) */
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
      { error: "Config can only be edited during planning or paused phases" } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" } satisfies ApiError,
      { status: 400 },
    );
  }

  const parsed = ralphLoopConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid config: ${parsed.error.message}` } satisfies ApiError,
      { status: 400 },
    );
  }

  session.workflow.config = parsed.data;
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);

  return NextResponse.json({ config: session.workflow.config });
});
