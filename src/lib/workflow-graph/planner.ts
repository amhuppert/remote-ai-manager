import path from "node:path";
import type {
  WorkflowDefinitionRecord,
  WorkflowGeneratedDraft,
  WorkflowPlanRequest,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import {
  workflowGeneratedDraftSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";
import { buildWorkflowDraftPortableMcp as defaultBuildWorkflowDraftPortableMcp } from "@/lib/workflows/workflow-draft/portable-config";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import {
  consumePlannerDraft as defaultConsumePlannerDraft,
  createPlannerDraftSubmission as defaultCreatePlannerDraftSubmission,
  deletePlannerDraft as defaultDeletePlannerDraft,
} from "@/lib/workflows/workflow-draft/registry";
import { executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { generateWorkflowLayout } from "./layout";
import { createWorkflowStorageService } from "./storage";
import { validateWorkflowDefinition } from "./validation";

const logger = createLogger("graph-workflow-planner");

// The empty fallback definition the planner returns when it cannot run (missing
// session binding or no submitted draft) still has to satisfy the now-required
// charter on the semantic-definition schema. A submitted draft carries the
// planner-authored charter; this placeholder only governs the degenerate
// no-output path. Charter-rejection semantics for the planner are owned by a
// later task.
const PLACEHOLDER_PLANNER_CHARTER: WorkflowCharter = {
  mission: "Placeholder charter for an empty planner result",
  sourcesOfTruth: [
    {
      rank: 1,
      id: "objective",
      label: "Workflow objective",
      type: "document",
      locator: "objective",
      description: "The stated objective for this workflow",
    },
  ],
};

/**
 * Input enrichments the planner runner needs that aren't part of the public
 * `WorkflowPlanRequest` shape. `sessionName` and `conversationId` bind the
 * planner turn to the reserved `__planner__` session (see `ensurePlannerSession`).
 */
export type PlannerRunnerInput = WorkflowPlanRequest & {
  projectPath?: string;
  sessionName?: string;
  conversationId?: string;
};

export interface WorkflowPlannerDeps {
  loadSeedDefinition(
    seedDefinitionId: string,
    projectPath?: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  runPlannerQuery(
    input: PlannerRunnerInput,
    seedDefinition: WorkflowDefinitionRecord | null,
  ): Promise<WorkflowSemanticDefinition>;
}

export interface DefaultPlannerRunnerDeps {
  executeWorkflowTaskRun?: (
    input: ExecuteWorkflowTaskRunInput,
  ) => Promise<TaskRunResult>;
  createPlannerDraftSubmission?: () => { draftId: string };
  consumePlannerDraft?: (draftId: string) => WorkflowSemanticDefinition | null;
  deletePlannerDraft?: (draftId: string) => void;
  buildWorkflowDraftPortableMcp?: (
    projectName: string,
    draftId: string,
  ) => PortableMcpConfig;
}

const defaultStorage = createWorkflowStorageService();

export function createDefaultPlannerRunner(
  deps: DefaultPlannerRunnerDeps = {},
): WorkflowPlannerDeps["runPlannerQuery"] {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  const createPlannerDraftSubmission =
    deps.createPlannerDraftSubmission ?? defaultCreatePlannerDraftSubmission;
  const consumePlannerDraft =
    deps.consumePlannerDraft ?? defaultConsumePlannerDraft;
  const deletePlannerDraft =
    deps.deletePlannerDraft ?? defaultDeletePlannerDraft;
  const buildWorkflowDraftPortableMcp =
    deps.buildWorkflowDraftPortableMcp ?? defaultBuildWorkflowDraftPortableMcp;

  return async function runPlannerQuery(
    input: PlannerRunnerInput,
    seedDefinition: WorkflowDefinitionRecord | null,
  ): Promise<WorkflowSemanticDefinition> {
    const emptyDefinition: WorkflowSemanticDefinition = {
      schemaVersion: 1,
      workflowConfig: {},
      charter: PLACEHOLDER_PLANNER_CHARTER,
      parameters: [],
      prerequisites: [],
      executionContexts: [],
      tasks: [],
      edges: [],
    };

    if (!input.projectPath || !input.sessionName || !input.conversationId) {
      logger.error("planner.missing_session_binding", {
        hasProjectPath: Boolean(input.projectPath),
        hasSessionName: Boolean(input.sessionName),
        hasConversationId: Boolean(input.conversationId),
      });
      return emptyDefinition;
    }

    const { draftId } = createPlannerDraftSubmission();

    const systemInstructions = [
      "Generate a workflow graph draft with execution contexts, flat task records, and dependency edges.",
      "Execution contexts should represent real dependency boundaries, not every small task.",
      "Use explicit stable IDs for contexts, tasks, and edges.",
      "Tasks must belong to exactly one execution context and use flat records keyed by contextId.",
      "Do not include layout coordinates.",
    ].join("\n");

    const promptSections = [`Objective:\n${input.objective}`];

    if (input.references.length > 0) {
      promptSections.push(
        `References:\n${input.references
          .map(
            (reference) => `- ${reference.filePath}: ${reference.description}`,
          )
          .join("\n")}`,
      );
    }

    if (seedDefinition) {
      promptSections.push(
        `Seed workflow:\n${JSON.stringify(seedDefinition.definition, null, 2)}`,
      );
    }

    logger.info("planner.task_run_start", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    });

    try {
      const portableMcp = buildWorkflowDraftPortableMcp(
        path.basename(input.projectPath),
        draftId,
      );

      // Intentionally free-form: NO `outputFormat`. The planner submits its
      // workflow draft via an out-of-band MCP tool that writes into the
      // `planner-draft-registry`; the runner consumes the registry after the
      // call returns. The agent's response text is not the contract — the
      // registered draft is — so SDK structured output would constrain the
      // wrong channel.
      const taskRunInput: ExecuteWorkflowTaskRunInput = {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        kind: "task_run",
        prompt: promptSections.join("\n\n"),
        systemInstructions,
        timeoutMs: 600_000,
        tooling: portableMcp,
        origin: { source: "workflow" },
      };

      const result = await executeWorkflowTaskRun(taskRunInput);

      if (result.kind === "error") {
        logger.error("planner.task_run_failed", {
          error: result.error,
          aborted: result.aborted,
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
  };
}

const defaultDeps: WorkflowPlannerDeps = {
  loadSeedDefinition: async (
    seedDefinitionId: string,
    projectPath?: string,
  ) => {
    if (!projectPath) {
      return null;
    }

    return defaultStorage.get(
      { kind: "project", projectPath },
      seedDefinitionId,
    );
  },
  runPlannerQuery: createDefaultPlannerRunner(),
};

export function createWorkflowPlannerService(
  deps: Partial<WorkflowPlannerDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  async function generateDraft(
    input: PlannerRunnerInput,
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
