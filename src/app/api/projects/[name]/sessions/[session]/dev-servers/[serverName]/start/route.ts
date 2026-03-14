import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { readRepoConfig } from "@/lib/repo-config";
import { withTracing } from "@/lib/logging";
import * as registry from "@/lib/dev-server-registry";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/start */
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

  const serverConfig = configuredServers.find(
    (s) => s.name === (serverName ?? ""),
  );
  if (!serverConfig) {
    return NextResponse.json(
      {
        error: `Dev server "${serverName}" not found in configuration`,
      } satisfies ApiError,
      { status: 404 },
    );
  }

  // Check if already running
  const existing = registry.getServer({
    projectPath,
    sessionName: session ?? "",
    serverName: serverName ?? "",
  });
  if (
    existing &&
    (existing.status === "starting" || existing.status === "running")
  ) {
    return NextResponse.json(
      {
        error: `Server "${serverName}" is already ${existing.status}`,
      } satisfies ApiError,
      { status: 409 },
    );
  }

  // Start asynchronously
  registry.startServer({
    projectPath,
    sessionName: session ?? "",
    serverName: serverConfig.name,
    command: serverConfig.command,
    worktreePath: sessionState.worktreePath,
  });

  return NextResponse.json({ status: "accepted" }, { status: 202 });
});
