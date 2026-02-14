import { NextResponse, type NextRequest } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getProjectSessions } from "@/lib/state";
import { createSession, deleteSession } from "@/lib/sessions";
import { createSessionRequestSchema } from "@/lib/schemas";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ name: string }> };

/** GET /api/projects/[name]/sessions — list all sessions */
export async function GET(
  _request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessions = await getProjectSessions(projectPath);
  return NextResponse.json(sessions);
}

/** POST /api/projects/[name]/sessions — create a new session */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { name } = await params;
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
}

/** DELETE /api/projects/[name]/sessions?sessionName=xxx — delete a session */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessionName = request.nextUrl.searchParams.get("sessionName");
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
}
