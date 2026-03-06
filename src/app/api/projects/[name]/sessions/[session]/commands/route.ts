import { withTracing } from "@/lib/logging";
import { createCommandsRouteHandlers } from "@/lib/commands-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createCommandsRouteHandlers();

/** GET /api/projects/[name]/sessions/[session]/commands — discover available commands */
export const GET = withTracing(handlers.GET);
