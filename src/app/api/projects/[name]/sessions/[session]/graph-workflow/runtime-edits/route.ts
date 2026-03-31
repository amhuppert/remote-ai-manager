import { withTracing } from "@/lib/logging";
import { createGraphWorkflowRuntimeEditRouteHandlers } from "@/lib/workflow-graph/runtime-edit-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createGraphWorkflowRuntimeEditRouteHandlers();

export const POST = withTracing(async (request, context) =>
  handlers.POST(request, context),
);
