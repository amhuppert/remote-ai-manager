import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
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
  createSessionNormal,
  createSessionOptimistic,
  deleteSession,
  bulkDeleteSessions,
} from "@/lib/sessions/service";
import type { ImagePayload } from "@/lib/images/schemas";
import { isReservedSessionName } from "@/lib/sessions/derived";
import {
  createSessionRequestSchema,
  sessionArchiveRequestSchema,
  sessionTddRequestSchema,
  bulkSessionsRequestSchema,
  type CreateSessionRequest,
  type BulkSessionResult,
  type SessionState,
} from "@/lib/sessions/schemas";
import { stopAllForSession } from "@/lib/dev-server/registry";
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
    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

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
    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const [globalConfig, repoConfig] = await Promise.all([
      readConfig(),
      readRepoConfig(projectPath),
    ]);
    const branchPrefix = resolveBranchPrefix(globalConfig, repoConfig);
    return NextResponse.json({ branchPrefix });
  },
);

// ---------------------------------------------------------------------------
// Create-session handler — DI-seamed so the two-mode dispatch is unit-testable
// without standing up real worktree provisioning.
// ---------------------------------------------------------------------------

type BranchOpts = {
  baseBranch?: string;
  targetBranch?: string;
  parentSessionName?: string;
};

export interface CreateSessionRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  createSessionNormal(
    projectPath: string,
    sessionName: string,
    tddEnabled?: boolean,
    branchOpts?: BranchOpts,
  ): Promise<SessionState>;
  createSessionOptimistic(
    projectPath: string,
    instructions: string,
    images?: ImagePayload[],
    tddEnabled?: boolean,
    branchOpts?: BranchOpts,
  ): Promise<SessionState>;
}

const defaultCreateSessionDeps: CreateSessionRouteDeps = {
  resolveProjectPath,
  getSession,
  createSessionNormal,
  createSessionOptimistic,
};

export function createSessionRouteHandlers(
  deps: CreateSessionRouteDeps = defaultCreateSessionDeps,
) {
  async function POST(
    request: Request,
    { params }: RouteContext,
  ): Promise<Response> {
    const bodyPromise = request.json();
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    // External/untrusted body: `safeParse`. The discriminated union only admits
    // `normal`/`optimistic`, so any other mode (e.g. the removed `focus`/`fast`)
    // fails here and is rejected with a 400 (R1.7).
    const parsed = createSessionRequestSchema.safeParse(await bodyPromise);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: unsupported creation mode (expected 'normal' or 'optimistic'); 'normal' requires sessionName, 'optimistic' requires instructions or an image",
        } satisfies ApiError,
        { status: 400 },
      );
    }
    const body: CreateSessionRequest = parsed.data;

    let branchOpts:
      | { baseBranch: string; targetBranch: string; parentSessionName: string }
      | undefined;

    if (body.parentSessionName) {
      const parent = await deps.getSession(projectPath, body.parentSessionName);
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
      let session: SessionState;
      switch (body.mode) {
        case "normal":
          session = await deps.createSessionNormal(
            projectPath,
            body.sessionName,
            body.tddEnabled,
            branchOpts,
          );
          break;
        case "optimistic":
          session = await deps.createSessionOptimistic(
            projectPath,
            body.instructions,
            body.images,
            body.tddEnabled,
            branchOpts,
          );
          break;
        default: {
          // Exhaustiveness guard: the union is `normal`/`optimistic` only. Any
          // future/unsupported mode is rejected with a client error (R1.7).
          const _exhaustive: never = body;
          void _exhaustive;
          return NextResponse.json(
            { error: "Unsupported creation mode" } satisfies ApiError,
            { status: 400 },
          );
        }
      }
      return NextResponse.json(session, { status: 201 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create session";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 400,
      });
    }
  }

  return { POST };
}

/** POST /api/projects/[name]/sessions — create a new session */
export const createSession = withTracing(createSessionRouteHandlers().POST);

/** DELETE /api/projects/[name]/sessions?sessionName=xxx — delete a session */
export const deleteSessionRoute = withTracing(
  async (request, { params }: RouteContext) => {
    const name = (await params)["name"] ?? "";
    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

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
    const resolved = await resolveProjectSessionOr404(
      { resolveProjectPath, getSession },
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved.response;

    return NextResponse.json(resolved.value.session);
  },
);

/** PATCH /api/projects/[name]/sessions/[session]/archive — archive/unarchive session */
export const archiveSession = withTracing(
  async (request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return notFound("Session not found");
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

    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return notFound("Session not found");
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

/**
 * POST /api/projects/[name]/sessions/[session]/finalize-initialization
 *
 * Retired with focus mode: the two remaining creation modes (`normal`,
 * `optimistic`) never produce an `initialization` conversation to finalize, so
 * this endpoint rejects every request with a client error.
 */
export const finalizeSessionInit = withTracing(
  async (_request, { params }: RouteContext) => {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const project = await resolveProjectOr404({ resolveProjectPath }, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const session = await getSession(projectPath, sessionName);
    if (!session) {
      return notFound("Session not found");
    }

    return NextResponse.json(
      {
        error:
          "Focus initialization has been retired; sessions no longer require finalization",
      } satisfies ApiError,
      { status: 400 },
    );
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
  stopAllForSession(params: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;
}

const defaultBulkDeps: BulkSessionsRouteDeps = {
  resolveProjectPath,
  setSessionArchived,
  bulkDeleteSessions,
  stopAllForSession,
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

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

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
          if (op === "archive") {
            try {
              await deps.stopAllForSession({ projectPath, sessionName });
            } catch {
              // best-effort: don't block archival
            }
          }
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
