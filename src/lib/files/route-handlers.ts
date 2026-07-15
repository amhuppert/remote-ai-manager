/**
 * Files route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createFilesRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  scanProjectFiles as defaultScanProjectFiles,
  type ScanOptions,
  type ScanResult,
} from "@/lib/files/file-scanner";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import type { ApiError } from "@/lib/api/errors";
import type { GlobalConfig } from "@/lib/config/schemas";
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface FilesRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  scanProjectFiles(projectPath: string, opts: ScanOptions): Promise<ScanResult>;
  readConfig(): Promise<GlobalConfig>;
}

const defaultDeps: FilesRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
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

export function createFilesRouteHandlers(deps: FilesRouteDeps = defaultDeps) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    try {
      const { ignorePatterns } = await deps.readConfig();
      const result = await deps.scanProjectFiles(projectPath, {
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

const _defaultFilesHandlers = createFilesRouteHandlers();
export const listProjectFiles = withTracing(_defaultFilesHandlers.GET);
