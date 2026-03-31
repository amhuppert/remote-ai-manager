import { withTracing } from "@/lib/logging";
import { createWorkflowDefinitionRouteHandlers } from "@/lib/workflow-graph/route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowDefinitionRouteHandlers();

export const GET = withTracing(async (request, context) =>
  handlers.GET(request, context),
);

export const PUT = withTracing(async (request, context) =>
  handlers.UPDATE(request, context),
);

export const DELETE = withTracing(async (request, context) =>
  handlers.DELETE(request, context),
);
