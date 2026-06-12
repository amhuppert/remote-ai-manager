/**
 * Conversation lookup route handler — resolves a session-scoped conversation
 * by id alone, so `/conversations?c=<id>` deep links can recover the owning
 * project/session without carrying them in the URL.
 */

import { NextResponse } from "next/server";
import { findConversationById as defaultFindConversationById } from "./cross-project-list";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationListItem } from "./schemas";

const log = createLogger("conversation-lookup-route-handlers");

export interface ConversationLookupRouteDeps {
  findConversationById(
    conversationId: string,
  ): Promise<ConversationListItem | null>;
}

const defaultDeps: ConversationLookupRouteDeps = {
  findConversationById: defaultFindConversationById,
};

export function createConversationLookupRouteHandlers(
  deps: ConversationLookupRouteDeps = defaultDeps,
) {
  /** GET /api/conversations/[conversationId] — resolve a conversation by id */
  const GET = withTracing(async (_request, { params }) => {
    const resolvedParams = await params;
    const conversationId = resolvedParams["conversationId"] ?? "";

    try {
      const item =
        conversationId === ""
          ? null
          : await deps.findConversationById(conversationId);
      if (!item) {
        log.warn("conversation.lookup.miss", { conversationId });
        return NextResponse.json(
          { error: "conversation_not_found" } satisfies ApiError,
          { status: 404 },
        );
      }
      log.info("conversation.lookup.hit", {
        conversationId,
        projectName: item.projectName,
        sessionName: item.sessionName,
        archived: item.archived,
      });
      return NextResponse.json(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("conversation.lookup.failed", { conversationId, err: message });
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  });
  return { GET };
}

export const { GET: GET_ConversationLookup } =
  createConversationLookupRouteHandlers();
