/**
 * HTTP route handlers for Collaboration Mode.
 *
 * The route module under `src/app/api/.../collaboration/route.ts` is a thin
 * shim over `createCollaborationRouteHandlers()`. Keeping the handler logic
 * here lets route-level tests instantiate the factory with stubbed deps
 * without spinning up Next.js, mirroring the graph-workflow route-handler
 * pattern in `src/lib/workflow-graph/execution-route-handlers.ts`.
 *
 * Surface:
 *
 *  - POST /collaboration — start a new collaboration run
 *  - GET  /collaboration — list active collaboration envelopes for the session
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import {
  resolveProjectPath as defaultResolveProjectPath,
  type ProjectResolver,
} from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import type { ApiError } from "@/types";
import {
  collaborationResumeRequestSchema,
  collaborationStartRequestSchema,
  CollaborationNotPausedError,
  CollaborationResumeTokenMismatchError,
  CollaborationSessionNotFoundError,
  CollaborationWorkflowNotFoundError,
  getDefaultCollaborationManager,
  type CollaborationManager,
} from "./manager";

const logger = createLogger("workflows.collaboration.route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface CollaborationRouteDeps {
  resolveProjectPath: ProjectResolver["resolveProjectPath"];
  manager: CollaborationManager;
  getSession: typeof defaultGetSession;
  readArtifactFile: (absolutePath: string) => Promise<string>;
}

const defaultDeps: CollaborationRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  get manager() {
    return getDefaultCollaborationManager();
  },
  getSession: defaultGetSession,
  readArtifactFile: (absolutePath) => readFile(absolutePath, "utf-8"),
};

async function resolveSessionParams(
  context: RouteContext,
  deps: CollaborationRouteDeps,
): Promise<
  | { error: Response }
  | { projectName: string; projectPath: string; sessionName: string }
> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");

  if (projectName.length === 0 || sessionName.length === 0) {
    return {
      error: NextResponse.json(
        { error: "Project and session names are required" } satisfies ApiError,
        { status: 400 },
      ),
    };
  }

  const projectPath = await deps.resolveProjectPath(projectName);
  if (!projectPath) {
    return {
      error: NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  return { projectName, projectPath, sessionName };
}

function buildValidationErrorResponse(error: z.ZodError): Response {
  return NextResponse.json(
    {
      error: "Invalid request body",
      issues: error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

type WorkflowRouteContext = {
  params: Promise<Record<string, string>>;
};

async function resolveWorkflowParams(
  context: WorkflowRouteContext,
  deps: CollaborationRouteDeps,
): Promise<
  | { error: Response }
  | {
      projectPath: string;
      sessionName: string;
      workflowId: string;
    }
> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");
  const workflowId = decodeURIComponent(params["workflowId"] ?? "");

  if (
    projectName.length === 0 ||
    sessionName.length === 0 ||
    workflowId.length === 0
  ) {
    return {
      error: NextResponse.json(
        {
          error: "Project, session, and workflow IDs are required",
        } satisfies ApiError,
        { status: 400 },
      ),
    };
  }

  const projectPath = await deps.resolveProjectPath(projectName);
  if (!projectPath) {
    return {
      error: NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  return { projectPath, sessionName, workflowId };
}

export interface CollaborationRouteHandlers {
  START(request: Request, context: RouteContext): Promise<Response>;
  LIST(request: Request, context: RouteContext): Promise<Response>;
  GET_DETAIL(
    request: Request,
    context: WorkflowRouteContext,
  ): Promise<Response>;
  GET_ARTIFACT(
    request: Request,
    context: ArtifactRouteContext,
  ): Promise<Response>;
  RESUME(request: Request, context: WorkflowRouteContext): Promise<Response>;
}

type ArtifactRouteContext = {
  params: Promise<Record<string, string>>;
};

const COLLABORATION_ARTIFACT_TYPES = [
  "merged-design",
  "transcript",
  "open-questions",
] as const;
type CollaborationArtifactType = (typeof COLLABORATION_ARTIFACT_TYPES)[number];

function isCollaborationArtifactType(
  value: string,
): value is CollaborationArtifactType {
  return (COLLABORATION_ARTIFACT_TYPES as readonly string[]).includes(value);
}

function isSafeArtifactWorkflowId(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export function createCollaborationRouteHandlers(
  overrides: Partial<CollaborationRouteDeps> = {},
): CollaborationRouteHandlers {
  const deps: CollaborationRouteDeps = { ...defaultDeps, ...overrides };

  return {
    async START(request, context) {
      const sessionResolution = await resolveSessionParams(context, deps);
      if ("error" in sessionResolution) return sessionResolution.error;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Request body must be valid JSON" } satisfies ApiError,
          { status: 400 },
        );
      }

      const parsed = collaborationStartRequestSchema.safeParse(body);
      if (!parsed.success) {
        return buildValidationErrorResponse(parsed.error);
      }

      try {
        const result = await deps.manager.start({
          projectPath: sessionResolution.projectPath,
          sessionName: sessionResolution.sessionName,
          ...parsed.data,
        });
        const statusUrl = `/api/projects/${encodeURIComponent(sessionResolution.projectName)}/sessions/${encodeURIComponent(sessionResolution.sessionName)}/collaboration/${encodeURIComponent(result.workflowId)}`;
        return NextResponse.json({ ...result, statusUrl }, { status: 202 });
      } catch (err) {
        if (err instanceof CollaborationSessionNotFoundError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 404,
          });
        }
        logger.error("collaboration.route.start_failed", {
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          {
            error: "Failed to start collaboration run",
          } satisfies ApiError,
          { status: 500 },
        );
      }
    },

    async LIST(request, context) {
      const sessionResolution = await resolveSessionParams(context, deps);
      if ("error" in sessionResolution) return sessionResolution.error;

      const url = new URL(request.url);
      const includeAll = url.searchParams.get("all") === "true";

      try {
        const envelopes = includeAll
          ? await deps.manager.listAll({
              projectPath: sessionResolution.projectPath,
              sessionName: sessionResolution.sessionName,
            })
          : await deps.manager.listActive({
              projectPath: sessionResolution.projectPath,
              sessionName: sessionResolution.sessionName,
            });
        return NextResponse.json({ envelopes });
      } catch (err) {
        logger.error("collaboration.route.list_failed", {
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          {
            error: "Failed to list collaboration runs",
          } satisfies ApiError,
          { status: 500 },
        );
      }
    },

    async GET_DETAIL(_request, context) {
      const workflowResolution = await resolveWorkflowParams(context, deps);
      if ("error" in workflowResolution) return workflowResolution.error;

      try {
        const envelope = await deps.manager.getEnvelope({
          projectPath: workflowResolution.projectPath,
          sessionName: workflowResolution.sessionName,
          workflowId: workflowResolution.workflowId,
        });
        if (!envelope) {
          return NextResponse.json(
            { error: "Collaboration run not found" } satisfies ApiError,
            { status: 404 },
          );
        }
        return NextResponse.json({ envelope });
      } catch (err) {
        logger.error("collaboration.route.get_failed", {
          workflowId: workflowResolution.workflowId,
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          {
            error: "Failed to load collaboration run",
          } satisfies ApiError,
          { status: 500 },
        );
      }
    },

    async GET_ARTIFACT(_request, context) {
      const params = await context.params;
      const projectName = params["name"] ?? "";
      const sessionName = decodeURIComponent(params["session"] ?? "");
      const workflowId = decodeURIComponent(params["workflowId"] ?? "");
      const artifactType = decodeURIComponent(params["type"] ?? "");

      if (
        projectName.length === 0 ||
        sessionName.length === 0 ||
        workflowId.length === 0 ||
        artifactType.length === 0
      ) {
        return NextResponse.json(
          {
            error: "Project, session, workflow, and artifact type are required",
          } satisfies ApiError,
          { status: 400 },
        );
      }

      if (!isCollaborationArtifactType(artifactType)) {
        return NextResponse.json(
          {
            error: `Unknown collaboration artifact type: ${artifactType}`,
          } satisfies ApiError,
          { status: 400 },
        );
      }

      if (!isSafeArtifactWorkflowId(workflowId)) {
        return NextResponse.json(
          {
            error: "Invalid collaboration workflow ID",
          } satisfies ApiError,
          { status: 400 },
        );
      }

      const projectPath = await deps.resolveProjectPath(projectName);
      if (!projectPath) {
        return NextResponse.json(
          { error: "Project not found" } satisfies ApiError,
          { status: 404 },
        );
      }

      const sessionState = await deps.getSession(projectPath, sessionName);
      if (!sessionState) {
        return NextResponse.json(
          { error: "Session not found" } satisfies ApiError,
          { status: 404 },
        );
      }

      const relativePath = path.posix.join(
        "memory-bank",
        "collaboration",
        workflowId,
        `${artifactType}.md`,
      );
      const absolutePath = path.join(sessionState.worktreePath, relativePath);

      try {
        const content = await deps.readArtifactFile(absolutePath);
        return new NextResponse(content, {
          status: 200,
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return NextResponse.json(
            { error: "Artifact not found" } satisfies ApiError,
            { status: 404 },
          );
        }
        logger.error("collaboration.route.artifact_read_failed", {
          workflowId,
          artifactType,
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          { error: "Failed to read artifact" } satisfies ApiError,
          { status: 500 },
        );
      }
    },

    async RESUME(request, context) {
      const workflowResolution = await resolveWorkflowParams(context, deps);
      if ("error" in workflowResolution) return workflowResolution.error;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Request body must be valid JSON" } satisfies ApiError,
          { status: 400 },
        );
      }

      const parsed = collaborationResumeRequestSchema.safeParse(body);
      if (!parsed.success) {
        return buildValidationErrorResponse(parsed.error);
      }

      try {
        const result = await deps.manager.resume({
          projectPath: workflowResolution.projectPath,
          sessionName: workflowResolution.sessionName,
          workflowId: workflowResolution.workflowId,
          ...parsed.data,
        });
        return NextResponse.json(result, { status: 200 });
      } catch (err) {
        if (err instanceof CollaborationWorkflowNotFoundError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 404,
          });
        }
        if (err instanceof CollaborationResumeTokenMismatchError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 403,
          });
        }
        if (err instanceof CollaborationNotPausedError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 409,
          });
        }
        logger.error("collaboration.route.resume_failed", {
          workflowId: workflowResolution.workflowId,
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          {
            error: "Failed to resume collaboration run",
          } satisfies ApiError,
          { status: 500 },
        );
      }
    },
  };
}
