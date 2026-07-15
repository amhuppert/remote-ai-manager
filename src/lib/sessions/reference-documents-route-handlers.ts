/**
 * Route handlers for session reference documents.
 *
 * - GET    /api/projects/[name]/sessions/[session]/reference-documents — list registered documents
 * - POST   /api/projects/[name]/sessions/[session]/reference-documents — register a document
 * - DELETE /api/projects/[name]/sessions/[session]/reference-documents/[id] — deregister a document
 * - GET    /api/projects/[name]/sessions/[session]/reference-documents/[id]/content — read document content
 *
 * The register/delete endpoints replace the register_document/delete_document
 * MCP tools (docs/design/cc-cli/02 §2.2): token-gated, Zod-validated, and — new
 * relative to the MCP path — they reject a filePath that escapes the session
 * worktree.
 */

import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  createReferenceDocument,
  deleteReferenceDocument,
  getSession,
} from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";

const log = createLogger("reference-documents-route");

/** GET /api/projects/[name]/sessions/[session]/reference-documents — list registered reference documents */
export const listReferenceDocuments = withTracing(
  async (_request, { params }) => {
    const { name, session } = await params;
    const resolved = await resolveProjectSessionOr404(
      { resolveProjectPath, getSession },
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved.response;
    const sessionState = resolved.value.session;

    return NextResponse.json(sessionState.referenceDocuments ?? []);
  },
);

/** GET /api/projects/[name]/sessions/[session]/reference-documents/[id]/content — read document file content */
export const getReferenceDocumentContent = withTracing(
  async (_request, { params }) => {
    const { name, session, id } = await params;
    const resolved = await resolveProjectSessionOr404(
      { resolveProjectPath, getSession },
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved.response;
    const sessionState = resolved.value.session;

    const doc = sessionState.referenceDocuments?.find((d) => d.id === id);
    if (!doc) {
      return notFound("Document not found");
    }

    // Resolve file path: relative paths are joined with worktree path
    const filePath = path.isAbsolute(doc.filePath)
      ? doc.filePath
      : path.join(sessionState.worktreePath, doc.filePath);

    try {
      const content = await readFile(filePath, "utf-8");
      return NextResponse.json({ content });
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return notFound("Document file not found on disk");
      }
      return NextResponse.json(
        { error: "Failed to read document" } satisfies ApiError,
        { status: 500 },
      );
    }
  },
);

/**
 * Resolve `filePath` against `worktreePath` and return the absolute path when
 * it lands inside the worktree, or null when it escapes. Pure: relative paths
 * resolve against the worktree; absolute paths are accepted only when they sit
 * inside it. The register MCP tool never had this guard — it is the reason the
 * endpoint validates the path (docs/design/cc-cli/02 §2.2).
 */
export function resolveInsideWorktree(
  worktreePath: string,
  filePath: string,
): string | null {
  const worktreeAbsolute = path.resolve(worktreePath);
  const candidateAbsolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(worktreeAbsolute, filePath);
  const relative = path.relative(worktreeAbsolute, candidateAbsolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return candidateAbsolute;
}

export const registerReferenceDocumentBodySchema = z.object({
  filePath: z.string().min(1),
  description: z.string().min(1),
});

export interface ReferenceDocumentMutationDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string; worktreePath: string } | null>;
  createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument>;
  deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null>;
  deleteFile(filePath: string): Promise<void>;
}

async function defaultDeleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function createReferenceDocumentMutationHandlers(
  deps: ReferenceDocumentMutationDeps,
) {
  async function resolveSession(
    params: Promise<Record<string, string>>,
  ): Promise<
    | {
        ok: true;
        projectPath: string;
        sessionName: string;
        worktreePath: string;
      }
    | { ok: false; response: Response }
  > {
    const { name, session } = await params;
    const projectName = name ?? "";
    const sessionName = session ?? "";

    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved;
    const { projectPath, session: sessionState } = resolved.value;

    return {
      ok: true,
      projectPath,
      sessionName: sessionState.sessionName,
      worktreePath: sessionState.worktreePath,
    };
  }

  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSession(params);
    if (!resolved.ok) return resolved.response;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = registerReferenceDocumentBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid reference document payload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

    if (
      resolveInsideWorktree(resolved.worktreePath, parsed.data.filePath) ===
      null
    ) {
      return NextResponse.json(
        {
          error: "filePath must resolve inside the session worktree",
          issues: [
            {
              path: "filePath",
              message: "path escapes the session worktree",
            },
          ],
        },
        { status: 400 },
      );
    }

    const doc = await deps.createReferenceDocument(
      resolved.projectPath,
      resolved.sessionName,
      parsed.data.filePath,
      parsed.data.description,
    );

    log.info("reference-document.registered", {
      projectPath: resolved.projectPath,
      sessionName: resolved.sessionName,
      docId: doc.id,
      filePath: doc.filePath,
    });

    return NextResponse.json({ document: doc });
  }

  async function del(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSession(params);
    if (!resolved.ok) return resolved.response;

    const { id } = await params;
    const documentId = id ?? "";

    const removed = await deps.deleteReferenceDocument(
      resolved.projectPath,
      resolved.sessionName,
      documentId,
    );
    if (!removed) {
      return notFound(`Document "${documentId}" not found`);
    }

    const resolvedPath = path.isAbsolute(removed.filePath)
      ? removed.filePath
      : path.join(resolved.worktreePath, removed.filePath);
    await deps.deleteFile(resolvedPath);

    log.info("reference-document.deleted", {
      projectPath: resolved.projectPath,
      sessionName: resolved.sessionName,
      docId: removed.id,
      filePath: removed.filePath,
    });

    return NextResponse.json({ ok: true, document: removed });
  }

  return { POST: post, DELETE: del };
}

const defaultMutationHandlers = createReferenceDocumentMutationHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  createReferenceDocument,
  deleteReferenceDocument,
  deleteFile: defaultDeleteFile,
});

/** POST /api/projects/[name]/sessions/[session]/reference-documents */
export const registerReferenceDocument = withTracing(
  defaultMutationHandlers.POST,
);

/** DELETE /api/projects/[name]/sessions/[session]/reference-documents/[id] */
export const deleteReferenceDocumentRoute = withTracing(
  defaultMutationHandlers.DELETE,
);
