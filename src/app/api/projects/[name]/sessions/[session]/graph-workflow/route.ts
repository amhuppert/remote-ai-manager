import { withTracing } from "@/lib/logging";
import { createGraphWorkflowExecutionRouteHandlers } from "@/lib/workflow-graph/execution-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createGraphWorkflowExecutionRouteHandlers();

export const GET = withTracing(async (request, context) =>
  handlers.STATUS(request, context),
);

export const POST = withTracing(async (request, context) =>
  handlers.START(request, context),
);
