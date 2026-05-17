import { withTracing } from "@/lib/logging";
import { createSessionFilesRouteHandlers } from "@/lib/files-session-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createSessionFilesRouteHandlers();

/** GET /api/projects/[name]/sessions/[session]/files — list files in the session worktree */
export const GET = withTracing(handlers.GET);
