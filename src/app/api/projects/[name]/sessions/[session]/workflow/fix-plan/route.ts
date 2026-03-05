import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** PUT — Update fix plan (only during planning or paused) */
export const PUT = withTracing(handlers.fixPlanPUT);
