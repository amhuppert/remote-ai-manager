import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getSessionConversations } from "@/lib/conversations";
import { withTracing } from "@/lib/logging";
import { createConversationRouteHandlers } from "@/lib/conversation-route-handlers";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

const conversationHandlers = createConversationRouteHandlers();

/** GET /api/projects/[name]/sessions/[session]/conversations — list conversations */
export const GET = withTracing(async (_request, { params }) => {
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

  const conversations = await getSessionConversations(projectPath, sessionName);
  return NextResponse.json(conversations);
});

/** POST /api/projects/[name]/sessions/[session]/conversations — create conversation */
export const POST = withTracing((request, context) =>
  conversationHandlers.POST_CREATE(request, context),
);
