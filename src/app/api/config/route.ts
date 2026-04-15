import { createConfigRouteHandlers } from "@/lib/config-route-handlers";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

const handlers = createConfigRouteHandlers();

/** GET /api/config — returns full merged config + raw explicit values */
export const GET = withTracing(handlers.GET);

/** PUT /api/config — update explicit config values */
export const PUT = withTracing(handlers.PUT);
