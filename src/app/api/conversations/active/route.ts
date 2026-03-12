import { createActiveConversationsRouteHandlers } from "@/lib/active-conversations-route-handlers";

export const dynamic = "force-dynamic";

const { GET } = createActiveConversationsRouteHandlers();
export { GET };
