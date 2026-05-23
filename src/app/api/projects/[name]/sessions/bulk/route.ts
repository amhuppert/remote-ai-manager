import { createBulkSessionsRouteHandlers } from "@/lib/bulk-sessions-route-handlers";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

const { POST: postHandler } = createBulkSessionsRouteHandlers();

/** POST /api/projects/[name]/sessions/bulk — apply archive|unarchive|delete to many sessions */
export const POST = withTracing(postHandler);
