import { withTracing } from "@/lib/logging";
import { createWorkflowEnvelopesRouteHandlers } from "@/lib/workflow-envelopes-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createWorkflowEnvelopesRouteHandlers();

export const GET = withTracing(async (request, context) =>
  handlers.GET(request, context),
);
