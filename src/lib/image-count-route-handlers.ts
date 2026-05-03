/**
 * Image-count route handler — extracted for dependency injection.
 *
 * Returns the cumulative number of images persisted for a conversation,
 * used by the prompt editor to render the next inline `[Image #N]` marker.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import { getNextImageIndex as defaultGetNextImageIndex } from "@/lib/transcript-images";
import type { ApiError, SessionState } from "@/types";

export interface ImageCountRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getNextImageIndex(conversationId: string): Promise<number>;
}

const defaultDeps: ImageCountRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getNextImageIndex: defaultGetNextImageIndex,
};

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export function createImageCountRouteHandlers(
  deps: ImageCountRouteDeps = defaultDeps,
) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const nextIndex = await deps.getNextImageIndex(conversationId);
    return NextResponse.json({ count: Math.max(0, nextIndex - 1) });
  }

  return { GET };
}
