import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import {
  createConversation,
  getSessionConversations,
  discoverAndImportConversations,
  syncConversationSummaries,
} from "@/lib/conversations";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/conversations — list conversations */
export const GET = withTracing(async (request, { params }) => {
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

  // Auto-import discovery and summary sync when ?import=true
  const url = new URL(request.url);
  if (url.searchParams.get("import") === "true") {
    await discoverAndImportConversations(projectPath, session);
    await syncConversationSummaries(projectPath, session);
  }

  const conversations = await getSessionConversations(projectPath, sessionName);
  return NextResponse.json(conversations);
});

/** POST /api/projects/[name]/sessions/[session]/conversations — create conversation */
export const POST = withTracing(async (_request, { params }) => {
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

  const conversation = await createConversation(projectPath, sessionName);
  return NextResponse.json(conversation, { status: 201 });
});
