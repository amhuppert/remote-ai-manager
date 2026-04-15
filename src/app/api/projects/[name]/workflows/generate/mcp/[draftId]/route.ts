import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlannerDraftTools } from "@/lib/mcp-gateway/planner-draft-server";
import {
  hasPlannerDraftSubmission,
  submitPlannerDraft,
} from "@/lib/mcp-gateway/planner-draft-registry";
import {
  McpRouteError,
  createMcpRouteHandlers,
} from "@/lib/mcp-gateway/route-handler";

export const { GET, POST, DELETE } = createMcpRouteHandlers(
  async (_request, params) => {
    if (!params.draftId) {
      throw new Error("Missing workflow draft route params");
    }

    if (!hasPlannerDraftSubmission(params.draftId)) {
      throw new McpRouteError(404, "Workflow draft submission not found");
    }

    const server = new McpServer({
      name: "cc-workflow-draft",
      version: "1.0.0",
    });
    registerPlannerDraftTools(
      server,
      { draftId: params.draftId },
      { submitPlannerDraft },
    );
    return server;
  },
);
