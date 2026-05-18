import { withTracing } from "@/lib/logging";
import { broadcast } from "@/lib/sse-broadcaster";
import { defaultCapabilityRouteDeps } from "@/lib/agent-capabilities/route-defaults";
import { createGlobalCapabilityHandlers } from "@/lib/agent-capabilities/route-handlers";

export const dynamic = "force-dynamic";

const handlers = createGlobalCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

export const GET = withTracing(handlers.GET);
export const PATCH = withTracing(handlers.PATCH);
export const POST = withTracing(handlers.POST);
