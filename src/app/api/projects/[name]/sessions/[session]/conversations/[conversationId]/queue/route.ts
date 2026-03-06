import { withTracing } from "@/lib/logging";
import { createQueueRouteHandlers } from "@/lib/queue-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createQueueRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue — queue a message into a running conversation */
export const POST = withTracing(handlers.POST);
