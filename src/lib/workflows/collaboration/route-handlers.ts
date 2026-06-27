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
import { createLogger, withTracing } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  resolveProjectPath as defaultResolveProjectPath,
  type ProjectResolver,
} from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { setConversationBackend as defaultSetConversationBackend } from "@/lib/conversations/service";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  getTranscriptPath as defaultGetTranscriptPath,
  safeAppendTranscriptEntry as defaultSafeAppendTranscriptEntry,
  type TranscriptBroadcastMeta,
  type TranscriptEntry,
} from "@/lib/prompt/transcript";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  collaborationResumeRequestSchema,
  collaborationStartRequestSchema,
  collaborationStopRequestSchema,
  CollaborationConversationMismatchError,
  CollaborationConversationNotFoundError,
  CollaborationNotPausedError,
  CollaborationNotStoppableError,
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
  /**
   * Persists the user's `/collab <brief>` prompt as a user transcript entry
   * before the manager begins the run. This is what lets the conversation
   * timeline (and the inline `CollabPassage` anchor logic) render the start
   * passage in the position the user submitted it from. Defaults to
   * `safeAppendTranscriptEntry` from `@/lib/prompt/transcript`; tests override.
   */
  appendTranscriptEntry: (
    conversationId: string,
    entry: TranscriptEntry,
    meta?: TranscriptBroadcastMeta,
  ) => Promise<unknown>;
  /**
   * Resolves the canonical transcript file path for a conversation. Used to
   * stamp `transcriptPath` on conversations that were /collab-started before
   * any normal prompt has run, so the conversation no longer appears with a
   * `null` transcriptPath in lists/active surfaces. Defaults to
   * `getTranscriptPath` from `@/lib/prompt/transcript`; tests override.
   */
  getTranscriptPath: (conversationId: string) => Promise<string>;
  /**
   * Mutates a conversation entry in session state under the durable lock.
   * Called from START to flip a `new` conversation to a started state with a
   * stamped transcriptPath, incremented promptCount, and refreshed
   * lastActivityAt. Defaults to `mutateConversation` from `@/lib/state-store`; tests
   * override.
   */
  mutateConversation: <T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ) => Promise<T>;
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
  readArtifactFile: (absolutePath) => readFile(absolutePath, "utf-8"),
  appendTranscriptEntry: (conversationId, entry, meta) =>
    defaultSafeAppendTranscriptEntry(
      conversationId,
      entry,
      undefined,
      undefined,
      meta,
    ),
  getTranscriptPath: (conversationId) =>
    defaultGetTranscriptPath(conversationId),
  mutateConversation: defaultMutateConversation,
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

      const parsed = collaborationStartRequestSchema.safeParse(body);
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
        await deps.appendTranscriptEntry(
          parsed.data.conversationId,
          {
            timestamp: new Date().toISOString(),
            type: "user",
            role: "user",
            content: [
              {
                type: "text",
                text: `/collab ${parsed.data.brief}`,
              },
            ],
          },
          {
            projectName: sessionResolution.projectName,
            sessionName: sessionResolution.sessionName,
          },
        );
        const result = await deps.manager.start({
          projectPath: sessionResolution.projectPath,
          sessionName: sessionResolution.sessionName,
          ...parsed.data,
        });
        try {
          const stampedTranscriptPath = await deps.getTranscriptPath(
            parsed.data.conversationId,
          );
          await deps.mutateConversation(
            sessionResolution.projectPath,
            sessionResolution.sessionName,
            parsed.data.conversationId,
            "collab.start",
            (conversation) => {
              if (conversation.transcriptPath === null) {
                conversation.transcriptPath = stampedTranscriptPath;
              }
              if (conversation.status === "new") {
                conversation.status = "running";
              }
              conversation.promptCount = (conversation.promptCount ?? 0) + 1;
              conversation.lastActivityAt = new Date().toISOString();
            },
          );
        } catch (mutationErr) {
          logger.warn("collaboration.route.start_metadata_sync_failed", {
            workflowId: result.workflowId,
            conversationId: parsed.data.conversationId,
            error: getErrorMessage(mutationErr),
          });
        }
        const statusUrl = `/api/projects/${encodeURIComponent(sessionResolution.projectName)}/sessions/${encodeURIComponent(sessionResolution.sessionName)}/collaboration/${encodeURIComponent(result.workflowId)}`;
        return NextResponse.json({ ...result, statusUrl }, { status: 202 });
      } catch (err) {
        if (err instanceof CollaborationSessionNotFoundError) {
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 404,
          });
        }
        if (err instanceof CollaborationConversationNotFoundError) {
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
        return NextResponse.json(
          { error: "Session not found" } satisfies ApiError,
          { status: 404 },
        );
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
          return NextResponse.json(
            { error: "Artifact not found" } satisfies ApiError,
            { status: 404 },
          );
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
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 404,
          });
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
          return NextResponse.json({ error: err.message } satisfies ApiError, {
            status: 404,
          });
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
