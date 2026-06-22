import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTracing } from "@/lib/logging";
import {
  hasPlannerDraftSubmission,
  submitPlannerDraft,
} from "@/lib/mcp-gateway/planner-draft-registry";
import { registerPlannerDraftTools } from "@/lib/mcp-gateway/planner-draft-server";
import {
  McpRouteError,
  createMcpRouteHandlers,
} from "@/lib/mcp-gateway/route-handler";
import { createWorkflowDefinitionRouteHandlers } from "@/lib/workflows/definition-route-handlers";
import { createWorkflowGenerateRouteHandlers } from "@/lib/workflows/generate-route-handlers";
import { createTemplateLibraryRouteHandlers } from "@/lib/workflow-graph/template-library-route-handlers";

const definitionHandlers = createWorkflowDefinitionRouteHandlers();
const generateHandlers = createWorkflowGenerateRouteHandlers();
const templateLibraryHandlers = createTemplateLibraryRouteHandlers();

export const listWorkflowDefinitions = withTracing(async (request, context) =>
  definitionHandlers.LIST(request, context),
);

export const createWorkflowDefinition = withTracing(async (request, context) =>
  definitionHandlers.CREATE(request, context),
);

export const getWorkflowDefinition = withTracing(async (request, context) =>
  definitionHandlers.GET(request, context),
);

export const updateWorkflowDefinition = withTracing(async (request, context) =>
  definitionHandlers.UPDATE(request, context),
);

export const deleteWorkflowDefinition = withTracing(async (request, context) =>
  definitionHandlers.DELETE(request, context),
);

export const generateWorkflowDraft = withTracing(async (request, context) =>
  generateHandlers.POST(request, context),
);

export const listProjectTemplates = withTracing(async (request, context) =>
  templateLibraryHandlers.LIST_TEMPLATES(request, context),
);

export const createGlobalTemplate = withTracing(async (request, context) =>
  templateLibraryHandlers.CREATE(request, context),
);

export const getGlobalTemplate = withTracing(async (request, context) =>
  templateLibraryHandlers.GET(request, context),
);

export const updateGlobalTemplate = withTracing(async (request, context) =>
  templateLibraryHandlers.UPDATE(request, context),
);

export const deleteGlobalTemplate = withTracing(async (request, context) =>
  templateLibraryHandlers.DELETE(request, context),
);

const draftMcpHandlers = createMcpRouteHandlers(async (_request, params) => {
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
});

export const draftMcpGet = draftMcpHandlers.GET;
export const draftMcpPost = draftMcpHandlers.POST;
export const draftMcpDelete = draftMcpHandlers.DELETE;
