import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import type { MissingPrerequisite } from "@/lib/workflow-graph/preflight-prerequisite-service";
import {
  WorkflowDefinitionNotFoundError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
} from "@/lib/workflow-graph/workflow-manager";

const logger = createLogger("graph-workflow-start-tool");

const startGraphWorkflowSchema = z.object({
  definitionId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The ID of the saved workflow definition to launch (from list_templates or list_graph_workflows).",
    ),
  tier: z
    .enum(["project", "global"])
    .default("project")
    .describe(
      "Which tier to launch from: 'project' (this project's library) or 'global' (the cross-project library). Defaults to project.",
    ),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional launch input values keyed by declared parameter name. Omit for a zero-input (static) workflow.",
    ),
});

const START_GRAPH_WORKFLOW_DESCRIPTION = `Launch a saved graph workflow definition for this session, optionally supplying parameter values. This is a one-shot start: it routes through the same start path as a human launch, applying identical guards (no active execution, no uncommitted changes), the same input validation and substitution, then runs the workflow. There is no way to fill or change parameters after the run has started.`;

export interface StartGraphWorkflowToolContext {
  projectPath: string;
  sessionName: string;
  projectName?: string;
}

export interface StartGraphWorkflowToolDeps {
  startWorkflow(input: {
    projectPath: string;
    sessionName: string;
    projectName?: string;
    definitionId: string;
    tier: "project" | "global";
    parameters?: Record<string, unknown>;
  }): Promise<GraphWorkflowExecution>;
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

/**
 * The shared start path throws a plain `Error` (not a typed class) when the
 * definition is absent, so detect it by the same message shape the HTTP handler
 * maps to a 404. Keeping the two surfaces' not-found detection identical is what
 * makes an agent launch reject exactly like a human launch (R8.4). The typed
 * `WorkflowDefinitionNotFoundError` is preferred (it carries the tier); this
 * fallback covers a plain not-found Error from any remaining message-only path.
 */
function isDefinitionNotFound(message: string): boolean {
  return (
    message.startsWith('Workflow definition "') &&
    message.endsWith('" was not found')
  );
}

// Render one prerequisite miss as a compact, agent-parseable line. A path miss
// shows its path; a skill miss shows the reference and the backend it failed on
// (or "any backend" for a backend-unscoped skill); both carry the reason so the
// agent can tell a definitive absence from an unevaluable probe (R8.3).
function describeMissingPrerequisite(missing: MissingPrerequisite): string {
  if (missing.kind === "path") {
    return `[path] ${missing.path} (${missing.reason})`;
  }
  const backend = missing.backend ?? "any backend";
  return `[skill] ${missing.skill} on ${backend} (${missing.reason})`;
}

/**
 * Build the structured prerequisites-unmet tool result. Mirrors the HTTP
 * surface's itemized `prerequisites_unmet` payload (R8.3): a stable
 * `prerequisites_unmet:` prefix, a human-readable per-item summary, and the full
 * `missing` list as JSON so the agent can recover every field (kind, scoped
 * backend, reason) without parsing prose.
 */
function prerequisitesUnmetResult(
  error: WorkflowPrerequisitesUnmetError,
): ReturnType<typeof errorResult> {
  const items = error.missing.map(describeMissingPrerequisite).join("; ");
  return errorResult(
    `prerequisites_unmet: ${error.missing.length} missing — ${items}\n${JSON.stringify(
      error.missing,
    )}`,
  );
}

/**
 * Map a thrown launch rejection to a structured tool error carrying the SAME
 * rejection reason the HTTP surface returns (R8.2/R8.3). Stable prefixes let the
 * agent branch on the failure class without parsing prose.
 */
function mapStartError(error: unknown): ReturnType<typeof errorResult> | null {
  if (error instanceof WorkflowStartInputError) {
    const { kind, name } = error.inputError;
    return errorResult(
      `input_invalid: parameter "${name}" rejected (${kind}): ${error.message}`,
    );
  }
  if (error instanceof WorkflowStartGuardError) {
    if (error.guard === "uncommitted_changes") {
      return errorResult(`uncommitted_changes: ${error.message}`);
    }
    return errorResult(`conflict: ${error.message}`);
  }
  if (error instanceof WorkflowPrerequisitesUnmetError) {
    return prerequisitesUnmetResult(error);
  }
  if (error instanceof WorkflowDefinitionNotFoundError) {
    return errorResult(
      `not_found: definition "${error.definitionId}" not found in the ${error.tier} tier`,
    );
  }
  if (error instanceof Error && isDefinitionNotFound(error.message)) {
    return errorResult(`not_found: ${error.message}`);
  }
  return null;
}

export function registerStartGraphWorkflowTool(
  server: McpServer,
  context: StartGraphWorkflowToolContext,
  deps: StartGraphWorkflowToolDeps,
): void {
  server.registerTool(
    "start_graph_workflow",
    {
      description: START_GRAPH_WORKFLOW_DESCRIPTION,
      inputSchema: startGraphWorkflowSchema.shape,
    },
    async (args: unknown) => {
      const parsed = startGraphWorkflowSchema.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
        );
      }

      const { definitionId, tier, parameters } = parsed.data;

      try {
        const execution = await deps.startWorkflow({
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          ...(context.projectName !== undefined
            ? { projectName: context.projectName }
            : {}),
          definitionId,
          tier,
          ...(parameters !== undefined ? { parameters } : {}),
        });
        logger.info("graph-workflow.start_tool.launched", {
          sessionName: context.sessionName,
          executionId: execution.id,
        });
        return textResult(
          `Workflow execution started (id: ${execution.id}, definition: ${definitionId}). The run is now executing; monitor it with get_graph_workflow_status.`,
        );
      } catch (error) {
        const mapped = mapStartError(error);
        if (mapped) {
          logger.info("graph-workflow.start_tool.rejected", {
            sessionName: context.sessionName,
            definitionId,
            tier,
            ...(error instanceof WorkflowPrerequisitesUnmetError
              ? { prerequisitesUnmetCount: error.missing.length }
              : {}),
          });
          return mapped;
        }
        logger.error("graph-workflow.start_tool.failed", {
          sessionName: context.sessionName,
          definitionId,
          tier,
        });
        return errorResult(
          `Failed to start workflow: ${getErrorMessage(error)}`,
        );
      }
    },
  );
}
