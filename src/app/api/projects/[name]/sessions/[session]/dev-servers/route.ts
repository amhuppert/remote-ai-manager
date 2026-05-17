import { withTracing } from "@/lib/logging";
import { createDevServerRouteHandlers } from "@/lib/dev-server-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createDevServerRouteHandlers();

/** GET /api/projects/[name]/sessions/[session]/dev-servers — get dev server status */
export const GET = withTracing(handlers.GET);
