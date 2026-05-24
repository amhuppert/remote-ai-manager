/**
 * Archive route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createArchiveRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { setProjectArchived as defaultSetProjectArchived } from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ArchiveRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  setProjectArchived: (projectPath: string, archived: boolean) => Promise<void>;
}

const defaultDeps: ArchiveRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  setProjectArchived: defaultSetProjectArchived,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const archiveRequestSchema = z.object({
  archived: z.boolean(),
});

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createArchiveRouteHandlers(
  deps: ArchiveRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: { archived: boolean };
    try {
      body = archiveRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "archived (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.setProjectArchived(projectPath, body.archived);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { POST };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultArchiveHandlers = createArchiveRouteHandlers();
export const archiveProject = _defaultArchiveHandlers.POST;
