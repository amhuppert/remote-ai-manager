import { createMessagesRouteHandlers } from "@/lib/messages-route-handlers";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

const handlers = createMessagesRouteHandlers();

/**
 * GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages
 *
 * Returns the conversation transcript as a seq-stamped array. Accepts an
 * optional `?since=<integer>` query parameter for cursor reconciliation:
 * when set to a non-negative integer, only entries with `seq > since` are
 * returned. Malformed or missing `since` falls back to the full transcript.
 */
export const GET = withTracing(async (request, context) =>
  handlers.GET(request, context),
);
