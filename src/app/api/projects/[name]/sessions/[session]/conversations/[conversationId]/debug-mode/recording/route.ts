import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { debugRecordingRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST .../debug-mode/recording — start/stop debug log recording */
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

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  if (!conversation.debugMode?.active) {
    return NextResponse.json(
      { error: "Conversation is not in debug mode" } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: { recording: boolean };
  try {
    body = debugRecordingRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "recording (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    sendConversationEvent(projectPath, sessionName, conversationId, {
      type: "SET_DEBUG_RECORDING",
      recording: body.recording,
    });

    // syncDerivedFields is fire-and-forget in the machine, so the SSE broadcast
    // and query invalidation can race ahead of the state.json write. Await the
    // write here so callers always re-fetch up-to-date recording state.
    const { mutateConversation } = await import("@/lib/state");
    await mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "debug-recording-toggle",
      (c) => {
        if (c.debugMode) c.debugMode.recording = body.recording;
      },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update recording state";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
