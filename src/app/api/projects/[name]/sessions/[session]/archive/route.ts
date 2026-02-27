import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, setSessionArchived } from "@/lib/state";
import { stopAllForSession } from "@/lib/dev-server-registry";
import { sessionArchiveRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** PATCH /api/projects/[name]/sessions/[session]/archive — archive/unarchive session */
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

  let body: { archived: boolean };
  try {
    body = sessionArchiveRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "archived (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    // Stop all dev servers when archiving (best-effort, don't block)
    if (body.archived) {
      try {
        await stopAllForSession({ projectPath, sessionName });
      } catch {
        // best-effort: don't block archival
      }
    }

    await setSessionArchived(projectPath, sessionName, body.archived);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update archive state";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
