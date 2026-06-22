import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { TemplateLibraryItem } from "@/lib/workflow-graph/template-library-service";

const logger = createLogger("graph-workflow-list-templates-tool");

const LIST_TEMPLATES_DESCRIPTION = `List saved graph-workflow templates across both tiers — the cross-project 'global' library and this project's 'project' library. Each item is tagged with its tier and carries its identifier, name, declared parameters, and declared prerequisites, so you can pick a template and assemble a prerequisite-aware launch (pass the item's id and tier to start_graph_workflow). Listing is read-only and starts nothing.`;

export interface ListTemplatesToolContext {
  projectPath: string;
  sessionName: string;
}

export interface ListTemplatesToolDeps {
  listTemplates(projectPath: string): Promise<TemplateLibraryItem[]>;
}

function textResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerListTemplatesTool(
  server: McpServer,
  context: ListTemplatesToolContext,
  deps: ListTemplatesToolDeps,
): void {
  server.registerTool(
    "list_templates",
    {
      description: LIST_TEMPLATES_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      try {
        const items = await deps.listTemplates(context.projectPath);
        logger.debug("graph-workflow.list_templates", {
          sessionName: context.sessionName,
          count: items.length,
        });
        // Emit the tier-tagged items as a JSON array so the agent can read each
        // item's tier, id, name, parameters, and prerequisites structurally.
        return textResult(JSON.stringify(items, null, 2));
      } catch (error) {
        logger.error("graph-workflow.list_templates.failed", {
          sessionName: context.sessionName,
        });
        return errorResult(
          `Failed to list templates: ${getErrorMessage(error)}`,
        );
      }
    },
  );
}
