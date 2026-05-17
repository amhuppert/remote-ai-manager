import { withTracing } from "@/lib/logging";
import { createDevServerRouteHandlers } from "@/lib/dev-server-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createDevServerRouteHandlers();

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/start */
export const POST = withTracing(handlers.START);
