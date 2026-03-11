import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST — Reset a completed/halted/aborted workflow (archives it to history) */
export const POST = withTracing(handlers.resetPOST);
