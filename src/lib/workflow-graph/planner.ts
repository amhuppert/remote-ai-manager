import path from "node:path";
import type {
  WorkflowDefinitionRecord,
  WorkflowGeneratedDraft,
  WorkflowPlanRequest,
  WorkflowSemanticDefinition,
} from "@/types";
import { readConfig } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  workflowGeneratedDraftSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/schemas";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import { buildWorkflowDraftPortableMcp } from "@/lib/mcp-gateway/portable-config";
import {
  consumePlannerDraft,
  createPlannerDraftSubmission,
  deletePlannerDraft,
} from "@/lib/mcp-gateway/planner-draft-registry";
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
  const emptyDefinition: WorkflowSemanticDefinition = {
    schemaVersion: 1,
    workflowConfig: {},
    executionContexts: [],
    tasks: [],
    edges: [],
  };
  const { draftId } = createPlannerDraftSubmission();

  const systemInstructions = [
    "Generate a workflow graph draft with execution contexts, flat task records, and dependency edges.",
    "Execution contexts should represent real dependency boundaries, not every small task.",
    "Use explicit stable IDs for contexts, tasks, and edges.",
    "Tasks must belong to exactly one execution context and use flat records keyed by contextId.",
    "Do not include layout coordinates.",
  ];

  const promptSections = [`Objective:\n${input.objective}`];

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

  const runner = getTaskRunner("claude");

  logger.info("planner.task_runner_start", {
    projectPath: input.projectPath,
  });

  try {
    const result = await runner.run({
      workingDirectory: input.projectPath ?? process.cwd(),
      prompt: promptSections.join("\n\n"),
      systemInstructions,
      autonomous: true,
      timeoutMs: 600_000,
      tooling: {
        portableMcp: input.projectPath
          ? buildWorkflowDraftPortableMcp(
              path.basename(input.projectPath),
              draftId,
            )
          : undefined,
      },
    });

    if (result.error) {
      logger.error("planner.task_runner_failed", {
        error: result.error,
        timedOut: result.timedOut,
      });
    }
  } catch (error) {
    logger.error("planner.query_failed", {
      error: getErrorMessage(error),
    });
  } finally {
    const submittedDraft = consumePlannerDraft(draftId);
    deletePlannerDraft(draftId);
    if (submittedDraft) {
      return workflowSemanticDefinitionSchema.parse(submittedDraft);
    }
  }

  return emptyDefinition;
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
