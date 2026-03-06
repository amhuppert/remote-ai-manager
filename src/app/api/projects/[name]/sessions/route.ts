import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getProjectSessions } from "@/lib/state";
import {
  createSessionFast,
  createSessionFocus,
  createSessionOptimistic,
  deleteSession,
} from "@/lib/sessions";
import { discoverAndImportWorktrees } from "@/lib/worktrees";
import {
  createSessionRequestSchema,
  type CreateSessionRequest,
} from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions — list all sessions with worktree reconciliation */
export const GET = withTracing(async (_request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const existingSessions = await getProjectSessions(projectPath);

  // Reconcile worktrees: discover and import untracked ones
  const reconciliation = await discoverAndImportWorktrees(
    projectPath,
    existingSessions,
  );

  // Re-read sessions after reconciliation to include newly imported ones
  const sessions =
    reconciliation.imported.length > 0
      ? await getProjectSessions(projectPath)
      : existingSessions;

  return NextResponse.json({
    sessions,
    orphanedSessionNames: reconciliation.orphanedSessionNames,
  });
});

/** POST /api/projects/[name]/sessions — create a new session */
export const POST = withTracing(async (request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body: CreateSessionRequest;
  try {
    body = createSessionRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      {
        error:
          "Invalid request: fast mode requires sessionName, focus mode requires objective, optimistic mode requires instructions",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    let session;
    if (body.mode === "fast") {
      session = await createSessionFast(
        projectPath,
        body.sessionName,
        body.tddEnabled,
      );
    } else if (body.mode === "optimistic") {
      session = await createSessionOptimistic(
        projectPath,
        body.instructions,
        body.images,
        body.tddEnabled,
      );
    } else {
      session = await createSessionFocus(
        projectPath,
        body.objective,
        body.tddEnabled,
      );
    }
    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create session";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 400,
    });
  }
});

/** DELETE /api/projects/[name]/sessions?sessionName=xxx — delete a session */
export const DELETE = withTracing(async (request, { params }) => {
  const name = (await params)["name"] ?? "";
  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const sessionName = url.searchParams.get("sessionName");
  if (!sessionName) {
    return NextResponse.json(
      { error: "sessionName query parameter is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const { worktreeRemoved } = await deleteSession(projectPath, sessionName);
    return NextResponse.json({ success: true, worktreeRemoved });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete session";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 400,
    });
  }
});
