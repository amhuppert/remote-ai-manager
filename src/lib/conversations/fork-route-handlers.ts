/**
 * Route handler for forking a conversation at a given message index.
 *
 * Validates the source conversation, dispatches to the fork service, and
 * maps typed `ForkValidationError` / `ForkCreationError` failures to the
 * appropriate HTTP status codes.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import {
  getConversation,
  forkConversation as forkConversationService,
  ForkCreationError,
  ForkValidationError,
} from "@/lib/conversations/service";
import { forkRequestSchema } from "@/lib/conversations/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("api.fork-conversation");

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/fork — fork a conversation */
export const forkConversation = withTracing(async (request, { params }) => {
  const bodyPromise = request.json();
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);
  const conversationId = resolvedParams["conversationId"] ?? "";

  const resolved = await resolveProjectSessionOr404(
    { resolveProjectPath, getSession },
    name,
    sessionName,
  );
  if (!resolved.ok) return resolved.response;
  const projectPath = resolved.value.projectPath;

  const conversation = await getConversation(
    projectPath,
    sessionName,
    conversationId,
  );
  if (!conversation) {
    return notFound("Conversation not found");
  }

  let body: { messageIndex: number };
  try {
    body = forkRequestSchema.parse(await bodyPromise);
  } catch {
    return NextResponse.json(
      { error: "Invalid request: messageIndex is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  const baseLogFields = {
    projectPath,
    projectName: name,
    sessionName,
    sourceConversationId: conversationId,
    messageIndex: body.messageIndex,
  };

  try {
    const result = await forkConversationService({
      projectPath,
      sessionName,
      sourceConversationId: conversationId,
      messageIndex: body.messageIndex,
    });

    if (result.forkMode === "synthetic") {
      logger.info("fork.success.synthetic", {
        ...baseLogFields,
        newConversationId: result.conversationId,
      });
    } else {
      logger.info("fork.success.native", {
        ...baseLogFields,
        newConversationId: result.conversationId,
        forkMode: result.forkMode,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ForkValidationError) {
      const status = err.kind === "source_not_found" ? 404 : 400;
      logger.warn("fork.error.typed", {
        ...baseLogFields,
        errorKind: err.kind,
        errorName: err.name,
        message: err.message,
        status,
      });
      return NextResponse.json({ error: err.message } satisfies ApiError, {
        status,
      });
    }

    if (err instanceof ForkCreationError) {
      logger.warn("fork.error.typed", {
        ...baseLogFields,
        errorKind: err.kind,
        errorName: err.name,
        message: err.message,
        status: 422,
      });
      return NextResponse.json({ error: err.message } satisfies ApiError, {
        status: 422,
      });
    }

    const message = err instanceof Error ? err.message : "Fork failed";
    logger.error("fork.error.unknown", {
      ...baseLogFields,
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
