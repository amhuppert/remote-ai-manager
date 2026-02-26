import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getConversation } from "@/lib/conversations";
import { executePromptStream } from "@/lib/prompt";
import { isSessionBusy } from "@/lib/lock";
import { runPromptRequestSchema } from "@/lib/schemas";
import type { RunPromptRequest } from "@/types";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt — execute a prompt (SSE stream) */
export const POST = withTracing(async (request, { params }) => {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);
  const conversationId = resolvedParams["conversationId"] ?? "";

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

  const conversation = await getConversation(
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

  // Reject prompts to managed iteration conversations
  if (conversation.role === "iteration") {
    return NextResponse.json(
      {
        error: "Managed workflow conversations are not user-interactive",
        code: "MANAGED_CONVERSATION",
      } satisfies ApiError,
      { status: 403 },
    );
  }

  // Reject prompts when a workflow is actively running
  if (session.workflow?.status === "running") {
    return NextResponse.json(
      {
        error:
          "Session has an active workflow — prompts are blocked during execution",
        code: "WORKFLOW_ACTIVE",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  // Check single-flight lock at session level
  if (isSessionBusy(projectPath, sessionName)) {
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
          // Client disconnected — safe to ignore
        }
      };

      try {
        await executePromptStream(
          projectPath,
          session,
          body.prompt.trim(),
          emit,
          conversationId,
          body.modelId,
          body.images,
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
      // No-op: let the execution continue in the background.
      // The SDK process must survive client disconnects (navigation, browser close).
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
