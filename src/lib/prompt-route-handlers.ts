/**
 * Prompt route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createPromptRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import { getConversation as defaultGetConversation } from "@/lib/conversations";
import {
  executePromptStream as defaultExecutePromptStream,
  BackendMismatchError,
  ModelEffortValidationError,
  CollabBriefRequiredError,
  CollabDispatcherUnavailableError,
  hasCollabPrefix,
  stripCollabPrefix,
} from "@/lib/prompt";
import { isConversationBusy as defaultIsConversationBusy } from "@/lib/lock";
import { runPromptRequestSchema } from "@/lib/schemas";
import {
  getDefaultCollaborationManager,
  type CollaborationManager,
  CollaborationConversationNotFoundError,
  CollaborationSessionNotFoundError,
} from "@/lib/workflows/collaboration/manager";
import type {
  RunPromptRequest,
  SessionState,
  ConversationState,
  ApiError,
} from "@/types";

const DEFAULT_NEGOTIATION_ROUNDS = 3;
const DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD = "major" as const;

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface PromptRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
  getConversation: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => Promise<ConversationState | null>;
  isConversationBusy: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => boolean;
  executePromptStream: typeof defaultExecutePromptStream;
  getCollaborationManager: () => CollaborationManager;
}

const defaultDeps: PromptRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  isConversationBusy: defaultIsConversationBusy,
  executePromptStream: defaultExecutePromptStream,
  getCollaborationManager: getDefaultCollaborationManager,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPromptRouteHandlers(deps: PromptRouteDeps = defaultDeps) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    // Session-level POSTs create a fresh conversation, so there is nothing
    // to be busy. Concurrency across conversations within a session is
    // allowed by design — gating happens at the conversation level.

    let body: RunPromptRequest;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        {
          error: "Either prompt text or at least one image is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const trimmedSessionPrompt = body.prompt.trim();
    const isSessionCollab = hasCollabPrefix(trimmedSessionPrompt);
    if (isSessionCollab) {
      const sessionBrief = stripCollabPrefix(trimmedSessionPrompt).trim();
      if (sessionBrief.length === 0) {
        return NextResponse.json(
          {
            error:
              "/collab prompt must include a brief after the slash command",
            code: "COLLAB_BRIEF_REQUIRED",
          } satisfies ApiError,
          { status: 400 },
        );
      }
    }

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
            // Client disconnected
          }
        };

        try {
          await deps.executePromptStream(
            projectPath,
            session,
            body.prompt.trim(),
            emit,
            undefined,
            body.modelId,
            body.images,
            {
              effort: body.effort,
              backend: body.backend,
              ...(isSessionCollab && body.collab
                ? {
                    collab: {
                      ...(body.collab.negotiationRounds !== undefined
                        ? { negotiationRounds: body.collab.negotiationRounds }
                        : {}),
                      ...(body.collab.autonomousResolutionThreshold !==
                      undefined
                        ? {
                            autonomousResolutionThreshold:
                              body.collab.autonomousResolutionThreshold,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          );
        } catch (err) {
          if (err instanceof CollabBriefRequiredError) {
            emit("error", { message: err.message, code: err.code });
            emit("done", {});
            return;
          }
          if (err instanceof CollabDispatcherUnavailableError) {
            emit("error", { message: err.message, code: err.code });
            emit("done", {});
            return;
          }
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
            // Already closed
          }
        }
      },
      cancel() {
        // No-op: let execution continue in background
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

  /**
   * POST handler for conversation-specific prompts.
   * Resolves conversationId from route params and guards against
   * prompting managed (iteration) conversations.
   */
  async function conversationPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (conversation.role === "iteration") {
      return NextResponse.json(
        {
          error: "Managed workflow conversations are not user-interactive",
          code: "MANAGED_CONVERSATION",
        } satisfies ApiError,
        { status: 403 },
      );
    }

    if (deps.isConversationBusy(projectPath, sessionName, conversationId)) {
      return NextResponse.json(
        {
          error: "Conversation is busy — a prompt is already running",
          code: "CONVERSATION_BUSY",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: RunPromptRequest;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        {
          error: "Either prompt text or at least one image is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const trimmedPrompt = body.prompt.trim();
    if (hasCollabPrefix(trimmedPrompt)) {
      const brief = stripCollabPrefix(trimmedPrompt).trim();
      if (brief.length === 0) {
        return NextResponse.json(
          {
            error:
              "/collab prompt must include a brief after the slash command",
            code: "COLLAB_BRIEF_REQUIRED",
          } satisfies ApiError,
          { status: 400 },
        );
      }
      try {
        const manager = deps.getCollaborationManager();
        const result = await manager.start({
          projectPath,
          sessionName,
          conversationId,
          brief,
          negotiationRounds:
            body.collab?.negotiationRounds ?? DEFAULT_NEGOTIATION_ROUNDS,
          autonomousResolutionThreshold:
            body.collab?.autonomousResolutionThreshold ??
            DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD,
        });
        const statusUrl = `/api/projects/${encodeURIComponent(name)}/sessions/${encodeURIComponent(sessionName)}/collaboration/${encodeURIComponent(result.workflowId)}`;
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
        const message =
          err instanceof Error ? err.message : "Failed to start collaboration";
        return NextResponse.json({ error: message } satisfies ApiError, {
          status: 500,
        });
      }
    }

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
            // Client disconnected
          }
        };

        try {
          await deps.executePromptStream(
            projectPath,
            session,
            body.prompt.trim(),
            emit,
            conversationId,
            body.modelId,
            body.images,
            {
              effort: body.effort,
              backend: body.backend,
            },
          );
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
            // Already closed
          }
        }
      },
      cancel() {
        // No-op: let execution continue in background
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

  return { POST, conversationPOST };
}
