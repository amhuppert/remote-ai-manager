import { withTracing } from "@/lib/logging";
import { createWorkflowDefinitionRouteHandlers } from "@/lib/workflow-graph/route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowDefinitionRouteHandlers();

export const GET = withTracing(async (request, context) =>
  handlers.LIST(request, context),
);

export const POST = withTracing(async (request, context) =>
  handlers.CREATE(request, context),
);
