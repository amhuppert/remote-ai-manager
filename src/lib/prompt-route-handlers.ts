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
import { executePromptStream as defaultExecutePromptStream } from "@/lib/prompt";
import { isSessionBusy as defaultIsSessionBusy } from "@/lib/lock";
import { runPromptRequestSchema } from "@/lib/schemas";
import type {
  RunPromptRequest,
  SessionState,
  ConversationState,
  ApiError,
} from "@/types";

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
  isSessionBusy: (projectPath: string, sessionName: string) => boolean;
  executePromptStream: typeof defaultExecutePromptStream;
}

const defaultDeps: PromptRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  isSessionBusy: defaultIsSessionBusy,
  executePromptStream: defaultExecutePromptStream,
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

    if (deps.isSessionBusy(projectPath, sessionName)) {
      return NextResponse.json(
        {
          error: "Session is busy — a prompt is already running",
          code: "SESSION_BUSY",
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
            { effort: body.effort },
          );
        } catch (err) {
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

    if (deps.isSessionBusy(projectPath, sessionName)) {
      return NextResponse.json(
        {
          error: "Session is busy — a prompt is already running",
          code: "SESSION_BUSY",
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
            { effort: body.effort },
          );
        } catch (err) {
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
