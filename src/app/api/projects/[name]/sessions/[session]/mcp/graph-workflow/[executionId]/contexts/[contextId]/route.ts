import { createMcpRouteHandlers } from "@/lib/mcp-gateway/route-handler";
import { createWorkflowExecutionMcpServer } from "@/lib/mcp-gateway/workflow-execution-server";

export const { GET, POST, DELETE } = createMcpRouteHandlers(
  async (_request, params) => {
    if (
      !params.name ||
      !params.session ||
      !params.executionId ||
      !params.contextId
    ) {
      throw new Error("Missing graph workflow MCP route params");
    }

    return createWorkflowExecutionMcpServer({
      name: params.name,
      session: params.session,
      executionId: params.executionId,
      contextId: params.contextId,
    });
  },
);
