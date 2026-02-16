import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getProjectSessions } from "@/lib/state";
import { createSession, deleteSession } from "@/lib/sessions";
import { createSessionRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions — list all sessions */
export const GET = withTracing(async (_request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessions = await getProjectSessions(projectPath);
  return NextResponse.json(sessions);
});

/** POST /api/projects/[name]/sessions — create a new session */
export const POST = withTracing(async (request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body: { sessionName: string };
  try {
    body = createSessionRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "sessionName is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const session = await createSession(projectPath, body.sessionName.trim());
    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create session";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 400,
    });
  }
});

/** DELETE /api/projects/[name]/sessions?sessionName=xxx — delete a session */
export const DELETE = withTracing(async (request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const sessionName = url.searchParams.get("sessionName");
  if (!sessionName) {
    return NextResponse.json(
      { error: "sessionName query parameter is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await deleteSession(projectPath, sessionName);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete session";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 400,
    });
  }
});
