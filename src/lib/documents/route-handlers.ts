/**
 * Route handler for the generic markdown content-by-path endpoint, extracted
 * for dependency injection. The route shell delegates to the
 * `withTracing`-wrapped named export; tests build handlers over a real-store
 * fixture (plus a faked `readFile`) via `createDocumentsRouteHandlers(deps)`.
 *
 * - GET /api/projects/[name]/sessions/[session]/document-content?path=
 *
 * Reads any markdown file addressed by a worktree-relative (or normalized
 * absolute-inside-worktree) path, confined to the session worktree and
 * markdown-only. A non-markdown/traversal path → 400; a missing file or an
 * absolute path outside the worktree → 404.
 */

import { readFile as defaultReadFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { normalizeDocPath, resolveWithinWorktree } from "@/lib/documents/path";
import {
  documentContentPathSchema,
  type DocumentContentResponse,
} from "./schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("documents-content-route");

// ---------------------------------------------------------------------------
// Deps interface (method syntax for bivariance)
// ---------------------------------------------------------------------------

export interface DocumentsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readFile(absPath: string): Promise<string>;
}

const defaultDeps: DocumentsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  readFile: (absPath) => defaultReadFile(absPath, "utf-8"),
};

type RouteContext = { params: Promise<Record<string, string>> };

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiError, { status });
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDocumentsRouteHandlers(
  deps: DocumentsRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return jsonError("Project not found", 404);

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return jsonError("Session not found", 404);

    const rawPath = documentContentPathSchema.safeParse(
      new URL(request.url).searchParams.get("path"),
    );
    if (!rawPath.success) return jsonError("path query is required", 400);

    const normalized = normalizeDocPath(rawPath.data, session.worktreePath);
    if (!normalized.ok) {
      // non-markdown / traversal → client error; outside-worktree → unavailable
      const status = normalized.reason === "outside-worktree" ? 404 : 400;
      return jsonError(`Invalid path: ${normalized.reason}`, status);
    }

    const absPath = resolveWithinWorktree(
      normalized.docPath,
      session.worktreePath,
    );
    if (!absPath) return jsonError("Invalid path", 400);

    try {
      const content = await deps.readFile(absPath);
      const body: DocumentContentResponse = {
        content,
        docPath: normalized.docPath,
      };
      return NextResponse.json(body);
    } catch (err) {
      if (isEnoent(err)) {
        return jsonError("Document file not found", 404);
      }
      logger.error("documents-content.read.failed", {
        docPath: normalized.docPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to read document", 500);
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Default named export — consumed directly by the route shell
// ---------------------------------------------------------------------------

const _handlers = createDocumentsRouteHandlers();
export const getDocumentContent = withTracing(_handlers.GET);
