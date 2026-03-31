import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  WorkflowDefinitionRecord,
  WorkflowGeneratedDraft,
  WorkflowPlanRequest,
  WorkflowSemanticDefinition,
} from "@/types";
import { buildChildEnv } from "@/lib/child-env";
import { readConfig } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  workflowGeneratedDraftSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/schemas";
import { generateWorkflowLayout } from "./layout";
import { createWorkflowStorageService } from "./storage";
import { validateWorkflowDefinition } from "./validation";

const logger = createLogger("graph-workflow-planner");

export interface WorkflowPlannerDeps {
  loadSeedDefinition(
    seedDefinitionId: string,
    projectPath?: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  runPlannerQuery(
    input: WorkflowPlanRequest & { projectPath?: string },
    seedDefinition: WorkflowDefinitionRecord | null,
  ): Promise<WorkflowSemanticDefinition>;
}

const defaultStorage = createWorkflowStorageService({ readConfig });

async function defaultRunPlannerQuery(
  input: WorkflowPlanRequest & { projectPath?: string },
  seedDefinition: WorkflowDefinitionRecord | null,
): Promise<WorkflowSemanticDefinition> {
  let generatedDefinition: WorkflowSemanticDefinition = {
    schemaVersion: 1,
    executionContexts: [],
    tasks: [],
    edges: [],
  };

  const plannerToolServer = createSdkMcpServer({
    name: "graph-workflow-planner",
    version: "1.0.0",
    tools: [
      tool(
        "submit_workflow_draft",
        "Submit the generated workflow draft exactly once with explicit IDs for contexts, tasks, and edges.",
        {
          schemaVersion: z.number().int().positive(),
          executionContexts: z.array(
            workflowSemanticDefinitionSchema.shape.executionContexts.unwrap()
              .element,
          ),
          tasks: z.array(
            workflowSemanticDefinitionSchema.shape.tasks.unwrap().element,
          ),
          edges: z.array(
            workflowSemanticDefinitionSchema.shape.edges.unwrap().element,
          ),
        },
        async (args) => {
          generatedDefinition = workflowSemanticDefinitionSchema.parse(args);
          return {
            content: [
              {
                type: "text" as const,
                text: `Workflow draft submitted with ${generatedDefinition.executionContexts.length} execution contexts.`,
              },
            ],
          };
        },
      ),
    ],
  });

  const promptSections = [
    "Generate a workflow graph draft with execution contexts, flat task records, and dependency edges.",
    "Execution contexts should represent real dependency boundaries, not every small task.",
    "Use explicit stable IDs for contexts, tasks, and edges.",
    "Tasks must belong to exactly one execution context and use flat records keyed by contextId.",
    "Do not include layout coordinates.",
    `Objective:\n${input.objective}`,
  ];

  if (input.references.length > 0) {
    promptSections.push(
      `References:\n${input.references
        .map((reference) => `- ${reference.filePath}: ${reference.description}`)
        .join("\n")}`,
    );
  }

  if (seedDefinition) {
    promptSections.push(
      `Seed workflow:\n${JSON.stringify(seedDefinition.definition, null, 2)}`,
    );
  }

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 600_000);

  try {
    const stream = query({
      prompt: promptSections.join("\n\n"),
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: input.projectPath ?? process.cwd(),
        persistSession: false,
        abortController,
        env: { ...buildChildEnv(), CLAUDECODE: "" },
        mcpServers: {
          "graph-workflow-planner": plannerToolServer,
        },
        canUseTool: async (toolName: string) => {
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message: "Workflow draft generation must complete autonomously.",
            };
          }

          return { behavior: "allow" as const, updatedInput: {} };
        },
      },
    });

    for await (const message of stream) {
      void message;
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      logger.error("planner.query_failed", {
        error: getErrorMessage(error),
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  return generatedDefinition;
}

const defaultDeps: WorkflowPlannerDeps = {
  loadSeedDefinition: async (
    seedDefinitionId: string,
    projectPath?: string,
  ) => {
    if (!projectPath) {
      return null;
    }

    return defaultStorage.get(projectPath, seedDefinitionId);
  },
  runPlannerQuery: defaultRunPlannerQuery,
};

export function createWorkflowPlannerService(
  deps: Partial<WorkflowPlannerDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  async function generateDraft(
    input: WorkflowPlanRequest & { projectPath?: string },
  ): Promise<WorkflowGeneratedDraft> {
    const seedDefinition = input.seedDefinitionId
      ? await (input.projectPath
          ? resolvedDeps.loadSeedDefinition(
              input.seedDefinitionId,
              input.projectPath,
            )
          : resolvedDeps.loadSeedDefinition(input.seedDefinitionId))
      : null;

    const definition = workflowSemanticDefinitionSchema.parse(
      await resolvedDeps.runPlannerQuery(input, seedDefinition),
    );
    const validation = validateWorkflowDefinition(definition);
    const layout = generateWorkflowLayout(definition);

    return workflowGeneratedDraftSchema.parse({
      definition,
      layout,
      validationErrors: validation.errors,
    });
  }

  return { generateDraft };
}
