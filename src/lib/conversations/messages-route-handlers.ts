/**
 * Conversation messages route handler — extracted for dependency injection.
 *
 * The production route delegates to handlers from `createMessagesRouteHandlers(deps)`;
 * tests construct their own deps. Supports cursor reconciliation via the
 * `?since=<seq>` query parameter so a client that lost SSE coverage can ask
 * for only the transcript entries newer than its last-seen seq.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import { readConversationMessagesWithSeq as defaultReadConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import type { ApiError } from "@/lib/api/errors";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
export interface MessagesRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  readConversationMessagesWithSeq(
    transcriptPath: string | null,
  ): Promise<Array<TranscriptMessage & { seq: number }>>;
}

const defaultDeps: MessagesRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  readConversationMessagesWithSeq: defaultReadConversationMessagesWithSeq,
};

type RouteContext = {
  params: Promise<Record<string, string>>;
};

/**
 * Parse the optional `?since=<integer>` cursor from a URL. Returns the parsed
 * value when it is a non-negative integer; otherwise returns null so the
 * handler falls back to returning the full transcript.
 */
export function parseSinceParam(url: string): number | null {
  const raw = new URL(url).searchParams.get("since");
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function createMessagesRouteHandlers(
  deps: MessagesRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const conversationId = resolvedParams["conversationId"] ?? "";

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const projectPath = resolved.value.projectPath;

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    try {
      const messages = await deps.readConversationMessagesWithSeq(
        conversation.transcriptPath,
      );
      const sorted = [...messages].sort((a, b) => a.seq - b.seq);
      const since = parseSinceParam(request.url);
      const filtered =
        since === null ? sorted : sorted.filter((m) => m.seq > since);
      return NextResponse.json(filtered);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read messages";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultMessagesHandlers = createMessagesRouteHandlers();
export const getMessages = withTracing(_defaultMessagesHandlers.GET);
