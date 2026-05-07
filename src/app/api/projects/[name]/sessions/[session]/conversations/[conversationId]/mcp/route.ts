import { createMcpRouteHandlers } from "@/lib/mcp-gateway/route-handler";
import { createSessionMcpServer } from "@/lib/mcp-gateway/session-server";

export const { GET, POST, DELETE } = createMcpRouteHandlers(
  async (_request, params) => {
    if (!params.name || !params.session || !params.conversationId) {
      throw new Error("Missing MCP route params");
    }

    return createSessionMcpServer({
      name: params.name,
      session: params.session,
      conversationId: params.conversationId,
    });
  },
);
