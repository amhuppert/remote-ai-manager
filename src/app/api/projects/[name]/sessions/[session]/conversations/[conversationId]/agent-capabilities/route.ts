import { withTracing } from "@/lib/logging";
import { broadcast } from "@/lib/sse-broadcaster";
import { defaultCapabilityRouteDeps } from "@/lib/agent-capabilities/route-defaults";
import { createConversationCapabilityHandlers } from "@/lib/agent-capabilities/route-handlers";

export const dynamic = "force-dynamic";

const handlers = createConversationCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

export const GET = withTracing(handlers.GET);
export const PATCH = withTracing(handlers.PATCH);
export const POST = withTracing(handlers.POST);
