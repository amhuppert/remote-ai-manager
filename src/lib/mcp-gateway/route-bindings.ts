import { createMcpRouteHandlers } from "./route-handler";
import { createSessionMcpServer } from "./session-server";
import { createWorkflowExecutionMcpServer } from "./workflow-execution-server";

const conversationHandlers = createMcpRouteHandlers(
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

const workflowExecutionHandlers = createMcpRouteHandlers(
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

export const conversationMcpGET = conversationHandlers.GET;
export const conversationMcpPOST = conversationHandlers.POST;
export const conversationMcpDELETE = conversationHandlers.DELETE;

export const workflowExecutionMcpGET = workflowExecutionHandlers.GET;
export const workflowExecutionMcpPOST = workflowExecutionHandlers.POST;
export const workflowExecutionMcpDELETE = workflowExecutionHandlers.DELETE;
