/**
 * Project route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via the `create*RouteHandlers(deps)`
 * factories.
 *
 * The DELETE handler resolves the project via the `projectPath` query parameter
 * rather than the `[name]` URL segment so orphan/missing projects (present in
 * state but not on disk) remain deletable.
 */

import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import { discoverProjects as defaultDiscoverProjects } from "@/lib/projects/discovery";
import {
  deleteProject as defaultDeleteProject,
  type DeleteProjectResult,
} from "@/lib/sessions/service";
import {
  getArchivedProjects as defaultGetArchivedProjects,
  getPinnedProjects as defaultGetPinnedProjects,
} from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
import type { DiscoveredProject } from "@/lib/projects/schemas";
type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

export interface ProjectsRouteDeps {
  discoverProjects(): Promise<DiscoveredProject[]>;
}

const defaultProjectsDeps: ProjectsRouteDeps = {
  discoverProjects: defaultDiscoverProjects,
};

export function createProjectsRouteHandlers(
  deps: ProjectsRouteDeps = defaultProjectsDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const projects = await deps.discoverProjects();
      return NextResponse.json(projects);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to discover projects";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// DELETE /api/projects/[name]
// ---------------------------------------------------------------------------

export interface ProjectRouteDeps {
  deleteProject(projectPath: string): Promise<DeleteProjectResult>;
}

const defaultProjectDeps: ProjectRouteDeps = {
  deleteProject: defaultDeleteProject,
};

export function createProjectRouteHandlers(
  deps: ProjectRouteDeps = defaultProjectDeps,
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
      const { sessionsRemoved, deletedTicketNumbers } =
        await deps.deleteProject(projectPath);
      return NextResponse.json({
        success: true,
        sessionsRemoved,
        deletedTicketNumbers,
      });
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

// ---------------------------------------------------------------------------
// GET /api/projects/preferences
// ---------------------------------------------------------------------------

export interface ProjectPreferencesRouteDeps {
  getArchivedProjects(): Promise<Set<string>>;
  getPinnedProjects(): Promise<Set<string>>;
}

const defaultPreferencesDeps: ProjectPreferencesRouteDeps = {
  getArchivedProjects: defaultGetArchivedProjects,
  getPinnedProjects: defaultGetPinnedProjects,
};

export function createProjectPreferencesRouteHandlers(
  deps: ProjectPreferencesRouteDeps = defaultPreferencesDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const [archivedSet, pinnedSet] = await Promise.all([
        deps.getArchivedProjects(),
        deps.getPinnedProjects(),
      ]);
      return NextResponse.json({
        archived: Array.from(archivedSet),
        pinned: Array.from(pinnedSet),
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to read project preferences";
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

const _defaultProjectsHandlers = createProjectsRouteHandlers();
export const listProjects = withTracing(_defaultProjectsHandlers.GET);

const _defaultProjectHandlers = createProjectRouteHandlers();
export const deleteProject = withTracing(_defaultProjectHandlers.DELETE);

const _defaultProjectPreferencesHandlers =
  createProjectPreferencesRouteHandlers();
export const getProjectPreferences = withTracing(
  _defaultProjectPreferencesHandlers.GET,
);
