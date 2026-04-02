import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  GraphWorkflowExecution,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import { claudeModelSchema, effortLevelSchema } from "@/lib/schemas";
import { getErrorMessage } from "@/lib/errors";
import { generateWorkflowLayout } from "./layout";
import { createWorkflowStorageService } from "./storage";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
} from "./storage";

// ============================================================
// Tool Input Schemas (agent-facing, uses "slug" naming)
// ============================================================

const executionContextInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Unique kebab-case identifier (e.g. 'auth-setup'). Referenced by tasks and edges.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .describe("Display name for this context (e.g. 'Authentication Setup')."),
  instructions: z
    .string()
    .trim()
    .min(1)
    .describe(
      "High-level goal and constraints for the agent session running this context.",
    ),
  agentConfig: z
    .object({
      model: claudeModelSchema.optional(),
      reasoningEffort: effortLevelSchema.optional(),
    })
    .optional()
    .describe(
      "Override the model or reasoning effort for this context's agent. Omit to use project defaults.",
    ),
  circuitBreakerPolicy: z
    .object({})
    .optional()
    .describe(
      "Circuit breaker configuration. Currently trips on retry exhaustion; future conditions will add fields here.",
    ),
  iterationPolicy: z
    .object({
      maxIterations: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum agent iterations before halting."),
      contextSoftLimitTokens: z.number().int().positive().optional(),
      contextHardLimitTokens: z.number().int().positive().optional(),
    })
    .optional()
    .describe("Iteration limits. Defaults: maxIterations 20."),
  mutabilityPolicy: z
    .object({
      allowAgentTaskAdd: z
        .boolean()
        .optional()
        .describe(
          "Whether the executing agent can dynamically add tasks to this context.",
        ),
    })
    .optional()
    .describe("Mutability permissions. Defaults: allowAgentTaskAdd false."),
  taskValidation: z
    .object({
      instructions: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Instructions the validator agent uses to check each completed task.",
        ),
    })
    .optional()
    .describe(
      "Per-task validation by an agent after each task completes. Omit if no per-task validation is needed.",
    ),
  contextValidation: z
    .object({
      agentValidator: z
        .object({
          instructions: z
            .string()
            .trim()
            .min(1)
            .describe(
              "Instructions the validator agent uses to check the context's work.",
            ),
        })
        .optional()
        .describe(
          "Agent-based validation after all tasks in this context complete.",
        ),
      scriptValidator: z
        .object({
          enabled: z
            .boolean()
            .describe(
              "Whether to run the project's pre-merge validation script.",
            ),
        })
        .optional()
        .describe(
          "Script-based validation (runs the project's configured pre-merge script).",
        ),
      onFail: z
        .object({
          mode: z
            .enum(["halt", "retry"])
            .describe(
              "'halt' stops the workflow; 'retry' reruns this context.",
            ),
          maxAttempts: z
            .number()
            .int()
            .min(1)
            .describe("Maximum retry attempts before halting."),
        })
        .optional()
        .describe(
          "What to do when context validation fails. Required if agentValidator or scriptValidator is set.",
        ),
    })
    .optional()
    .describe(
      "Validation gate run after all tasks in this context complete. Omit if no validation checkpoint is needed.",
    ),
});

const taskInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .describe("Unique kebab-case identifier (e.g. 'create-user-schema')."),
  contextSlug: z
    .string()
    .trim()
    .min(1)
    .describe("Which execution context this task belongs to."),
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
  sourceContextSlug: z
    .string()
    .trim()
    .min(1)
    .describe("The upstream context that must complete first."),
  targetContextSlug: z
    .string()
    .trim()
    .min(1)
    .describe("The downstream context that depends on the source."),
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
      "Dependency edges between execution contexts. Context at targetContextSlug waits for sourceContextSlug to complete.",
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

// ============================================================
// Inflate agent input → internal semantic definition
// ============================================================

