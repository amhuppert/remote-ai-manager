import { withTracing } from "@/lib/logging";
import { createProjectsRouteHandlers } from "@/lib/projects-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createProjectsRouteHandlers();

/** GET /api/projects — list all discovered projects */
export const GET = withTracing(handlers.GET);
