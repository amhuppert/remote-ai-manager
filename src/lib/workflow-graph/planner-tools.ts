import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  GlobalConfig,
  GraphWorkflowExecution,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import {
  contextValidatorOverrideSchema,
  graphWorkflowAgentConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  workflowConfigOverrideSchema,
} from "@/lib/schemas";
import { getErrorMessage } from "@/lib/errors";
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
      "Required. The shared 'done' statement for this context. Passed to the implementer and, when the agent validator is enabled, to that validator. Write criteria that stay strictly inside this context's scope — if another context will finish related work (e.g. updating downstream types, wiring up integrations), do not include that work here. Do NOT write deterministic gates such as 'tests pass', 'no type errors', 'lint clean', or 'build succeeds' — those belong to the optional script validator, not the acceptance criteria. Focus on judgment-based outcomes that only a reviewer could assess.",
    ),
  implementer: graphWorkflowAgentConfigSchema
    .optional()
    .describe(
      "Optional per-context override for the implementer agent backend/model/reasoningEffort. Omit to inherit workflow-level or project defaults.",
    ),
  contextValidator: contextValidatorOverrideSchema
    .optional()
    .describe(
      "Optional per-context override for the agent (LLM-judged) validator. Use { kind: 'use', value: ... } to specify a custom validator, or { kind: 'disabled' } to opt this context out of agent validation. Omit to inherit the workflow-level validator. The agent validator judges intent-based criteria only; deterministic checks belong to scriptValidator.",
    ),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .optional()
    .describe(
      "Optional per-context script validator. Set { enabled: true } to run the project's preMergeCommand as a deterministic gate after all tasks in this context complete. Failures are saved to a log file and fed back to the implementer as a remediation task. Requires the project to have a preMergeCommand configured in CommandCenter.json — otherwise the workflow halts with an infra error. Omit to inherit workflow-level/global defaults. A context may use the agent validator, script validator, both, or neither.",
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
      "Self-contained instructions for the executing agent. Include what to change, why, which files, and how to verify.",
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
      "Optional workflow-level config overrides. Only include when the user explicitly asked for non-default backend/model/effort or non-default policies; otherwise omit to inherit global defaults.",
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
      "Atomic work items. Ordered per context by array position — no explicit order field needed.",
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
      "Optional workflow-level config overrides. Only include when the user explicitly asked for non-default backend/model/effort or non-default policies; otherwise omit to inherit global defaults.",
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

  return {
    schemaVersion: 1,
    workflowConfig: input.workflowConfig ?? {},
    executionContexts,
    tasks,
    edges,
  };
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
}

export interface PlannerToolContext {
  projectPath: string;
  sessionName: string;
}

const CREATE_DESCRIPTION = `Create a graph workflow definition for this project. Analyze the user's objective and decompose it into execution contexts (groups of related work) with tasks and dependency edges.

Planning guidelines:
- Each execution context runs as an independent agent session. Split work into separate contexts when tasks have distinct concerns or dependency boundaries.
- Tasks within a context execute sequentially in array order within a single agent session. Make each task achievable in roughly 10-30 minutes of work.
- Task instructions must be self-contained: the executing agent sees only the workflow definition and the codebase, not this conversation. Include the specific what, why, files to modify, and how to verify.
- Edges express dependencies: context B waits for context A to complete. Do not create edges between contexts that can run independently.
- Use kebab-case ids that describe the content (e.g. 'auth-setup', 'create-user-schema'), not generic names like 'step-1'.

Acceptance criteria authoring:
- Write intent-based criteria that an agent could judge by reading the resulting code — outcomes, not process.
- Keep criteria STRICTLY inside the scope of THIS context. If cleanup, type updates, integration work, or follow-up wiring is the responsibility of a downstream context, do not include it here. Holding a context to work that another context is assigned to produces false validation failures.
- Do NOT encode deterministic checks ('tests pass', 'no type errors', 'lint clean', 'build succeeds') in acceptance criteria. The agent validator ignores those. If those gates must fully pass before a context can proceed, enable the script validator on the context instead — it runs the project's preMergeCommand as a deterministic gate.

Validators (two independent mechanisms):
- 'contextValidator' runs an LLM agent that judges the INTENT of the acceptance criteria. It makes allowance for imprecise wording and respects context scope boundaries. Use { kind: 'disabled' } to opt out, or { kind: 'use', value: ... } to override.
- 'scriptValidator: { enabled: true }' runs the project's preMergeCommand as a deterministic pre-merge gate after all tasks complete. On failure, the full output is written to a log file and a remediation task is added to the context. Script validator runs BEFORE the agent validator; if the script fails, the agent validator is skipped for that iteration.
- A context may enable the agent validator, the script validator, both, or neither.

Cascade & defaults (IMPORTANT — keep payloads minimal):
- 'acceptanceCriteria' is REQUIRED on every execution context. Treat it as the single source of truth for what intent-based success looks like in this context's scope.
- 'implementer', 'contextValidator', 'scriptValidator', 'iterationPolicy', 'circuitBreaker', and 'mutability' are all OPTIONAL on a context. Omit them entirely unless the user explicitly asked for a non-default value on that specific context. Omitted blocks inherit from the workflow-level config, which inherits from the global project defaults.
- Include top-level 'workflowConfig' ONLY when the user explicitly asked for a non-default backend/model/effort or a non-default policy for the whole workflow. Otherwise omit it and let global defaults apply.

The user will review and edit the workflow in the visual builder before starting execution.`;

const REPLACE_DESCRIPTION = `Replace the entire definition of an existing workflow. Use this when revising a plan after user feedback — submit the complete updated graph, not a partial diff. The previous definition is fully overwritten.

The same authoring rules apply as with create_graph_workflow:
- Every execution context must declare 'acceptanceCriteria' as intent-based outcomes strictly inside the context's scope. Do not include deterministic gates (tests/types/lint/build) — use 'scriptValidator' for those.
- Validators are independent: 'contextValidator' judges intent with an LLM; 'scriptValidator: { enabled: true }' runs the project's preMergeCommand as a deterministic gate. A context may enable both, either, or neither.
- Omit 'implementer', 'contextValidator', 'scriptValidator', 'iterationPolicy', 'circuitBreaker', and 'mutability' on a context unless the user explicitly asked for a non-default value on that context. Omitted blocks inherit workflow-level / global defaults.
- Set top-level 'workflowConfig' only when the user explicitly asked for non-default backend/model/effort or non-default policies for the whole workflow; otherwise omit it.`;

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
    const parsed = replaceWorkflowSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        `Validation error: ${parsed.error.message}. Please correct the tool payload and retry.`,
      );
    }

    try {
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
