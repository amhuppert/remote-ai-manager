import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { withTracing } from "@/lib/logging";
import * as registry from "@/lib/dev-server-registry";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/stop */
export const POST = withTracing(async (_request, { params }) => {
  const { name, session, serverName } = await params;
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

  const existing = registry.getServer({
    projectPath,
    sessionName: session ?? "",
    serverName: serverName ?? "",
  });
  if (
    !existing ||
    (existing.status !== "running" && existing.status !== "starting")
  ) {
    return NextResponse.json(
      { error: `Server "${serverName}" is not running` } satisfies ApiError,
      { status: 404 },
    );
  }

  await registry.stopServer({
    projectPath,
    sessionName: session ?? "",
    serverName: serverName ?? "",
  });

  return NextResponse.json({ status: "ok" });
});
