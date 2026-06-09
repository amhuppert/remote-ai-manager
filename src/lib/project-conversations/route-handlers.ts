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
import { broadcast as defaultBroadcast } from "@/lib/events/broadcaster";
import { readConversationMessagesWithSeq as defaultReadConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { createLogger } from "@/lib/logging";
import {
  createProjectConversationRequestSchema,
  projectConversationOpenRequestSchema,
} from "./schemas";
import { createProjectConversationService } from "./service";
import { buildProjectConversationCreatedEvent } from "./events";
import { executeProjectPromptStream as defaultExecuteProjectPromptStream } from "./prompt-entry";
import type { ApiError } from "@/lib/api/errors";
import type { SSEEvent } from "@/lib/api/sse-events";
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
  broadcast(event: SSEEvent): void;
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
    broadcast: defaultBroadcast,
  };
}

function projectNotFound(): Response {
  return NextResponse.json({ error: "Project not found" } satisfies ApiError, {
    status: 404,
  });
}

function conversationNotFound(): Response {
  return NextResponse.json(
    { error: "Conversation not found" } satisfies ApiError,
    { status: 404 },
  );
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
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    let body: {
      agentBackend?: ConversationState["agentBackend"];
      name?: string;
    };
    try {
      body = createProjectConversationRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" } satisfies ApiError,
        { status: 400 },
      );
    }

    const conversation = await deps.createProjectConversation(
      projectPath,
      body,
    );
    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      deps.broadcast(
        buildProjectConversationCreatedEvent(projectName, conversation),
      );
    } catch (err) {
      logger.warn("project_conversation_created.broadcast_failed", {
        projectName,
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json(conversation, { status: 201 });
  }

  async function listGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const conversations = await deps.listProjectConversations(projectPath);
    return NextResponse.json(conversations);
  }

  async function messagesGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const conversation = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!conversation) return conversationNotFound();

    try {
      const messages = await deps.readConversationMessagesWithSeq(
        conversation.transcriptPath,
      );
      const sorted = [...messages].sort((a, b) => a.seq - b.seq);
      return NextResponse.json(sorted);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read messages";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  async function firstPromptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    let body: ReturnType<typeof runPromptRequestSchema.parse>;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "prompt or images required" } satisfies ApiError,
        { status: 400 },
      );
    }

    return streamPrompt(projectPath, undefined, body);
  }

  async function promptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const existing = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!existing) return conversationNotFound();

    if (
      deps.isConversationBusy(
        projectPath,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId ?? "",
      )
    ) {
      return NextResponse.json(
        { error: "Conversation is busy" } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: ReturnType<typeof runPromptRequestSchema.parse>;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "prompt or images required" } satisfies ApiError,
        { status: 400 },
      );
    }

    return streamPrompt(projectPath, conversationId, body);
  }

  async function renamePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const existing = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!existing) return conversationNotFound();

    let body: { name: string };
    try {
      body = renameConversationRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "name (non-empty string) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.renameProjectConversation(
        projectPath,
        conversationId ?? "",
        body.name,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rename conversation";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      deps.broadcast(
        conversationRenamedEventSchema.parse({
          type: "conversation-renamed",
          scope: "project",
          projectName,
          conversationId,
          name: body.name,
        }),
      );
    } catch (err) {
      logger.warn("project_conversation_renamed.broadcast_failed", {
        projectName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  async function archivePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const existing = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!existing) return conversationNotFound();

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
      await deps.setProjectConversationArchived(
        projectPath,
        conversationId ?? "",
        body.archived,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      deps.broadcast(
        conversationArchivedEventSchema.parse({
          type: "conversation-archived",
          scope: "project",
          projectName,
          conversationId,
          archived: body.archived,
        }),
      );
    } catch (err) {
      logger.warn("project_conversation_archived.broadcast_failed", {
        projectName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  async function openPATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const existing = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!existing) return conversationNotFound();

    let body: { open: boolean };
    try {
      body = projectConversationOpenRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "open (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.setProjectConversationOpen(
        projectPath,
        conversationId ?? "",
        body.open,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update open state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      deps.broadcast(
        conversationOpenEventSchema.parse({
          type: "conversation-open",
          scope: "project",
          projectName,
          conversationId,
          open: body.open,
        }),
      );
    } catch (err) {
      logger.warn("project_conversation_open.broadcast_failed", {
        projectName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  async function markReadPOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name, conversationId } = await context.params;
    const projectPath = await deps.resolveProjectPath(name ?? "");
    if (!projectPath) return projectNotFound();

    const existing = await deps.getProjectConversation(
      projectPath,
      conversationId ?? "",
    );
    if (!existing) return conversationNotFound();

    try {
      await deps.markProjectConversationRead(projectPath, conversationId ?? "");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to mark as read";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      deps.broadcast(
        conversationUnreadEventSchema.parse({
          type: "conversation-unread",
          scope: "project",
          projectName,
          conversationId,
          unread: false,
        }),
      );
    } catch (err) {
      logger.warn("project_conversation_mark_read.broadcast_failed", {
        projectName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
