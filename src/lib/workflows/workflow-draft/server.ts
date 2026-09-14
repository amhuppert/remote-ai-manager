import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { createLogger } from "@/lib/logging";

const logger = createLogger("mcp-workflow-draft");

export interface PlannerDraftToolContext {
  draftId: string;
}

export interface PlannerDraftToolDeps {
  submitPlannerDraft(
    draftId: string,
    definition: typeof workflowSemanticDefinitionSchema._output,
  ): void;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function textResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

export function registerPlannerDraftTools(
  server: McpServer,
  context: PlannerDraftToolContext,
  deps: PlannerDraftToolDeps,
): void {
  server.registerTool(
    "submit_workflow_draft",
    {
      description:
        "Submit the generated workflow draft exactly once with explicit IDs for contexts, tasks, and edges.",
      inputSchema: workflowSemanticDefinitionSchema.shape,
    },
    async (args) => {
      const parsed = workflowSemanticDefinitionSchema.safeParse(args);
      if (!parsed.success) {
        logger.warn("tool.submit_workflow_draft.invalid", {
          draftId: context.draftId,
          issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
        });
        return errorResult(`Validation error: ${parsed.error.message}`);
      }

      deps.submitPlannerDraft(context.draftId, parsed.data);
      logger.info("tool.submit_workflow_draft", {
        draftId: context.draftId,
        executionContextCount: parsed.data.executionContexts.length,
      });
      return textResult(
        `Workflow draft submitted with ${parsed.data.executionContexts.length} execution contexts.`,
      );
    },
  );
}
