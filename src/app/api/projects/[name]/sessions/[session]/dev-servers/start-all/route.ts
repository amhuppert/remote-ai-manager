import { withTracing } from "@/lib/logging";
import { createDevServerRouteHandlers } from "@/lib/dev-server-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createDevServerRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/dev-servers/start-all */
export const POST = withTracing(handlers.START_ALL);
