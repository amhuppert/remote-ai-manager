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
import {
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createLogger, withTracing } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  resolveProjectPath as defaultResolveProjectPath,
  type ProjectResolver,
} from "@/lib/projects/resolver";
import {
  clearConversationPendingPromptTextIfMatches as defaultClearConversationPendingPromptTextIfMatches,
  getSession as defaultGetSession,
} from "@/lib/state-store";
import { setConversationBackend as defaultSetConversationBackend } from "@/lib/conversations/service";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ApiError } from "@/lib/api/errors";
import {
  collaborationResumeRequestSchema,
  collaborationStartRequestSchema,
  collaborationStopRequestSchema,
  CollaborationConversationMismatchError,
  CollaborationConversationNotFoundError,
  CollaborationNotPausedError,
  CollaborationNotStoppableError,
  CollaborationResumeTokenMismatchError,
  CollaborationModelEffortValidationError,
  CollaborationProfileResolutionError,
  CollaborationSessionNotFoundError,
  CollaborationStartConflictError,
  CollaborationWorkflowNotFoundError,
  getDefaultCollaborationManager,
  type CollaborationManager,
} from "./manager";
import {
  CollaborationCharterCaptureError,
  CollaborationSessionContextError,
} from "./session-context";

const logger = createLogger("workflows.collaboration.route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface CollaborationRouteDeps {
  resolveProjectPath: ProjectResolver["resolveProjectPath"];
  manager: CollaborationManager;
  getSession: typeof defaultGetSession;
  clearConversationPendingPromptTextIfMatches: typeof defaultClearConversationPendingPromptTextIfMatches;
  readArtifactFile: (absolutePath: string) => Promise<string>;
  /**
   * Adopts the user's currently-selected backend onto the conversation before
   * the manager picks Agent One. Mirrors `executePromptStream`'s adoption: a
   * fresh conversation (`promptCount === 0`) accepts the new backend; once
   * prompts have been sent the underlying call throws and START returns 409.
   * Defaults to `setConversationBackend` from `@/lib/conversations`; tests
   * override.
   */
  setConversationBackend: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
    backend: AgentBackendId,
  ) => Promise<void>;
}

const defaultDeps: CollaborationRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  get manager() {
    return getDefaultCollaborationManager();
  },
  getSession: defaultGetSession,
  clearConversationPendingPromptTextIfMatches:
    defaultClearConversationPendingPromptTextIfMatches,
  readArtifactFile: (absolutePath) => readFile(absolutePath, "utf-8"),
  setConversationBackend: defaultSetConversationBackend,
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

  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) {
    return { error: project.response };
  }
  const projectPath = project.value;

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

  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) {
    return { error: project.response };
  }
  const projectPath = project.value;

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
  GET_ARTIFACT_FILE(
    request: Request,
    context: WorkflowRouteContext,
  ): Promise<Response>;
  RESUME(request: Request, context: WorkflowRouteContext): Promise<Response>;
  STOP(request: Request, context: WorkflowRouteContext): Promise<Response>;
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

const collaborationRouteStartRequestSchema =
  collaborationStartRequestSchema.extend({
    submittedPendingPromptText: z.string().optional(),
  });

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

