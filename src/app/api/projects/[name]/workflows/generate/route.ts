import { withTracing } from "@/lib/logging";
import { createWorkflowGenerateRouteHandlers } from "@/lib/workflow-graph/generate-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowGenerateRouteHandlers();

export const POST = withTracing(async (request, context) =>
  handlers.POST(request, context),
);
