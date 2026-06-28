/**
 * Route handlers for document-scoped comments (CRUD), extracted for dependency
 * injection. Route shells delegate to the `withTracing`-wrapped named exports;
 * tests build handlers over a real-store fixture via
 * `createDocumentCommentsRouteHandlers(deps)`.
 *
 * - GET    /api/projects/[name]/sessions/[session]/document-comments?docPath=
 * - POST   /api/projects/[name]/sessions/[session]/document-comments
 * - PATCH  /api/projects/[name]/sessions/[session]/document-comments/[id]
 * - DELETE /api/projects/[name]/sessions/[session]/document-comments/[id]
 *
 * Ownership: create persists with the route's (projectPath, sessionName) — never
 * a body-supplied scope. PATCH/DELETE resolve project→session, then load the
 * comment via the scoped lookup so an id from another project/session returns
 * 404 and is never mutated/deleted (mirrors the reference-documents ownership
 * chain).
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getDocumentComments as defaultGetDocumentComments,
  getDocumentCommentInScope as defaultGetDocumentCommentInScope,
  upsertDocumentComment as defaultUpsertDocumentComment,
  deleteDocumentComment as defaultDeleteDocumentComment,
} from "@/lib/state-store";
import { normalizeDocPath } from "@/lib/documents/path";
import {
  createDocumentCommentRequestSchema,
  updateDocumentCommentRequestSchema,
  type DocumentComment,
} from "./schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("document-comments-route");

// ---------------------------------------------------------------------------
// Deps interface (method syntax for bivariance)
// ---------------------------------------------------------------------------

export interface DocumentCommentsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getDocumentComments(
    projectPath: string,
    sessionName: string,
    docPath: string,
  ): Promise<DocumentComment[]>;
  getDocumentCommentInScope(
    projectPath: string,
    sessionName: string,
    id: string,
  ): Promise<DocumentComment | null>;
  upsertDocumentComment(comment: DocumentComment): Promise<void>;
  deleteDocumentComment(id: string): Promise<void>;
  now(): string;
  newId(): string;
}

const defaultDeps: DocumentCommentsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getDocumentComments: defaultGetDocumentComments,
  getDocumentCommentInScope: defaultGetDocumentCommentInScope,
  upsertDocumentComment: defaultUpsertDocumentComment,
  deleteDocumentComment: defaultDeleteDocumentComment,
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

type RouteContext = { params: Promise<Record<string, string>> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiError, { status });
}

/** HTTP status for a `normalizeDocPath` rejection: traversal/non-markdown are
 * client errors (400); an absolute path outside the worktree is unavailable
 * (404). */
function docPathRejectionStatus(
  reason: "non-markdown" | "traversal" | "outside-worktree",
): number {
  return reason === "outside-worktree" ? 404 : 400;
}

interface ResolvedScope {
  projectPath: string;
  session: SessionState;
}

/** Resolve project→session (the ownership chain). Returns an error response on
 * a miss so callers can early-return. */
