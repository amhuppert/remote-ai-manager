/**
 * Project route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createProjectRouteHandlers(deps)`.
 *
 * The DELETE handler resolves the project via the `projectPath` query parameter
 * rather than the `[name]` URL segment so orphan/missing projects (present in
 * state but not on disk) remain deletable.
 */

import { NextResponse } from "next/server";
import { deleteProject as defaultDeleteProject } from "@/lib/sessions";
import type { ApiError } from "@/types";

export interface ProjectRouteDeps {
  deleteProject(projectPath: string): Promise<{ sessionsRemoved: number }>;
}

const defaultDeps: ProjectRouteDeps = {
  deleteProject: defaultDeleteProject,
};

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export function createProjectRouteHandlers(
  deps: ProjectRouteDeps = defaultDeps,
) {
  async function DELETE(
    request: Request,
    _context: RouteContext,
  ): Promise<Response> {
    const projectPath = new URL(request.url).searchParams.get("projectPath");
    if (!projectPath) {
      return NextResponse.json(
        { error: "projectPath query parameter is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const { sessionsRemoved } = await deps.deleteProject(projectPath);
      return NextResponse.json({ success: true, sessionsRemoved });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete project";
      const status = message.startsWith("Project not found") ? 404 : 500;
      return NextResponse.json({ error: message } satisfies ApiError, {
        status,
      });
    }
  }

  return { DELETE };
}