const DEFAULT_MODEL = "sonnet" as const;
const DEFAULT_EFFORT = "high" as const;
const DEFAULT_MAX_ITERATIONS = 20;
function inflateToSemanticDefinition(
  input: CreateWorkflowInput,
): WorkflowSemanticDefinition {
  const executionContexts = input.executionContexts.map((ctx) => ({
    id: ctx.slug,
    title: ctx.title,
    description: ctx.instructions,
    agent: {
      model: ctx.agentConfig?.model ?? DEFAULT_MODEL,
      reasoningEffort: ctx.agentConfig?.reasoningEffort ?? DEFAULT_EFFORT,
    },
    mutability: {
      allowAgentTaskAdd: ctx.mutabilityPolicy?.allowAgentTaskAdd ?? false,
    },
    circuitBreaker: {},
    iterationPolicy: {
      maxIterations:
        ctx.iterationPolicy?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      ...(ctx.iterationPolicy?.contextSoftLimitTokens !== undefined
        ? { contextSoftLimitTokens: ctx.iterationPolicy.contextSoftLimitTokens }
        : {}),
      ...(ctx.iterationPolicy?.contextHardLimitTokens !== undefined
        ? { contextHardLimitTokens: ctx.iterationPolicy.contextHardLimitTokens }
        : {}),
    },
    ...(ctx.taskValidation
      ? {
          taskValidation: {
            type: "claude" as const,
            enabled: true,
            agent: {
              model: ctx.agentConfig?.model ?? DEFAULT_MODEL,
              reasoningEffort:
                ctx.agentConfig?.reasoningEffort ?? DEFAULT_EFFORT,
            },
            instructions: ctx.taskValidation.instructions,
          },
        }
      : {}),
    ...(ctx.contextValidation
      ? {
          contextValidation: {
            ...(ctx.contextValidation.agentValidator
              ? {
                  agentValidator: {
                    type: "claude" as const,
                    enabled: true,
                    agent: {
                      model: ctx.agentConfig?.model ?? DEFAULT_MODEL,
                      reasoningEffort:
                        ctx.agentConfig?.reasoningEffort ?? DEFAULT_EFFORT,
                    },
                    instructions:
                      ctx.contextValidation.agentValidator.instructions,
                  },
                }
              : {}),
            ...(ctx.contextValidation.scriptValidator
              ? { scriptValidator: ctx.contextValidation.scriptValidator }
              : {}),
            onFail: ctx.contextValidation.onFail
              ? {
                  mode: ctx.contextValidation.onFail.mode,
                  retryScope: "same_context" as const,
                  maxAttempts: ctx.contextValidation.onFail.maxAttempts,
                }
              : {
                  mode: "halt" as const,
                  retryScope: "same_context" as const,
                  maxAttempts: 1,
                },
          },
        }
      : {}),
  }));

  // Derive task order from array position per context
  const contextTaskCounters = new Map<string, number>();
  const tasks = input.tasks.map((task) => {
    const count = (contextTaskCounters.get(task.contextSlug) ?? 0) + 1;
    contextTaskCounters.set(task.contextSlug, count);
    return {
      id: task.slug,
      contextId: task.contextSlug,
      order: count,
      title: task.title,
      instructions: task.instructions,
      source: "user" as const,
    };
  });

  const edges = input.edges.map((edge) => ({
    id: `edge-${randomUUID().slice(0, 8)}`,
    sourceContextId: edge.sourceContextSlug,
    targetContextId: edge.targetContextSlug,
  }));

  return {
    schemaVersion: 1,
    executionContexts,
    tasks,
    edges,
  };
}

// ============================================================
// Result helpers
// ============================================================

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

// ============================================================
// Dependency Injection
// ============================================================