async function resolveScope(
  deps: DocumentCommentsRouteDeps,
  name: string,
  sessionName: string,
): Promise<ResolvedScope | NextResponse> {
  const projectPath = await deps.resolveProjectPath(name);
  if (!projectPath) return jsonError("Project not found", 404);
  const session = await deps.getSession(projectPath, sessionName);
  if (!session) return jsonError("Session not found", 404);
  return { projectPath, session };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDocumentCommentsRouteHandlers(
  deps: DocumentCommentsRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");

    const scope = await resolveScope(deps, name, sessionName);
    if (scope instanceof NextResponse) return scope;

    const rawDocPath = new URL(request.url).searchParams.get("docPath");
    if (!rawDocPath) return jsonError("docPath query is required", 400);

    const normalized = normalizeDocPath(rawDocPath, scope.session.worktreePath);
    if (!normalized.ok) {
      return jsonError(
        `Invalid docPath: ${normalized.reason}`,
        docPathRejectionStatus(normalized.reason),
      );
    }

    try {
      const comments = await deps.getDocumentComments(
        scope.projectPath,
        sessionName,
        normalized.docPath,
      );
      return NextResponse.json(comments);
    } catch (err) {
      logger.error("document-comments.list.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to list comments", 500);
    }
  }

  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const bodyPromise = request.json().catch(() => undefined);
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");

    const scope = await resolveScope(deps, name, sessionName);
    if (scope instanceof NextResponse) return scope;

    const parsed = createDocumentCommentRequestSchema.safeParse(
      await bodyPromise,
    );
    if (!parsed.success) return jsonError("Invalid request body", 400);

    const { docPath, anchor, note } = parsed.data;
    if (anchor.charStart > anchor.charEnd) {
      return jsonError("anchor.charStart must be <= anchor.charEnd", 400);
    }

    const normalized = normalizeDocPath(docPath, scope.session.worktreePath);
    if (!normalized.ok) {
      return jsonError(
        `Invalid docPath: ${normalized.reason}`,
        docPathRejectionStatus(normalized.reason),
      );
    }

    const timestamp = deps.now();
    const comment: DocumentComment = {
      id: deps.newId(),
      projectPath: scope.projectPath,
      sessionName,
      docPath: normalized.docPath,
      anchor,
      note,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null,
    };

    try {
      await deps.upsertDocumentComment(comment);
      logger.info("document-comments.create", {
        id: comment.id,
        docPath: comment.docPath,
      });
      return NextResponse.json(comment, { status: 201 });
    } catch (err) {
      logger.error("document-comments.create.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to create comment", 500);
    }
  }

  async function PATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const bodyPromise = request.json().catch(() => undefined);
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const id = decodeURIComponent(resolvedParams["id"] ?? "");

    const scope = await resolveScope(deps, name, sessionName);
    if (scope instanceof NextResponse) return scope;

    const parsed = updateDocumentCommentRequestSchema.safeParse(
      await bodyPromise,
    );
    if (!parsed.success) return jsonError("Invalid request body", 400);

    const existing = await deps.getDocumentCommentInScope(
      scope.projectPath,
      sessionName,
      id,
    );
    if (!existing) return jsonError("Comment not found", 404);

    const nextNote = parsed.data.note ?? existing.note;
    const nextStatus = parsed.data.status ?? existing.status;
    const timestamp = deps.now();
    const sentAt =
      nextStatus === "sent" ? (existing.sentAt ?? timestamp) : null;

    const updated: DocumentComment = {
      ...existing,
      note: nextNote,
      status: nextStatus,
      sentAt,
      updatedAt: timestamp,
    };

    try {
      await deps.upsertDocumentComment(updated);
      logger.info("document-comments.update", {
        id,
        status: updated.status,
      });
      return NextResponse.json(updated);
    } catch (err) {
      logger.error("document-comments.update.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to update comment", 500);
    }
  }

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const id = decodeURIComponent(resolvedParams["id"] ?? "");

    const scope = await resolveScope(deps, name, sessionName);
    if (scope instanceof NextResponse) return scope;

    const existing = await deps.getDocumentCommentInScope(
      scope.projectPath,
      sessionName,
      id,
    );
    if (!existing) return jsonError("Comment not found", 404);

    try {
      await deps.deleteDocumentComment(id);
      logger.info("document-comments.delete", { id });
      return NextResponse.json({ ok: true });
    } catch (err) {
      logger.error("document-comments.delete.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError("Failed to delete comment", 500);
    }
  }

  return { GET, POST, PATCH, DELETE };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createDocumentCommentsRouteHandlers();
export const listDocumentComments = withTracing(_handlers.GET);
export const createDocumentComment = withTracing(_handlers.POST);
export const updateDocumentComment = withTracing(_handlers.PATCH);
export const deleteDocumentCommentRoute = withTracing(_handlers.DELETE);
