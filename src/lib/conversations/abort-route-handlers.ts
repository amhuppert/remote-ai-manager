/**
 * Route handler for aborting a running conversation prompt.
 *
 * Signals the AbortController to stop SDK execution and sends an ABORT_TURN
 * event for a clean state transition in the conversation machine (which also
 * clears any pending question).
 */

import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { abortConversation as abortConversationRegistry } from "@/lib/conversations/abort-registry";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("abort-route-handlers");

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/abort — abort a running prompt */
export const abortConversation = withTracing(async (_request, { params }) => {
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

  // Signal the AbortController to stop SDK execution
  const aborted = abortConversationRegistry(conversationId);

  // Send ABORT_TURN to the machine for a clean state transition. The
  // AbortController signal above already stops SDK execution, so a machine
  // refusal is not a request failure — but it must be diagnosable from logs.
  const machineAccepted = sendConversationEvent(
    projectPath,
    sessionName,
    conversationId,
    { type: "ABORT_TURN", reason: "user" },
  );
  if (!machineAccepted) {
    logger.warn("abort.event_rejected", {
      conversationId,
      sessionName,
    });
  }

  if (!aborted) {
    return NextResponse.json(
      { error: "No running prompt to abort" } satisfies ApiError,
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
});
