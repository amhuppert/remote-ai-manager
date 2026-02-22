import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getContainerLogs } from "@/lib/devcontainer";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/container-logs — get container logs */
export const GET = withTracing(async (request, { params }) => {
  const { name, session } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessionState = await getSession(projectPath, session ?? "");
  if (!sessionState) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  if (!sessionState.containerId) {
    return NextResponse.json(
      { error: "No container associated with this session" } satisfies ApiError,
      { status: 404 },
    );
  }

  // Parse tail query parameter (default: 100 lines)
  const url = new URL(request.url);
  const tailParam = url.searchParams.get("tail");
  const tail = tailParam ? parseInt(tailParam, 10) : 100;

  try {
    const logs = await getContainerLogs(sessionState.containerId, tail);
    return NextResponse.json({ logs });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to get container logs";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
