import { withTracing } from "@/lib/logging";
import { createGraphWorkflowExecutionRouteHandlers } from "@/lib/workflow-graph/execution-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createGraphWorkflowExecutionRouteHandlers();

export const POST = withTracing(async (request, context) =>
  handlers.RESUME(request, context),
);
