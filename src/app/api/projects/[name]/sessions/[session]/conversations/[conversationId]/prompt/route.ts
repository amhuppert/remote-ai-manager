import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt — execute a prompt (SSE stream) */
export const POST = withTracing(handlers.conversationPromptPOST);
