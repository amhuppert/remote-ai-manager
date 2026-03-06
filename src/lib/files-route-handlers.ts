/**
 * Files route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createFilesRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { scanProjectFiles as defaultScanProjectFiles } from "@/lib/file-scanner";
import type { ApiError, FileItem, ProjectFilesResponse } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface FilesRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  scanProjectFiles: (projectPath: string) => Promise<FileItem[]>;
}

const defaultDeps: FilesRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  scanProjectFiles: defaultScanProjectFiles,
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

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const items = await deps.scanProjectFiles(projectPath);
      const response: ProjectFilesResponse = { items };
      return NextResponse.json(response);
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
