/**
 * Image-count route handler — extracted for dependency injection.
 *
 * Returns the cumulative number of images persisted for a conversation,
 * used by the prompt editor to render the next inline `[Image #N]` marker.
 */

import { NextResponse } from "next/server";
import { resolveProjectSessionOr404 } from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { getNextImageIndex as defaultGetNextImageIndex } from "@/lib/images/transcript-images";
import type { SessionState } from "@/lib/sessions/schemas";
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

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;

    const nextIndex = await deps.getNextImageIndex(conversationId);
    return NextResponse.json({ count: Math.max(0, nextIndex - 1) });
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultImageCountHandlers = createImageCountRouteHandlers();
export const getImageCount = withTracing(_defaultImageCountHandlers.GET);
