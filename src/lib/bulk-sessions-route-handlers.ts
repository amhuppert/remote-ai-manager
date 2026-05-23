/**
 * Bulk sessions route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createBulkSessionsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { setSessionArchived as defaultSetSessionArchived } from "@/lib/state";
import { deleteSession as defaultDeleteSession } from "@/lib/sessions";
import {
  bulkSessionsRequestSchema,
  type BulkSessionResult,
} from "@/lib/schemas";
import { createLogger } from "@/lib/logging";
import type { ApiError } from "@/types";

const logger = createLogger("bulk-sessions-route");

export interface BulkSessionsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void>;
  deleteSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ worktreeRemoved: boolean }>;
}

const defaultDeps: BulkSessionsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  setSessionArchived: defaultSetSessionArchived,
  deleteSession: defaultDeleteSession,
};

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export function createBulkSessionsRouteHandlers(
  deps: BulkSessionsRouteDeps = defaultDeps,
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

    const parsed = bulkSessionsRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: op must be archive|unarchive|delete; sessionNames must be 1–200 names",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const { op, sessionNames } = parsed.data;
    logger.info("bulk.start", {
      projectName: name,
      op,
      totalRequested: sessionNames.length,
    });

    const results: BulkSessionResult[] = [];
    for (const sessionName of sessionNames) {
      try {
        if (op === "delete") {
          await deps.deleteSession(projectPath, sessionName);
        } else {
          await deps.setSessionArchived(
            projectPath,
            sessionName,
            op === "archive",
          );
        }
        results.push({ sessionName, success: true });
        logger.info("bulk.item.ok", { projectName: name, op, sessionName });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Operation failed";
        results.push({ sessionName, success: false, error: message });
        logger.warn("bulk.item.error", {
          projectName: name,
          op,
          sessionName,
          error: message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;
    logger.info("bulk.complete", {
      projectName: name,
      op,
      totalRequested: sessionNames.length,
      successCount,
      failureCount,
    });

    return NextResponse.json({ results });
  }

  return { POST };
}
