import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST — Pause a running workflow (stops after current iteration) */
export const POST = withTracing(handlers.pausePOST);
