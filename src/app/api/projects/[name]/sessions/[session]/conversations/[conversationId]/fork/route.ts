import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import {
  getConversation,
  forkConversation,
  ForkCreationError,
  ForkValidationError,
} from "@/lib/conversations";
import { forkRequestSchema } from "@/lib/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const logger = createLogger("api.fork-conversation");

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/fork — fork a conversation */
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

  if (conversation.status === "running") {
    return NextResponse.json(
      { error: "Cannot fork while conversation is running" } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: { messageIndex: number };
  try {
    body = forkRequestSchema.parse(await request.json());
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
    const result = await forkConversation({
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
