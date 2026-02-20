import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { renameConversation } from "@/lib/conversations";
import { renameConversationRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** PATCH /api/projects/[name]/sessions/[session]/conversations/[conversationId]/rename — rename conversation */
export const PATCH = withTracing(async (request, { params }) => {
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

  let body: { name: string };
  try {
    body = renameConversationRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "name (non-empty string) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await renameConversation(
      projectPath,
      sessionName,
      conversationId,
      body.name,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to rename conversation";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
