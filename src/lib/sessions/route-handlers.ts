import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { resolveBranchPrefix } from "@/lib/config/cascade";
import {
  getProjectSessionListItems,
  getSession,
  setSessionArchived,
  setSessionTddEnabled,
} from "@/lib/state-store";
import {
  createSessionFast,
  createSessionFocus,
  createSessionOptimistic,
  deleteSession,
  bulkDeleteSessions,
} from "@/lib/sessions/service";
import { isReservedSessionName } from "@/lib/sessions/derived";
import {
  createSessionRequestSchema,
  sessionArchiveRequestSchema,
  sessionTddRequestSchema,
  bulkSessionsRequestSchema,
  type CreateSessionRequest,
  type BulkSessionResult,
} from "@/lib/sessions/schemas";
import { stopAllForSession } from "@/lib/dev-server/registry";
import { finalizeInitialization } from "@/lib/conversations/service";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
const logger = createLogger("sessions-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/** GET /api/projects/[name]/sessions — list all sessions for a project */
export const listSessions = withTracing(
  async (_request, { params }: RouteContext) => {
    const name = (await params)["name"] ?? "";
    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessions = await getProjectSessionListItems(projectPath);
    const visible = sessions.filter(
      (s) => !isReservedSessionName(s.sessionName),
    );
    return NextResponse.json({ sessions: visible });
  },
);

/**
 * GET /api/projects/[name]/branch-prefix — the effective branch prefix CC will
 * apply when creating a session in this project (per-repo override → global →
 * `"csm"`). Lets client surfaces preview the real `<prefix>/<slug>` branch.
 */
export const getBranchPrefix = withTracing(
  async (_request, { params }: RouteContext) => {
    const name = (await params)["name"] ?? "";
    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const [globalConfig, repoConfig] = await Promise.all([
      readConfig(),
      readRepoConfig(projectPath),
    ]);
    const branchPrefix = resolveBranchPrefix(globalConfig, repoConfig);
    return NextResponse.json({ branchPrefix });
  },
);

/** POST /api/projects/[name]/sessions — create a new session */
export const createSession = withTracing(
  async (request, { params }: RouteContext) => {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: CreateSessionRequest;
    try {
      body = createSessionRequestSchema.parse(await bodyPromise);
    } catch {
      return NextResponse.json(
        {
          error:
            "Invalid request: fast mode requires sessionName, focus mode requires objective, optimistic mode requires instructions",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    let branchOpts:
      | { baseBranch: string; targetBranch: string; parentSessionName: string }
      | undefined;

    if (body.parentSessionName) {
      const parent = await getSession(projectPath, body.parentSessionName);
      if (!parent) {
        return NextResponse.json(
          { error: "Parent session not found" } satisfies ApiError,
          { status: 400 },
        );
      }
      if (parent.finished) {
        return NextResponse.json(
          { error: "Parent session is finished" } satisfies ApiError,
          { status: 400 },
        );
      }
      if (parent.archived) {
        return NextResponse.json(
          { error: "Parent session is archived" } satisfies ApiError,
          { status: 400 },
        );
      }
      branchOpts = {
        baseBranch: parent.branchName,
        targetBranch: parent.branchName,
        parentSessionName: body.parentSessionName,
      };
    }

    try {
      let session;
      if (body.mode === "fast") {
        session = await createSessionFast(
          projectPath,
          body.sessionName,
          body.tddEnabled,
          branchOpts,
        );
      } else if (body.mode === "optimistic") {
        session = await createSessionOptimistic(
          projectPath,
          body.instructions,
          body.images,
          body.tddEnabled,
          branchOpts,
        );
      } else {
        session = await createSessionFocus(
          projectPath,
          body.objective,
          body.tddEnabled,
          branchOpts,
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
  },
);

/** DELETE /api/projects/[name]/sessions?sessionName=xxx — delete a session */
export const deleteSessionRoute = withTracing(
  async (request, { params }: RouteContext) => {
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
  },
);

/** GET /api/projects/[name]/sessions/[session] — get a single session */
export const getSessionRoute = withTracing(
  async (_request, { params }: RouteContext) => {
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

    return NextResponse.json(sessionState);
  },
);

/** PATCH /api/projects/[name]/sessions/[session]/archive — archive/unarchive session */
export const archiveSession = withTracing(
  async (request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: { archived: boolean };
    try {
      body = sessionArchiveRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "archived (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      if (body.archived) {
        try {
          await stopAllForSession({ projectPath, sessionName });
        } catch {
          // best-effort: don't block archival
        }
      }

      await setSessionArchived(projectPath, sessionName, body.archived);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/** PATCH /api/projects/[name]/sessions/[session]/tdd — toggle TDD mode */
export const setSessionTdd = withTracing(
  async (request, { params }: RouteContext) => {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: { tddEnabled: boolean };
    try {
      body = sessionTddRequestSchema.parse(await bodyPromise);
    } catch {
      return NextResponse.json(
        { error: "tddEnabled (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await setSessionTddEnabled(projectPath, sessionName, body.tddEnabled);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update TDD mode";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

/** POST /api/projects/[name]/sessions/[session]/finalize-initialization */
export const finalizeSessionInit = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (session.creationMode !== "focus") {
      return NextResponse.json(
        { error: "Session is not a focus session" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const result = await finalizeInitialization(projectPath, sessionName);
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to finalize initialization";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Bulk sessions handler — supports dependency injection for tests.
// ---------------------------------------------------------------------------

export interface BulkSessionsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void>;
  bulkDeleteSessions(
    projectPath: string,
    sessionNames: string[],
  ): Promise<BulkSessionResult[]>;
}

const defaultBulkDeps: BulkSessionsRouteDeps = {
  resolveProjectPath,
  setSessionArchived,
  bulkDeleteSessions,
};

export function createBulkSessionsRouteHandlers(
  deps: BulkSessionsRouteDeps = defaultBulkDeps,
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
            "Invalid request: op must be archive|unarchive|delete; sessionNames must be 1\u2013200 names",
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

    let results: BulkSessionResult[];
    if (op === "delete") {
      results = await deps.bulkDeleteSessions(projectPath, sessionNames);
      for (const r of results) {
        if (r.success) {
          logger.info("bulk.item.ok", {
            projectName: name,
            op,
            sessionName: r.sessionName,
          });
        } else {
          logger.warn("bulk.item.error", {
            projectName: name,
            op,
            sessionName: r.sessionName,
            error: r.error,
          });
        }
      }
    } else {
      results = [];
      for (const sessionName of sessionNames) {
        try {
          await deps.setSessionArchived(
            projectPath,
            sessionName,
            op === "archive",
          );
          results.push({ sessionName, success: true });
          logger.info("bulk.item.ok", { projectName: name, op, sessionName });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Operation failed";
          results.push({ sessionName, success: false, error: message });
          logger.warn("bulk.item.error", {
            projectName: name,
            op,
            sessionName,
            error: message,
          });
        }
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

/** POST /api/projects/[name]/sessions/bulk — production handler. */
export const bulkSessions = withTracing(createBulkSessionsRouteHandlers().POST);
