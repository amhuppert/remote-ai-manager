import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { readRepoConfig } from "@/lib/repo-config";
import { withTracing } from "@/lib/logging";
import * as registry from "@/lib/dev-server-registry";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/dev-servers/start-all */
export const POST = withTracing(async (_request, { params }) => {
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

  const repoConfig = await readRepoConfig(sessionState.worktreePath);
  const configuredServers = repoConfig?.devServers;
  if (!configuredServers || configuredServers.length === 0) {
    return NextResponse.json(
      {
        error: "No dev servers configured for this project",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  // Start all configured servers that aren't already running
  for (const cfg of configuredServers) {
    const existing = registry.getServer({
      projectPath,
      sessionName: session ?? "",
      serverName: cfg.name,
    });
    if (
      existing &&
      (existing.status === "starting" || existing.status === "running")
    ) {
      continue; // Skip already active servers
    }

    registry.startServer({
      projectPath,
      sessionName: session ?? "",
      serverName: cfg.name,
      command: cfg.command,
      worktreePath: sessionState.worktreePath,
    });
  }

  return NextResponse.json({ status: "accepted" }, { status: 202 });
});
