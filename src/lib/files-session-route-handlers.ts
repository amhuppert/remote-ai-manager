/**
 * Session-scoped files route handler logic — extracted for dependency injection.
 *
 * The route file at
 * `src/app/api/projects/[name]/sessions/[session]/files/route.ts`
 * delegates to these handlers, passing production deps.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import {
  scanProjectFiles as defaultScanProjectFiles,
  type ScanOptions,
  type ScanResult,
} from "@/lib/file-scanner";
import { readConfig as defaultReadConfig } from "@/lib/config";
import type { ApiError, GlobalConfig, SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface SessionFilesRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  scanProjectFiles(projectPath: string, opts: ScanOptions): Promise<ScanResult>;
  readConfig(): Promise<GlobalConfig>;
}

const defaultDeps: SessionFilesRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  scanProjectFiles: defaultScanProjectFiles,
  readConfig: defaultReadConfig,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionFilesRouteHandlers(
  deps: SessionFilesRouteDeps = defaultDeps,
) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const name = params["name"] ?? "";
    const sessionName = params["session"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessionState = await deps.getSession(projectPath, sessionName);
    if (!sessionState) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const { ignorePatterns } = await deps.readConfig();
      const result = await deps.scanProjectFiles(sessionState.worktreePath, {
        ignorePatterns,
      });
      return NextResponse.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to scan files";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { GET };
}
