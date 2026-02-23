import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { executePromptStream } from "@/lib/prompt";
import { isSessionBusy } from "@/lib/lock";
import { runPromptRequestSchema } from "@/lib/schemas";
import type { RunPromptRequest } from "@/types";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/prompt — execute a prompt (SSE stream) */
export const POST = withTracing(async (request, { params }) => {
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

  // Check single-flight lock
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
        error: "prompt is required and must be a non-empty string",
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
          undefined,
          body.modelId,
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
