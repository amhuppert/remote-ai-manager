/**
 * Archive route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createArchiveRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getProjectSessionListItems as defaultGetProjectSessionListItems,
  setProjectArchived as defaultSetProjectArchived,
} from "@/lib/state-store";
import { stopAllForSession as defaultStopAllForSession } from "@/lib/dev-server/registry";
import { createLogger } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("project-archive-route");
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ArchiveRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  setProjectArchived: (projectPath: string, archived: boolean) => Promise<void>;
  getProjectSessionListItems: (
    projectPath: string,
  ) => Promise<Array<{ sessionName: string }>>;
  stopAllForSession: (params: {
    projectPath: string;
    sessionName: string;
  }) => Promise<void>;
}

const defaultDeps: ArchiveRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  setProjectArchived: defaultSetProjectArchived,
  getProjectSessionListItems: defaultGetProjectSessionListItems,
  stopAllForSession: defaultStopAllForSession,
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

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

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
      // Archiving a project is a lifecycle event: stop every session's dev
      // servers so none keep running in the background. Best-effort per session
      // — failures never block archival. Unarchive does not restart them.
      if (body.archived) {
        try {
          const sessions = await deps.getProjectSessionListItems(projectPath);
          for (const session of sessions) {
            try {
              await deps.stopAllForSession({
                projectPath,
                sessionName: session.sessionName,
              });
            } catch {
              // best-effort: don't block archival
            }
          }
          logger.info("project.archive.dev_servers_stopped", {
            projectPath,
            sessionCount: sessions.length,
          });
        } catch {
          // best-effort: don't block archival
        }
      }

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
