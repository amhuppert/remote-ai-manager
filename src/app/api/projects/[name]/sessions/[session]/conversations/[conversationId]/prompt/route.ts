import { withTracing } from "@/lib/logging";
import { createPromptRouteHandlers } from "@/lib/prompt-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createPromptRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt — execute a prompt (SSE stream) */
export const POST = withTracing(handlers.conversationPOST);
