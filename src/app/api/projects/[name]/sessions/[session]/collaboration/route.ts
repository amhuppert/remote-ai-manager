import { withTracing } from "@/lib/logging";
import { createCollaborationRouteHandlers } from "@/lib/workflows/collaboration/route-handlers";

export const dynamic = "force-dynamic";

const handlers = createCollaborationRouteHandlers();

export const POST = withTracing(async (request, context) =>
  handlers.START(request, context),
);

export const GET = withTracing(async (request, context) =>
  handlers.LIST(request, context),
);
