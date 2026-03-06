import { createArchiveRouteHandlers } from "@/lib/archive-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createArchiveRouteHandlers();

/** POST /api/projects/[name]/archive — archive or unarchive a project */
export const POST = handlers.POST;
