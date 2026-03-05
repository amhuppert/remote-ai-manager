import { withTracing } from "@/lib/logging";
import { createWorkflowRouteHandlers } from "@/lib/ralph-loop/workflow-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowRouteHandlers();

/** POST — Start a new workflow (creates in planning status) */
export const POST = withTracing(handlers.workflowPOST);

/** GET — Get current workflow state */
export const GET = withTracing(handlers.workflowGET);

/** PATCH — Update workflow objective */
export const PATCH = withTracing(handlers.workflowPATCH);