function validateGeneratedArtifactRelativePath(input: {
  workflowId: string;
  relativePath: string;
}): string | null {
  const relativePath = input.relativePath;
  if (relativePath.length === 0) return "Artifact path is required";
  if (relativePath.length > 512) return "Artifact path is too long";
  if (relativePath.includes("\0")) return "Artifact path is invalid";
  if (path.posix.isAbsolute(relativePath)) {
    return "Artifact path must be relative";
  }
  if (relativePath.includes("\\")) {
    return "Artifact path must use POSIX separators";
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    return "Artifact path must not contain traversal segments";
  }
  if (!relativePath.endsWith(".md")) {
    return "Artifact path must end with .md";
  }

  const expectedPrefix = path.posix.join(
    "memory-bank",
    "collaboration",
    input.workflowId,
  );
  if (
    relativePath !== expectedPrefix &&
    !relativePath.startsWith(`${expectedPrefix}/`)
  ) {
    return "Artifact path is outside this collaboration run";
  }
  return null;
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

      const parsed = collaborationRouteStartRequestSchema.safeParse(body);
      if (!parsed.success) {
        return buildValidationErrorResponse(parsed.error);
      }

      if (parsed.data.backend) {
        try {
          await deps.setConversationBackend(
            sessionResolution.projectPath,
            sessionResolution.sessionName,
            parsed.data.conversationId,
            parsed.data.backend,
          );
        } catch (err) {
          const message = getErrorMessage(err);
          if (message.includes("after prompts have been sent")) {
            logger.warn("collaboration.route.backend_adoption_locked", {
              conversationId: parsed.data.conversationId,
              requestedBackend: parsed.data.backend,
            });
            return NextResponse.json(
              {
                error: `Cannot change backend after prompts have been sent (conversation "${parsed.data.conversationId}")`,
              } satisfies ApiError,
              { status: 409 },
            );
          }
          logger.error("collaboration.route.backend_adoption_failed", {
            conversationId: parsed.data.conversationId,
            requestedBackend: parsed.data.backend,
            error: message,
          });
          return NextResponse.json(
            {
              error: "Failed to adopt backend on conversation",
            } satisfies ApiError,
            { status: 500 },
          );
        }
      }

      try {
        const { submittedPendingPromptText, ...startRequest } = parsed.data;
        const result = await deps.manager.start({
          projectPath: sessionResolution.projectPath,
          sessionName: sessionResolution.sessionName,
          ...startRequest,
        });
        if (submittedPendingPromptText !== undefined) {
          try {
            const cleared =
              await deps.clearConversationPendingPromptTextIfMatches(
                sessionResolution.projectPath,
                sessionResolution.sessionName,
                parsed.data.conversationId,
                submittedPendingPromptText,
              );
            logger.debug("collaboration.pending_draft_clear_completed", {
              projectPath: sessionResolution.projectPath,
              sessionName: sessionResolution.sessionName,
              conversationId: parsed.data.conversationId,
              workflowId: result.workflowId,
              cleared,
            });
          } catch (error) {
            logger.warn("collaboration.pending_draft_clear_failed", {
              projectPath: sessionResolution.projectPath,
              sessionName: sessionResolution.sessionName,
              conversationId: parsed.data.conversationId,
              workflowId: result.workflowId,
              error: getErrorMessage(error),
            });
          }
        }
        const statusUrl = `/api/projects/${encodeURIComponent(sessionResolution.projectName)}/sessions/${encodeURIComponent(sessionResolution.sessionName)}/collaboration/${encodeURIComponent(result.workflowId)}`;
        return NextResponse.json(
          { workflowId: result.workflowId, status: result.status, statusUrl },
          { status: 202 },
        );
      } catch (err) {
        if (err instanceof CollaborationSessionNotFoundError) {
          return notFound(err.message);
        }
        if (err instanceof CollaborationConversationNotFoundError) {
          return notFound(err.message);
        }
        if (err instanceof CollaborationStartConflictError) {
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_START_CONFLICT",
            } satisfies ApiError,
            { status: 409 },
          );
        }
        if (err instanceof CollaborationModelEffortValidationError) {
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_INVALID_MODEL_EFFORT",
            } satisfies ApiError,
            { status: 400 },
          );
        }
        if (err instanceof CollaborationProfileResolutionError) {
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_PROFILE_RESOLUTION_FAILED",
            } satisfies ApiError,
            { status: 400 },
          );
        }
        // The charter is governing context, so the run failed closed before
        // claiming the conversation. Naming the cause tells the user their
        // prompt is intact and what to retry.
        if (err instanceof CollaborationCharterCaptureError) {
          logger.error("collaboration.route.start_charter_capture_failed", {
            error: getErrorMessage(err),
          });
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_CHARTER_CAPTURE_FAILED",
            } satisfies ApiError,
            { status: 500 },
          );
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
          return notFound("Collaboration run not found");
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

      const resolved = await resolveProjectSessionOr404(
        deps,
        projectName,
        sessionName,
      );
      if (!resolved.ok) return resolved.response;
      const sessionState = resolved.value.session;

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
          return notFound("Artifact not found");
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

    async GET_ARTIFACT_FILE(request, context) {
      const workflowResolution = await resolveWorkflowParams(context, deps);
      if ("error" in workflowResolution) return workflowResolution.error;

      if (!isSafeArtifactWorkflowId(workflowResolution.workflowId)) {
        return NextResponse.json(
          {
            error: "Invalid collaboration workflow ID",
          } satisfies ApiError,
          { status: 400 },
        );
      }

      const url = new URL(request.url);
      const relativePath = url.searchParams.get("path") ?? "";
      const pathError = validateGeneratedArtifactRelativePath({
        workflowId: workflowResolution.workflowId,
        relativePath,
      });
      if (pathError) {
        return NextResponse.json({ error: pathError } satisfies ApiError, {
          status: 400,
        });
      }

      const sessionState = await deps.getSession(
        workflowResolution.projectPath,
        workflowResolution.sessionName,
      );
      if (!sessionState) {
        return notFound("Session not found");
      }

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
          return notFound("Artifact not found");
        }
        logger.error("collaboration.route.artifact_file_read_failed", {
          workflowId: workflowResolution.workflowId,
          relativePath,
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          { error: "Failed to read artifact file" } satisfies ApiError,
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
          return notFound(err.message);
        }
        if (err instanceof CollaborationConversationMismatchError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 403,
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
        // The envelope survives, but its captured premises do not, so it can
        // never be resumed — a state conflict, like resuming a run that is not
        // paused. The error message carries the restart instruction.
        if (err instanceof CollaborationSessionContextError) {
          logger.warn("collaboration.route.resume_session_context_unusable", {
            workflowId: workflowResolution.workflowId,
            reason: err.reason,
          });
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_SESSION_CONTEXT_UNUSABLE",
            } satisfies ApiError,
            { status: 409 },
          );
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

    async STOP(request, context) {
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

      const parsed = collaborationStopRequestSchema.safeParse(body);
      if (!parsed.success) {
        return buildValidationErrorResponse(parsed.error);
      }

      try {
        const result = await deps.manager.stop({
          projectPath: workflowResolution.projectPath,
          sessionName: workflowResolution.sessionName,
          workflowId: workflowResolution.workflowId,
          conversationId: parsed.data.conversationId,
        });
        return NextResponse.json(result, { status: 200 });
      } catch (err) {
        if (err instanceof CollaborationWorkflowNotFoundError) {
          return notFound(err.message);
        }
        if (err instanceof CollaborationConversationMismatchError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 403,
          });
        }
        if (err instanceof CollaborationNotStoppableError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 409,
          });
        }
        logger.error("collaboration.route.stop_failed", {
          workflowId: workflowResolution.workflowId,
          error: getErrorMessage(err),
        });
        return NextResponse.json(
          {
            error: "Failed to stop collaboration run",
          } satisfies ApiError,
          { status: 500 },
        );
      }
    },
  };
}

const defaultCollaborationHandlers = createCollaborationRouteHandlers();

export const startCollaboration = withTracing(
  defaultCollaborationHandlers.START,
);
export const listCollaboration = withTracing(defaultCollaborationHandlers.LIST);
export const getCollaborationDetail = withTracing(
  defaultCollaborationHandlers.GET_DETAIL,
);
export const getCollaborationArtifact = withTracing(
  defaultCollaborationHandlers.GET_ARTIFACT,
);
export const getCollaborationArtifactFile = withTracing(
  defaultCollaborationHandlers.GET_ARTIFACT_FILE,
);
export const resumeCollaboration = withTracing(
  defaultCollaborationHandlers.RESUME,
);
export const stopCollaboration = withTracing(defaultCollaborationHandlers.STOP);
