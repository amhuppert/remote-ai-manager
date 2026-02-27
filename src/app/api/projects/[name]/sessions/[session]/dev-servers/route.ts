import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { readRepoConfig } from "@/lib/repo-config";
import { withTracing } from "@/lib/logging";
import * as registry from "@/lib/dev-server-registry";
import type { ApiError, DevServersStatusResponse } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/dev-servers — get dev server status */
export const GET = withTracing(async (_request, { params }) => {
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

  const repoConfig = await readRepoConfig(projectPath);
  const configuredServers = repoConfig?.devServers ?? [];

  // Merge configured servers with runtime state
  const runtimeServers = registry.getSessionServers({
    projectPath,
    sessionName: session ?? "",
  });

  const servers = configuredServers.map((cfg) => {
    const runtime = runtimeServers.find((r) => r.serverName === cfg.name);
    if (runtime) {
      return {
        serverName: runtime.serverName,
        command: runtime.command,
        status: runtime.status,
        pid: runtime.pid,
        port: runtime.port,
        remoteUrl: runtime.remoteUrl,
        startedAt: runtime.startedAt,
        errorMessage: runtime.errorMessage,
        recentOutput: runtime.recentOutput,
        adopted: runtime.adopted,
      };
    }
    // Configured but not started
    return {
      serverName: cfg.name,
      command: cfg.command,
      status: "stopped" as const,
      pid: null,
      port: null,
      remoteUrl: null,
      startedAt: null,
      errorMessage: null,
      recentOutput: [],
      adopted: false,
    };
  });

  return NextResponse.json({ servers } satisfies DevServersStatusResponse);
});
