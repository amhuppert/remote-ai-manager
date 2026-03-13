import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST — Stop a running workflow (preserves progress, resumable) */
export const POST = withTracing(handlers.stopPOST);
