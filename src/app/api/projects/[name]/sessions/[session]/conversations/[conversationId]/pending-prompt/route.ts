import { createPendingPromptRouteHandlers } from "@/lib/pending-prompt-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createPendingPromptRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/pending-prompt — persist or clear the in-progress prompt text */
export const POST = handlers.POST;
