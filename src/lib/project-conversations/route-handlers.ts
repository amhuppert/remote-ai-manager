/**
 * Project-conversation route handlers — session-less prompt + lifecycle.
 *
 * Mirrors the session prompt/lifecycle handlers, swapping the session lookup
 * for `resolveProjectPath` + the project sentinel and the executor for
 * `executeProjectPromptStream`. Lifecycle mutations broadcast scope=project
 * SSE events.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  BackendMismatchError,
  ModelEffortValidationError,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import { isConversationBusy as defaultIsConversationBusy } from "@/lib/prompt/single-flight";
import { runPromptRequestSchema } from "@/lib/prompt/schemas";
import { renameConversationRequestSchema } from "@/lib/conversations/schemas";
import {
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  conversationOpenEventSchema,
  conversationUnreadEventSchema,
} from "@/lib/conversations/schemas";
import { sessionArchiveRequestSchema } from "@/lib/sessions/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import {
  resolveProjectOr404,
  parseJsonBody,
  jsonError,
} from "@/lib/shared/route-resolution";
import { resolveProjectConversationRoute } from "./route-resolution";
import { readConversationMessagesWithSeq as defaultReadConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { createLogger } from "@/lib/logging";
import {
  createProjectConversationRequestSchema,
  projectConversationOpenRequestSchema,
} from "./schemas";
import { createProjectConversationService } from "./service";
import { buildProjectConversationCreatedEvent } from "./events";
import { executeProjectPromptStream as defaultExecuteProjectPromptStream } from "./prompt-entry";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { ExecuteProjectPromptStreamInput } from "./prompt-entry";

const logger = createLogger("project-conversations.routes");

type RouteContext = { params: Promise<Record<string, string>> };

export interface ProjectConversationRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  createProjectConversation(
    projectPath: string,
    opts?: { agentBackend?: ConversationState["agentBackend"]; name?: string },
  ): Promise<ConversationState>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  listProjectConversations(projectPath: string): Promise<ConversationState[]>;
  readConversationMessagesWithSeq(
    transcriptPath: string | null,
  ): Promise<Array<TranscriptMessage & { seq: number }>>;
  renameProjectConversation(
    projectPath: string,
    conversationId: string,
    name: string,
  ): Promise<void>;
  setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void>;
  markProjectConversationRead(
    projectPath: string,
    conversationId: string,
  ): Promise<void>;
  executeProjectPromptStream(
    input: ExecuteProjectPromptStreamInput,
  ): Promise<PromptStreamResult>;
  isConversationBusy(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  broadcast: PublishFn;
}

function defaultDeps(): ProjectConversationRouteDeps {
  const service = createProjectConversationService();
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getProjectDisplayName: defaultGetProjectDisplayName,
    createProjectConversation: (projectPath, opts) =>
      service.createProjectConversation(projectPath, opts),
    getProjectConversation: (projectPath, id) =>
      service.getProjectConversation(projectPath, id),
    listProjectConversations: (projectPath) =>
      service.listProjectConversations(projectPath),
    readConversationMessagesWithSeq: defaultReadConversationMessagesWithSeq,
    renameProjectConversation: (projectPath, id, name) =>
      service.renameProjectConversation(projectPath, id, name),
    setProjectConversationArchived: (projectPath, id, archived) =>
      service.setProjectConversationArchived(projectPath, id, archived),
    setProjectConversationOpen: (projectPath, id, open) =>
      service.setProjectConversationOpen(projectPath, id, open),
    markProjectConversationRead: (projectPath, id) =>
      service.markProjectConversationRead(projectPath, id),
    executeProjectPromptStream: defaultExecuteProjectPromptStream,
    isConversationBusy: defaultIsConversationBusy,
    broadcast: publishEvent,
  };
}

export function createProjectConversationRouteHandlers(
  deps: ProjectConversationRouteDeps = defaultDeps(),
) {
  function streamPrompt(
    projectPath: string,
    conversationId: string | undefined,
    body: {
      prompt: string;
      modelId?: string;
      effort?: string;
      backend?: ConversationState["agentBackend"];
      images?: ExecuteProjectPromptStreamInput["images"];
    },
  ): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            // Client disconnected.
          }
        };

        try {
          await deps.executeProjectPromptStream({
            projectPath,
            ...(conversationId !== undefined ? { conversationId } : {}),
            promptText: body.prompt.trim(),
            emit,
            ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
            ...(body.images !== undefined ? { images: body.images } : {}),
            ...(body.backend !== undefined ? { backend: body.backend } : {}),
            ...(body.effort !== undefined ? { effort: body.effort } : {}),
          });
        } catch (err) {
          if (err instanceof BackendMismatchError) {
            emit("error", { message: err.message, code: "BACKEND_MISMATCH" });
            emit("done", {});
            return;
          }
          if (err instanceof ModelEffortValidationError) {
            emit("error", { message: err.message, code: "VALIDATION_ERROR" });
            emit("done", {});
            return;
          }
          const msg = err instanceof Error ? err.message : "Prompt failed";
          emit("error", { message: msg });
          emit("done", {});
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
      cancel() {
        // No-op: let execution continue in the background.
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async function createPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const parsed = await parseJsonBody(
      request,
      createProjectConversationRequestSchema,
      "Invalid request body",
    );
    if (!parsed.ok) return parsed.response;

    const conversation = await deps.createProjectConversation(
      projectPath,
      parsed.value,
    );
    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_created.broadcast_failed",
      context: { projectName, conversationId: conversation.id },
      build: () =>
        buildProjectConversationCreatedEvent(projectName, conversation),
    });

    return NextResponse.json(conversation, { status: 201 });
  }

  async function listGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;

    const conversations = await deps.listProjectConversations(project.value);
    return NextResponse.json(conversations);
  }

  async function messagesGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    try {
      const messages = await deps.readConversationMessagesWithSeq(
        resolved.value.conversation.transcriptPath,
      );
      const sorted = [...messages].sort((a, b) => a.seq - b.seq);
      return NextResponse.json(sorted);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read messages";
      return jsonError(message, 500);
    }
  }

  async function firstPromptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;

    const parsed = await parseJsonBody(
      request,
      runPromptRequestSchema,
      "prompt or images required",
    );
    if (!parsed.ok) return parsed.response;

    return streamPrompt(project.value, undefined, parsed.value);
  }

  async function promptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    if (
      deps.isConversationBusy(
        projectPath,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId,
      )
    ) {
      return jsonError("Conversation is busy", 409);
    }

    const parsed = await parseJsonBody(
      request,
      runPromptRequestSchema,
      "prompt or images required",
    );
    if (!parsed.ok) return parsed.response;

    return streamPrompt(projectPath, conversationId, parsed.value);
  }

  async function renamePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      renameConversationRequestSchema,
      "name (non-empty string) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.renameProjectConversation(
        projectPath,
        conversationId,
        parsed.value.name,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rename conversation";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_renamed.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationRenamedEventSchema.parse({
          type: "conversation-renamed",
          scope: "project",
          projectName,
          conversationId,
          name: parsed.value.name,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function archivePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      sessionArchiveRequestSchema,
      "archived (boolean) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.setProjectConversationArchived(
        projectPath,
        conversationId,
        parsed.value.archived,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_archived.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationArchivedEventSchema.parse({
          type: "conversation-archived",
          scope: "project",
          projectName,
          conversationId,
          archived: parsed.value.archived,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function openPATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      projectConversationOpenRequestSchema,
      "open (boolean) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.setProjectConversationOpen(
        projectPath,
        conversationId,
        parsed.value.open,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update open state";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_open.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationOpenEventSchema.parse({
          type: "conversation-open",
          scope: "project",
          projectName,
          conversationId,
          open: parsed.value.open,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function markReadPOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    try {
      await deps.markProjectConversationRead(projectPath, conversationId);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to mark as read";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_mark_read.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationUnreadEventSchema.parse({
          type: "conversation-unread",
          scope: "project",
          projectName,
          conversationId,
          unread: false,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  return {
    createPOST,
    listGET,
    messagesGET,
    firstPromptPOST,
    promptPOST,
    renamePATCH,
    archivePATCH,
    openPATCH,
    markReadPOST,
  };
}

const _handlers = createProjectConversationRouteHandlers();
export const projectConversationsCreatePOST = _handlers.createPOST;
export const projectConversationsListGET = _handlers.listGET;
export const projectConversationMessagesGET = _handlers.messagesGET;
export const projectFirstPromptPOST = _handlers.firstPromptPOST;
export const projectConversationPromptPOST = _handlers.promptPOST;
export const projectConversationRenamePATCH = _handlers.renamePATCH;
export const projectConversationArchivePATCH = _handlers.archivePATCH;
export const projectConversationOpenPATCH = _handlers.openPATCH;
export const projectConversationMarkReadPOST = _handlers.markReadPOST;
