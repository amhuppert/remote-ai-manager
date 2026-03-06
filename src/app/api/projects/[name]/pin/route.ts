import { createPinRouteHandlers } from "@/lib/pin-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createPinRouteHandlers();

/** POST /api/projects/[name]/pin — pin or unpin a project */
export const POST = handlers.POST;
