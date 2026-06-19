import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { GlobalConfig } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import {
  contextValidatorOverrideSchema,
  graphWorkflowAgentConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "@/lib/workflows/schemas";
import {
  workflowConfigOverrideSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflows/schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { computeCharterHash } from "./charter/render";
import { getExecutionLogger } from "./execution-logger";
import { generateWorkflowLayout } from "./layout";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
} from "./storage";

const executionContextInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Unique kebab-case identifier for this context (e.g. 'auth-setup'). Referenced by tasks and edges.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .describe("Display name for this context (e.g. 'Authentication Setup')."),
  description: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional short summary of the context's intent, shown in the workflow UI.",
    ),
  acceptanceCriteria: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Required. The context-level done statement shared by the implementer and validator. Follow the graph-workflow-planning skill for acceptance criteria rules.",
    ),
  implementer: graphWorkflowAgentConfigSchema
    .optional()
    .describe(
      "Optional per-context override for implementer backend/model/reasoningEffort. Omit unless the user explicitly asked for non-default settings or this context has a justified need.",
    ),
  contextValidator: contextValidatorOverrideSchema
    .optional()
    .describe(
      "Optional per-context override for the agent validator. Omit unless the graph-workflow-planning skill's default-setting guidance says an override is needed.",
    ),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .optional()
    .describe(
      "Optional per-context script validator. Enable only when this context should leave the codebase fully valid after all of its tasks; follow graph-workflow-planning before setting it.",
    ),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema
    .optional()
    .describe(
      "Optional per-context human approval gate. When enabled, the context pauses for human review after all validators pass instead of completing. Omit to inherit the workflow-level setting (disabled by default); set only when the user asked for a review gate on this context.",
    ),
  mutability: graphWorkflowMutabilityPolicySchema
    .optional()
    .describe(
      "Optional per-context mutability override (e.g. allowAgentTaskAdd). Omit to inherit.",
    ),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema
    .optional()
    .describe(
      "Optional per-context circuit breaker override (consecutiveFailureThreshold). Omit to inherit.",
    ),
  iterationPolicy: graphWorkflowIterationPolicySchema
    .optional()
    .describe(
      "Optional per-context iteration policy override (maxIterations, continuity). Omit to inherit.",
    ),
});

const taskInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .describe("Unique kebab-case identifier (e.g. 'create-user-schema')."),
  contextId: z
    .string()
    .trim()
    .min(1)
    .describe("The id of the execution context this task belongs to."),
  title: z
    .string()
    .trim()
    .min(1)
    .describe("Short task name shown in the workflow UI."),
  instructions: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Self-contained instructions for the executing agent. Follow graph-workflow-planning for required context, contract, and verification details.",
    ),
});

const edgeInputSchema = z.object({
  sourceContextId: z
    .string()
    .trim()
    .min(1)
    .describe("The id of the upstream context that must complete first."),
  targetContextId: z
    .string()
    .trim()
    .min(1)
    .describe("The id of the downstream context that depends on the source."),
});

const createWorkflowSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("Human-readable workflow name (e.g. 'Add OAuth2 Support')."),
  description: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("What this workflow achieves. Shown in the workflow list."),
  workflowConfig: workflowConfigOverrideSchema
    .optional()
    .describe(
      "Optional workflow-level config overrides. Omit unless the user explicitly asked for non-default workflow-wide settings.",
    ),
  charter: workflowCharterSchema.describe(
    "Workflow-global charter declaring the source-of-truth precedence hierarchy and mission/conventions narrative shared by every implementer and validator.",
  ),
  executionContexts: z
    .array(executionContextInputSchema)
    .min(1)
    .describe(
      "Groups of related work that execute as independent agent sessions.",
    ),
  tasks: z
    .array(taskInputSchema)
    .min(1)
    .describe(
      "Atomic work items. Ordered per context by array position; no explicit order field needed.",
    ),
  edges: z
    .array(edgeInputSchema)
    .default([])
    .describe(
      "Dependency edges between execution contexts. Context at targetContextId waits for sourceContextId to complete.",
    ),
});

