/**
 * Route handlers for session reference documents.
 *
 * - GET /api/projects/[name]/sessions/[session]/reference-documents — list registered documents
 * - GET /api/projects/[name]/sessions/[session]/reference-documents/[id]/content — read document content
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

/** GET /api/projects/[name]/sessions/[session]/reference-documents — list registered reference documents */
export const listReferenceDocuments = withTracing(
  async (_request, { params }) => {
    const { name, session } = await params;
    const projectPath = await resolveProjectPath(name ?? "");
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessionState = await getSession(projectPath, session ?? "");
    if (!sessionState) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    return NextResponse.json(sessionState.referenceDocuments ?? []);
  },
);

/** GET /api/projects/[name]/sessions/[session]/reference-documents/[id]/content — read document file content */
export const getReferenceDocumentContent = withTracing(
  async (_request, { params }) => {
    const { name, session, id } = await params;
    const projectPath = await resolveProjectPath(name ?? "");
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessionState = await getSession(projectPath, session ?? "");
    if (!sessionState) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const doc = sessionState.referenceDocuments?.find((d) => d.id === id);
    if (!doc) {
      return NextResponse.json(
        { error: "Document not found" } satisfies ApiError,
        { status: 404 },
      );
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
        return NextResponse.json(
          { error: "Document file not found on disk" } satisfies ApiError,
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: "Failed to read document" } satisfies ApiError,
        { status: 500 },
      );
    }
  },
);