export interface PlannerToolDeps {
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

// ============================================================
// Tool Server
// ============================================================

const CREATE_DESCRIPTION = `Create a graph workflow definition for this project. Analyze the user's objective and decompose it into execution contexts (groups of related work) with tasks and dependency edges.

Guidelines for planning:
- Each execution context runs as an independent agent session. Split work into separate contexts when tasks have distinct concerns or dependency boundaries.
- Tasks within a context execute sequentially in array order within a single agent session. Make each task achievable in roughly 10-30 minutes of work.
- Task instructions must be self-contained: the executing agent sees only the workflow definition and the codebase, not this conversation. Include the specific what, why, files to modify, and how to verify.
- Edges express dependencies: context B waits for context A to complete. Do not create edges between contexts that can run independently.
- Use kebab-case slugs that describe the content (e.g. 'auth-setup', 'create-user-schema'), not generic names like 'step-1'.
- Validation configuration is optional. Only add context validation when you need a checkpoint that gates downstream work. Most simple workflows need no validation config.
- The user will review and edit the workflow in the visual builder before starting execution.`;

const REPLACE_DESCRIPTION =
  "Replace the entire definition of an existing workflow. Use this when revising a plan after user feedback — submit the complete updated graph, not a partial diff. The previous definition is fully overwritten.";

export function createPlannerToolServer(
  context: PlannerToolContext,
  deps: PlannerToolDeps,
): McpSdkServerConfigWithInstance {
  const createWorkflowTool = tool(
    "create_graph_workflow",
    CREATE_DESCRIPTION,
    createWorkflowSchema.shape,
    async (args) => {
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
    },
  );

  const replaceWorkflowTool = tool(
    "replace_graph_workflow",
    REPLACE_DESCRIPTION,
    replaceWorkflowSchema.shape,
    async (args) => {
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
    },
  );

  const listWorkflowsTool = tool(
    "list_graph_workflows",
    "List all saved workflow definitions for this project. Returns each workflow's ID, name, description, and timestamps.",
    {},
    async () => {
      try {
        const summaries = await deps.listWorkflows(context.projectPath);
        if (summaries.length === 0) {
          return textResult("No workflow definitions found for this project.");
        }
        const lines = summaries.map(
          (s) =>
            `- ${s.name} (id: ${s.id}, revision: ${s.revision}, updated: ${s.updatedAt})${s.description ? `\n  ${s.description}` : ""}`,
        );
        return textResult(
          `Found ${summaries.length} workflow definition(s):\n\n${lines.join("\n")}`,
        );
      } catch (error) {
        return errorResult(
          `Failed to list workflows: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  const getWorkflowTool = tool(
    "get_graph_workflow",
    "Retrieve the full definition of a saved workflow, including all execution contexts, tasks, and edges. Use this to inspect an existing workflow before making changes with replace_graph_workflow.",
    workflowIdSchema.shape,
    async (args) => {
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
    },
  );

  const deleteWorkflowTool = tool(
    "delete_graph_workflow",
    "Permanently delete a saved workflow definition. This cannot be undone.",
    workflowIdSchema.shape,
    async (args) => {
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
    },
  );

  const getExecutionStatusTool = tool(
    "get_graph_workflow_status",
    "Get the current graph workflow execution status for this session, if any. Returns the execution state including overall status, per-context progress, active task, and halt reason if applicable.",
    {},
    async () => {
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
              activeContextId: execution.activeContextId,
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
    },
  );

  return createSdkMcpServer({
    name: "graph-workflow-planner",
    version: "1.0.0",
    tools: [
      createWorkflowTool,
      replaceWorkflowTool,
      listWorkflowsTool,
      getWorkflowTool,
      deleteWorkflowTool,
      getExecutionStatusTool,
    ],
  });
}

// ============================================================
// Convenience factory for production wiring
// ============================================================

export interface CreateWiredPlannerToolServerDeps {
  readConfig(): Promise<import("@/types").GlobalConfig>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<import("@/types").SessionState | null>;
}

/**
 * Creates a planner tool server with production storage and execution deps
 * wired from the functions already available in actor-implementations.
 */
export function createWiredPlannerToolServer(
  context: PlannerToolContext,
  wireDeps: CreateWiredPlannerToolServerDeps,
): McpSdkServerConfigWithInstance {
  const storage = createWorkflowStorageService({
    readConfig: wireDeps.readConfig,
  });

  return createPlannerToolServer(context, {
    listWorkflows: storage.list,
    getWorkflow: storage.get,
    createWorkflow: storage.create,
    updateWorkflow: storage.update,
    deleteWorkflow: storage.delete,
    getActiveExecution: async (projectPath, sessionName) => {
      const session = await wireDeps.getSession(projectPath, sessionName);
      return session?.graphWorkflowExecution ?? null;
    },
  });
}
