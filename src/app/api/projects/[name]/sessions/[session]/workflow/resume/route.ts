import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST — Resume a paused or halted workflow */
export const POST = withTracing(handlers.resumePOST);
