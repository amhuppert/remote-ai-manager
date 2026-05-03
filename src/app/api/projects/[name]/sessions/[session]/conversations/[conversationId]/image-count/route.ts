import { withTracing } from "@/lib/logging";
import { createImageCountRouteHandlers } from "@/lib/image-count-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createImageCountRouteHandlers();

/** GET .../conversations/[conversationId]/image-count — cumulative image count for the conversation */
export const GET = withTracing(handlers.GET);
