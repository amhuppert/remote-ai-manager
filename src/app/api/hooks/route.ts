import { NextResponse } from "next/server";
import { processHookEvent } from "@/lib/hooks";
import { hookEventDataSchema } from "@/lib/schemas";
import { broadcast } from "@/lib/sse-broadcaster";
import { withTracing, createLogger } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const logger = createLogger("hooks.route");

/**
 * POST /api/hooks — receive Claude Code hook events.
 *
 * Claude hooks fire with JSON on stdin. The hook command should forward
 * this data to this endpoint via curl:
 *
 *   cat | curl -s -X POST http://localhost:3000/api/hooks \
 *     -H "Content-Type: application/json" -d @-
 *
 * The endpoint matches the `cwd` to a managed session's worktreePath
 * and updates the session's claudeSessionId and transcriptPath.
 */
export const POST = withTracing(async (request: Request) => {
  let rawPayload: unknown;
  let body;
  try {
    rawPayload = await request.json();
    body = hookEventDataSchema.parse(rawPayload);
  } catch {
    logger.warn("hook.validation_failure", {
      rawPayload,
    });
    return NextResponse.json(
      { error: "Invalid JSON body" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const result = await processHookEvent(body);

    if (
      result.matched &&
      body.hook_event_name === "Stop" &&
      result.projectName &&
      result.sessionName &&
      result.conversationId
    ) {
      try {
        broadcast({
          type: "session-ready",
          projectName: result.projectName,
          sessionName: result.sessionName,
          conversationId: result.conversationId,
        });
        broadcast({
          type: "conversation-status",
          projectName: result.projectName,
          sessionName: result.sessionName,
          conversationId: result.conversationId,
          status: "awaiting",
        });
      } catch {
        // Fire-and-forget: broadcast failures must not affect the hook response
      }
    }

    return NextResponse.json({ matched: result.matched });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to process hook event";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