const replaceWorkflowSchema = z.object({
  workflowId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The ID of the workflow to replace (from list_graph_workflows or create_graph_workflow).",
    ),
  name: z.string().trim().min(1).describe("Human-readable workflow name."),
  description: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("What this workflow achieves."),
  workflowConfig: workflowConfigOverrideSchema
    .optional()
    .describe(
      "Optional workflow-level config overrides. Omit unless the user explicitly asked for non-default workflow-wide settings.",
    ),
  charter: workflowCharterSchema.describe(
    "Workflow-global charter declaring the source-of-truth precedence hierarchy and mission/conventions narrative shared by every implementer and validator.",
  ),
  executionContexts: z
    .array(executionContextInputSchema)
    .min(1)
    .describe(
      "Groups of related work that execute as independent agent sessions.",
    ),
  tasks: z
    .array(taskInputSchema)
    .min(1)
    .describe("Atomic work items. Ordered per context by array position."),
  edges: z
    .array(edgeInputSchema)
    .default([])
    .describe("Dependency edges between execution contexts."),
});

const workflowIdSchema = z.object({
  workflowId: z
    .string()
    .trim()
    .min(1)
    .describe("The ID of the workflow definition."),
});

type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

function inflateToSemanticDefinition(
  input: CreateWorkflowInput,
): WorkflowSemanticDefinition {
  const executionContexts = input.executionContexts.map((ctx) => ({
    id: ctx.id,
    title: ctx.title,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    acceptanceCriteria: ctx.acceptanceCriteria,
    ...(ctx.implementer !== undefined ? { implementer: ctx.implementer } : {}),
    ...(ctx.contextValidator !== undefined
      ? { contextValidator: ctx.contextValidator }
      : {}),
    ...(ctx.scriptValidator !== undefined
      ? { scriptValidator: ctx.scriptValidator }
      : {}),
    ...(ctx.humanApprovalGate !== undefined
      ? { humanApprovalGate: ctx.humanApprovalGate }
      : {}),
    ...(ctx.mutability !== undefined ? { mutability: ctx.mutability } : {}),
    ...(ctx.circuitBreaker !== undefined
      ? { circuitBreaker: ctx.circuitBreaker }
      : {}),
    ...(ctx.iterationPolicy !== undefined
      ? { iterationPolicy: ctx.iterationPolicy }
      : {}),
  }));

  const contextTaskCounters = new Map<string, number>();
  const tasks = input.tasks.map((task) => {
    const count = (contextTaskCounters.get(task.contextId) ?? 0) + 1;
    contextTaskCounters.set(task.contextId, count);
    return {
      id: task.id,
      contextId: task.contextId,
      order: count,
      title: task.title,
      instructions: task.instructions,
      source: "user" as const,
    };
  });

  const edges = input.edges.map((edge) => ({
    id: `edge-${randomUUID().slice(0, 8)}`,
    sourceContextId: edge.sourceContextId,
    targetContextId: edge.targetContextId,
  }));

  return workflowSemanticDefinitionSchema.parse({
    schemaVersion: 1,
    workflowConfig: input.workflowConfig ?? {},
    charter: input.charter,
    executionContexts,
    tasks,
    edges,
  });
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
 * Friendly charter precheck shared by the create and replace handlers. Run
 * before the generic schema parse so the two charter failure modes surface as
 * clear, distinct errors that name the offending entry rather than a raw Zod
 * dump:
 * - charter absent in the raw tool args -> `charter_missing` (2.2)
 * - charter present but invalid -> `charter_invalid` describing the first issue,
 *   including the duplicate-rank entry the schema's superRefine names (1.4)
 *
 * Returns an `errorResult` to short-circuit the handler, or `null` to proceed.
 */
function precheckCharter(args: unknown): ReturnType<typeof errorResult> | null {
  const rawCharter =
    args !== null && typeof args === "object" && "charter" in args
      ? (args as { charter: unknown }).charter
      : undefined;

  if (rawCharter === undefined || rawCharter === null) {
    return errorResult(
      "charter_missing: a workflow charter is required. Provide a charter with a non-empty `mission` and a ranked `sourcesOfTruth` list (each entry: rank, id, label, type, locator, description, accessPolicy) declaring the source-of-truth precedence hierarchy.",
    );
  }

  const parsed = workflowCharterSchema.safeParse(rawCharter);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
    const detail = issue?.message ?? parsed.error.message;
    return errorResult(`charter_invalid: ${detail}${where}`);
  }

  return null;
}

