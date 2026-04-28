/**
 * Projects route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createProjectsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { discoverProjects as defaultDiscoverProjects } from "@/lib/discovery";
import type { DiscoveredProject } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ProjectsRouteDeps {
  discoverProjects: () => Promise<DiscoveredProject[]>;
}

const defaultDeps: ProjectsRouteDeps = {
  discoverProjects: defaultDiscoverProjects,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProjectsRouteHandlers(
  deps: ProjectsRouteDeps = defaultDeps,
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
