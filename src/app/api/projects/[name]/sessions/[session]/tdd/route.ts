import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, setSessionTddEnabled } from "@/lib/state";
import { sessionTddRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** PATCH /api/projects/[name]/sessions/[session]/tdd — toggle TDD mode */
export const PATCH = withTracing(async (request, { params }) => {
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

  let body: { tddEnabled: boolean };
  try {
    body = sessionTddRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "tddEnabled (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await setSessionTddEnabled(projectPath, sessionName, body.tddEnabled);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update TDD mode";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
