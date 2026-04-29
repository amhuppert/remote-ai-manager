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
import { getTaskRunner as defaultGetTaskRunner } from "@/lib/agent-backends/registry";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import { buildWorkflowDraftPortableMcp as defaultBuildWorkflowDraftPortableMcp } from "@/lib/mcp-gateway/portable-config";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import {
  consumePlannerDraft as defaultConsumePlannerDraft,
  createPlannerDraftSubmission as defaultCreatePlannerDraftSubmission,
  deletePlannerDraft as defaultDeletePlannerDraft,
} from "@/lib/mcp-gateway/planner-draft-registry";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
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

export interface DefaultPlannerRunnerDeps {
  getTaskRunner?(backend: "claude"): AgentTaskRunner;
  executeAgentCall?: (
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ) => Promise<AgentCallResult>;
  createPlannerDraftSubmission?: () => { draftId: string };
  consumePlannerDraft?: (draftId: string) => WorkflowSemanticDefinition | null;
  deletePlannerDraft?: (draftId: string) => void;
  buildWorkflowDraftPortableMcp?: (
    projectName: string,
    draftId: string,
  ) => PortableMcpConfig;
}

const defaultStorage = createWorkflowStorageService({ readConfig });

export function createDefaultPlannerRunner(
  deps: DefaultPlannerRunnerDeps = {},
): WorkflowPlannerDeps["runPlannerQuery"] {
  const getTaskRunner = deps.getTaskRunner ?? defaultGetTaskRunner;
  const executeAgentCall = deps.executeAgentCall ?? defaultExecuteAgentCall;
  const createPlannerDraftSubmission =
    deps.createPlannerDraftSubmission ?? defaultCreatePlannerDraftSubmission;
  const consumePlannerDraft =
    deps.consumePlannerDraft ?? defaultConsumePlannerDraft;
  const deletePlannerDraft =
    deps.deletePlannerDraft ?? defaultDeletePlannerDraft;
  const buildWorkflowDraftPortableMcp =
    deps.buildWorkflowDraftPortableMcp ?? defaultBuildWorkflowDraftPortableMcp;

  return async function runPlannerQuery(
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

    const runner = getTaskRunner("claude");

    logger.info("planner.task_runner_start", {
      projectPath: input.projectPath,
    });

    try {
      const portableMcp = input.projectPath
        ? buildWorkflowDraftPortableMcp(
            path.basename(input.projectPath),
            draftId,
          )
        : undefined;

      // Intentionally free-form: no `outputSchema`. The planner submits its
      // workflow draft via an out-of-band MCP tool that writes into the
      // `planner-draft-registry`; the runner consumes the registry after the
      // call returns. The agent's response text is not the contract — the
      // registered draft is — so SDK structured output would constrain the
      // wrong channel.
      const request: AgentCallRequest = {
        kind: "task_run",
        backend: "claude",
        prompt: promptSections.join("\n\n"),
        systemInstructions,
        writeCapability: "write_capable",
        timeoutMs: 600_000,
        ...(portableMcp ? { tooling: portableMcp } : {}),
      };

      const callResult = await executeAgentCall(request, {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: capabilityViewForBackend("claude"),
          workingDirectory: input.projectPath ?? process.cwd(),
          autonomous: true,
          defaultTimeoutMs: 600_000,
        }),
      });

      if (callResult.outcome.kind === "failed") {
        logger.error("planner.task_runner_failed", {
          error: callResult.outcome.error.message,
          failureKind: callResult.outcome.error.failureKind,
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

    return defaultStorage.get(projectPath, seedDefinitionId);
  },
  runPlannerQuery: createDefaultPlannerRunner(),
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
