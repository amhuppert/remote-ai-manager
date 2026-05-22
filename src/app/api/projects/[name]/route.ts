import { createProjectRouteHandlers } from "@/lib/project-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createProjectRouteHandlers();

/** DELETE /api/projects/[name]?projectPath=<path> — delete a project and purge all state */
export const DELETE = handlers.DELETE;
