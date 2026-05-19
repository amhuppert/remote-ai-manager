import { withTracing } from "@/lib/logging";
import { createConversationRouteHandlers } from "@/lib/conversation-route-handlers";

export const dynamic = "force-dynamic";

const conversationHandlers = createConversationRouteHandlers();

/** PATCH /api/projects/[name]/sessions/[session]/conversations/[conversationId]/rename — rename conversation */
export const PATCH = withTracing((request, context) =>
  conversationHandlers.PATCH_RENAME(request, context),
);
