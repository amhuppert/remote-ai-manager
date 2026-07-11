/**
 * Route handler for the generic markdown content-by-path endpoint, extracted
 * for dependency injection. The route shell delegates to the
 * `withTracing`-wrapped named export; tests build handlers over a real-store
 * fixture (plus a faked `readFile`) via `createDocumentsRouteHandlers(deps)`.
 *
 * - GET /api/projects/[name]/sessions/[session]/document-content?path=
 *
 * Reads a Markdown file addressed by a canonical worktree-relative path or by
 * an external absolute path already indexed for the session. Non-Markdown
 * paths return 400; missing or unauthorized files return 404.
 */

import { readFile as defaultReadFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getSessionMarkdownDocuments as defaultGetSessionMarkdownDocuments,
  isSessionMarkdownDocumentIndexed as defaultIsSessionMarkdownDocumentIndexed,
} from "@/lib/state-store";
import {
  normalizeMarkdownLocator,
  resolveWithinWorktree,
} from "@/lib/documents/path";
import {
  documentContentPathSchema,
  markdownDocumentsResponseSchema,
  type SessionMarkdownDocument,
  type DocumentContentResponse,
} from "./schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ApiError } from "@/lib/api/errors";
import { mergeMarkdownDocuments } from "./markdown-document-list";

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
  getSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionMarkdownDocument[]>;
  isSessionMarkdownDocumentIndexed(
    projectPath: string,
    sessionName: string,
    docPath: string,
  ): Promise<boolean>;
}

const defaultDeps: DocumentsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  readFile: (absPath) => defaultReadFile(absPath, "utf-8"),
  getSessionMarkdownDocuments: defaultGetSessionMarkdownDocuments,
  isSessionMarkdownDocumentIndexed: defaultIsSessionMarkdownDocumentIndexed,
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
  async function resolveScope(context: RouteContext): Promise<
    | {
        projectPath: string;
        sessionName: string;
        session: SessionState;
      }
    | NextResponse
  > {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return jsonError("Project not found", 404);
    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return jsonError("Session not found", 404);
    return { projectPath, sessionName, session };
  }

  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const scope = await resolveScope(context);
    if (scope instanceof NextResponse) return scope;

    const rawPath = documentContentPathSchema.safeParse(
      new URL(request.url).searchParams.get("path"),
    );
    if (!rawPath.success) return jsonError("path query is required", 400);

    const normalized = normalizeMarkdownLocator(
      rawPath.data,
      scope.session.worktreePath,
    );
    if (!normalized.ok) {
      return jsonError(`Invalid path: ${normalized.reason}`, 400);
    }

    let absPath: string | null;
    if (normalized.location === "worktree") {
      absPath = resolveWithinWorktree(
        normalized.docPath,
        scope.session.worktreePath,
      );
    } else {
      const indexed = await deps.isSessionMarkdownDocumentIndexed(
        scope.projectPath,
        scope.sessionName,
        normalized.docPath,
      );
      const registered = scope.session.referenceDocuments.some((document) => {
        const ref = normalizeMarkdownLocator(
          document.filePath,
          scope.session.worktreePath,
        );
        return ref.ok && ref.docPath === normalized.docPath;
      });
      if (!indexed && !registered) return jsonError("Document not found", 404);
      absPath = normalized.docPath;
    }
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
        location: normalized.location,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to read document", 500);
    }
  }

  async function LIST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const scope = await resolveScope(context);
    if (scope instanceof NextResponse) return scope;
    try {
      const indexed = await deps.getSessionMarkdownDocuments(
        scope.projectPath,
        scope.sessionName,
      );
      const documents = mergeMarkdownDocuments(
        indexed,
        scope.session.referenceDocuments,
        scope.session.worktreePath,
      );
      return NextResponse.json(
        markdownDocumentsResponseSchema.parse(documents),
      );
    } catch (err) {
      logger.error("documents-list.read.failed", {
        sessionName: scope.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to list Markdown documents", 500);
    }
  }

  return { GET, LIST };
}

// ---------------------------------------------------------------------------
// Default named export — consumed directly by the route shell
// ---------------------------------------------------------------------------

const _handlers = createDocumentsRouteHandlers();
export const getDocumentContent = withTracing(_handlers.GET);
export const listMarkdownDocuments = withTracing(_handlers.LIST);
