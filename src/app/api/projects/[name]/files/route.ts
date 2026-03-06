import { withTracing } from "@/lib/logging";
import { createFilesRouteHandlers } from "@/lib/files-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createFilesRouteHandlers();

/** GET /api/projects/[name]/files — list all project files */
export const GET = withTracing(handlers.GET);
