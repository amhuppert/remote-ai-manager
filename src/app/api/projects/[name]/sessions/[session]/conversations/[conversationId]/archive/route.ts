import { withTracing } from "@/lib/logging";
import { createConversationRouteHandlers } from "@/lib/conversation-route-handlers";

export const dynamic = "force-dynamic";

const conversationHandlers = createConversationRouteHandlers();

/** PATCH /api/projects/[name]/sessions/[session]/conversations/[conversationId]/archive — archive/unarchive conversation */
export const PATCH = withTracing((request, context) =>
  conversationHandlers.PATCH_ARCHIVE(request, context),
);
