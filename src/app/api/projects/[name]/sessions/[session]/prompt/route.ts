import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { executePrompt } from "@/lib/prompt";
import { isSessionBusy } from "@/lib/lock";
import { runPromptRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { RunPromptResponse, ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/prompt — execute a prompt */
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

  let body: { prompt: string };
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

  try {
    const result = await executePrompt(
      projectPath,
      session,
      body.prompt.trim(),
    );

    const response: RunPromptResponse = { success: true };
    return NextResponse.json(response, {
      headers: {
        "X-Claude-Output-Length": String(result.output.length),
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to execute prompt";

    // If it's a busy error from the lock, return 409
    if (message.includes("Session is busy")) {
      return NextResponse.json(
        { error: message, code: "SESSION_BUSY" } satisfies ApiError,
        { status: 409 },
      );
    }

    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