export interface PlannerToolDeps {
  readConfig(): Promise<GlobalConfig>;
  listWorkflows(projectPath: string): Promise<WorkflowDefinitionSummary[]>;
  getWorkflow(
    projectPath: string,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  createWorkflow(
    projectPath: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  updateWorkflow(
    projectPath: string,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  deleteWorkflow(projectPath: string, workflowId: string): Promise<boolean>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  publishCharterUpdated(input: {
    projectPath: string;
    sessionName: string;
    definitionId: string;
    definitionRevision: number;
    charterHash: string;
    execution?: GraphWorkflowExecution | null;
  }): GraphWorkflowExecutionEvent[];
}

export interface PlannerToolContext {
  projectPath: string;
  sessionName: string;
}

const CREATE_DESCRIPTION = `Create a graph workflow definition for this project. Before calling this tool, use the graph-workflow-planning skill. That skill is the source of truth for decomposing execution contexts, writing acceptance criteria, aligning implementers and validators, choosing dependency edges, deciding whether script validation is safe, and keeping default implementer/validator settings unless told otherwise.

The user will review and edit the workflow in the visual builder before starting execution.`;

const REPLACE_DESCRIPTION = `Replace the entire definition of an existing workflow. Use this when revising a plan after user feedback; submit the complete updated graph, not a partial diff. The previous definition is fully overwritten.

Before calling this tool, use the graph-workflow-planning skill and submit the full updated graph that follows that skill's planning rules.`;

const LIST_WORKFLOWS_DESCRIPTION =
  "List all saved workflow definitions for this project. Returns each workflow's ID, name, description, and timestamps.";
const GET_WORKFLOW_DESCRIPTION =
  "Retrieve the full definition of a saved workflow, including all execution contexts, tasks, and edges. Use this to inspect an existing workflow before making changes with replace_graph_workflow.";
const DELETE_WORKFLOW_DESCRIPTION =
  "Permanently delete a saved workflow definition. This cannot be undone.";
const GET_EXECUTION_STATUS_DESCRIPTION =
  "Get the current graph workflow execution status for this session, if any. Returns the execution state including overall status, per-context progress, active task, and halt reason if applicable.";

function createCreateWorkflowHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async (args: unknown) => {
    const charterError = precheckCharter(args);
    if (charterError) {
      return charterError;
    }

    const parsed = createWorkflowSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
      );
    }

    try {
      const definition = inflateToSemanticDefinition(parsed.data);
      const layout = generateWorkflowLayout(definition);
      const record = await deps.createWorkflow(context.projectPath, {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        definition,
        layout,
      });
      return textResult(
        `Workflow "${record.name}" created (id: ${record.id}). The user can review and edit it in the visual workflow builder before starting execution.`,
      );
    } catch (error) {
      return errorResult(
        `Failed to create workflow: ${getErrorMessage(error)}`,
      );
    }
  };
}

function createReplaceWorkflowHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async (args: unknown) => {
    const charterError = precheckCharter(args);
    if (charterError) {
      return charterError;
    }

    const parsed = replaceWorkflowSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
      );
    }

    try {
      const existing = await deps.getWorkflow(
        context.projectPath,
        parsed.data.workflowId,
      );
      const previousHash = existing
        ? computeCharterHash(existing.definition.charter)
        : null;
      const nextHash = computeCharterHash(parsed.data.charter);

      const definition = inflateToSemanticDefinition(parsed.data);
      const layout = generateWorkflowLayout(definition);
      const record = await deps.updateWorkflow(
        context.projectPath,
        parsed.data.workflowId,
        {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          definition,
          layout,
        },
      );

      if (nextHash !== previousHash) {
        const activeExecution = await deps.getActiveExecution(
          context.projectPath,
          context.sessionName,
        );
        deps.publishCharterUpdated({
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          definitionId: parsed.data.workflowId,
          definitionRevision: record.revision,
          charterHash: nextHash,
          execution: activeExecution,
        });
        if (activeExecution) {
          getExecutionLogger(activeExecution.id)?.lifecycle("charter.updated", {
            charterHash: nextHash,
            definitionRevision: record.revision,
            definitionId: parsed.data.workflowId,
          });
        }
      }

      return textResult(
        `Workflow "${record.name}" replaced (revision: ${record.revision}). The user can review the changes in the visual workflow builder.`,
      );
    } catch (error) {
      return errorResult(
        `Failed to replace workflow: ${getErrorMessage(error)}`,
      );
    }
  };
}

function createListWorkflowsHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async () => {
    try {
      const summaries = await deps.listWorkflows(context.projectPath);
      if (summaries.length === 0) {
        return textResult("No workflow definitions found for this project.");
      }
      const lines = summaries.map(
        (summary) =>
          `- ${summary.name} (id: ${summary.id}, revision: ${summary.revision}, updated: ${summary.updatedAt})${summary.description ? `\n  ${summary.description}` : ""}`,
      );
      return textResult(
        `Found ${summaries.length} workflow definition(s):\n\n${lines.join("\n")}`,
      );
    } catch (error) {
      return errorResult(`Failed to list workflows: ${getErrorMessage(error)}`);
    }
  };
}

function createGetWorkflowHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async (args: unknown) => {
    const parsed = workflowIdSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
      );
    }

    try {
      const record = await deps.getWorkflow(
        context.projectPath,
        parsed.data.workflowId,
      );
      if (!record) {
        return errorResult(`Workflow "${parsed.data.workflowId}" not found.`);
      }
      return textResult(JSON.stringify(record, null, 2));
    } catch (error) {
      return errorResult(`Failed to get workflow: ${getErrorMessage(error)}`);
    }
  };
}

function createDeleteWorkflowHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async (args: unknown) => {
    const parsed = workflowIdSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
      );
    }

    try {
      const deleted = await deps.deleteWorkflow(
        context.projectPath,
        parsed.data.workflowId,
      );
      if (!deleted) {
        return errorResult(`Workflow "${parsed.data.workflowId}" not found.`);
      }
      return textResult(`Workflow "${parsed.data.workflowId}" deleted.`);
    } catch (error) {
      return errorResult(
        `Failed to delete workflow: ${getErrorMessage(error)}`,
      );
    }
  };
}

function createGetExecutionStatusHandler(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
) {
  return async () => {
    try {
      const execution = await deps.getActiveExecution(
        context.projectPath,
        context.sessionName,
      );
      if (!execution) {
        return textResult(
          "No active graph workflow execution in this session.",
        );
      }
      return textResult(
        JSON.stringify(
          {
            id: execution.id,
            status: execution.status,
            activeContextId: execution.activeContextIds[0] ?? null,
            contextStates: execution.contextStates,
            haltReason: execution.haltReason,
            startedAt: execution.startedAt,
            completedAt: execution.completedAt,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      return errorResult(
        `Failed to get execution status: ${getErrorMessage(error)}`,
      );
    }
  };
}

export function registerPlannerTools(
  server: McpServer,
  context: PlannerToolContext,
  deps: PlannerToolDeps,
): void {
  server.registerTool(
    "create_graph_workflow",
    {
      description: CREATE_DESCRIPTION,
      inputSchema: createWorkflowSchema.shape,
    },
    createCreateWorkflowHandler(context, deps),
  );
  server.registerTool(
    "replace_graph_workflow",
    {
      description: REPLACE_DESCRIPTION,
      inputSchema: replaceWorkflowSchema.shape,
    },
    createReplaceWorkflowHandler(context, deps),
  );
  server.registerTool(
    "list_graph_workflows",
    {
      description: LIST_WORKFLOWS_DESCRIPTION,
      inputSchema: {},
    },
    createListWorkflowsHandler(context, deps),
  );
  server.registerTool(
    "get_graph_workflow",
    {
      description: GET_WORKFLOW_DESCRIPTION,
      inputSchema: workflowIdSchema.shape,
    },
    createGetWorkflowHandler(context, deps),
  );
  server.registerTool(
    "delete_graph_workflow",
    {
      description: DELETE_WORKFLOW_DESCRIPTION,
      inputSchema: workflowIdSchema.shape,
    },
    createDeleteWorkflowHandler(context, deps),
  );
  server.registerTool(
    "get_graph_workflow_status",
    {
      description: GET_EXECUTION_STATUS_DESCRIPTION,
      inputSchema: {},
    },
    createGetExecutionStatusHandler(context, deps),
  );
}
