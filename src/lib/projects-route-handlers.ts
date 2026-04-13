/**
 * Projects route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createProjectsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { discoverProjects as defaultDiscoverProjects } from "@/lib/discovery";
import { recoverOrphanedConversations as defaultRecoverOrphaned } from "@/lib/state";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import type { DiscoveredProject } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ProjectsRouteDeps {
  discoverProjects: () => Promise<DiscoveredProject[]>;
  recoverOrphanedConversations?: (
    isQueryActive: (conversationId: string) => boolean,
  ) => Promise<number>;
}

const defaultDeps: ProjectsRouteDeps = {
  discoverProjects: defaultDiscoverProjects,
  recoverOrphanedConversations: defaultRecoverOrphaned,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProjectsRouteHandlers(
  deps: ProjectsRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    try {
      // Recover conversations stuck in "running" with no active SDK query.
      // Runs on every project list fetch to prevent stale "running" badges.
      await deps.recoverOrphanedConversations?.(
        (id) => getRuntime(id) !== undefined,
      );

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
