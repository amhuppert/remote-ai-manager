/**
 * Session-scoped files route handler logic — extracted for dependency injection.
 *
 * The route file at
 * `src/app/api/projects/[name]/sessions/[session]/files/route.ts`
 * delegates to these handlers, passing production deps.
 */

import { NextResponse } from "next/server";
import { resolveProjectSessionOr404 } from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import {
  scanProjectFiles as defaultScanProjectFiles,
  type ScanOptions,
  type ScanResult,
} from "@/lib/files/file-scanner";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
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

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const sessionState = resolved.value.session;

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

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultSessionFilesHandlers = createSessionFilesRouteHandlers();
export const listSessionFiles = withTracing(_defaultSessionFilesHandlers.GET);
