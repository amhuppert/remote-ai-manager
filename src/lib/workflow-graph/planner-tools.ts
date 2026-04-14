import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  GraphWorkflowExecution,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import {
  claudeModelSchema,
  effortLevelSchema,
  validatorTypeSchema,
} from "@/lib/schemas";
import type {
  ClaudeModel,
  EffortLevel,
  GlobalConfig,
  ValidatorType,
  WorkflowDefaults,
  WorkflowValidatorDefault,
} from "@/types";
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
    .object({
      consecutiveFailureThreshold: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Number of consecutive task validation failures before the circuit breaker halts the context. Defaults to 3.",
        ),
    })
    .optional()
    .describe(
      "Circuit breaker configuration. Halts the context after repeated validation failures.",
    ),
  iterationPolicy: z
    .object({
      maxIterations: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum agent iterations before halting."),
      continuity: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe(
              "Whether the implementer reuses the same session within this execution context. Defaults to true.",
            ),
          contextLimitTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Token threshold after which the implementer session rotates before the next iteration. Omit to disable limit-based rotation.",
            ),
        })
        .optional()
        .describe("Implementer session continuity policy."),
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
      type: validatorTypeSchema
        .optional()
        .describe(
          "Validator type: 'claude' (Claude agent) or 'codex' (OpenAI Codex, runs locally). Omit to use the project's workflow defaults.",
        ),
      instructions: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Instructions the validator uses to check each completed task.",
        ),
      continuity: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe(
              "Whether the task validator reuses the same session within this execution context. Defaults to true.",
            ),
          contextLimitTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Token threshold after which the task validator session rotates. Omit to disable limit-based rotation.",
            ),
        })
        .optional()
        .describe("Task validator session continuity policy."),
    })
    .optional()
    .describe(
      "Per-task validation after each task completes. Omit if no per-task validation is needed.",
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

/**
 * Build a validator config for the workflow definition.
 * - inputType: explicit type from the MCP tool input (overrides default)
 * - validatorDefault: from workflowDefaults config (provides type + model/effort)
 * - claudeFallback: model/effort from the execution context agent config
 */
function buildValidatorConfig(
  instructions: string,
  inputType: ValidatorType | undefined,
  validatorDefault: WorkflowValidatorDefault | undefined,
  claudeFallback: { model: ClaudeModel; reasoningEffort: EffortLevel },
  continuityInput?: { enabled?: boolean; contextLimitTokens?: number },
) {
  const type = inputType ?? validatorDefault?.type ?? "claude";

  const continuity = {
    enabled: continuityInput?.enabled ?? true,
    ...(continuityInput?.contextLimitTokens !== undefined
      ? { contextLimitTokens: continuityInput.contextLimitTokens }
      : {}),
  };

  if (type === "codex") {
    const codexDefaults =
      validatorDefault?.type === "codex" ? validatorDefault : undefined;
    return {
      type: "codex" as const,
      enabled: true,
      codex: {
        ...(codexDefaults?.model !== undefined
          ? { model: codexDefaults.model }
          : {}),
        ...(codexDefaults?.reasoningEffort !== undefined
          ? { reasoningEffort: codexDefaults.reasoningEffort }
          : {}),
      },
      instructions,
      continuity,
    };
  }

  const claudeDefaults =
    validatorDefault?.type === "claude" ? validatorDefault : undefined;
  return {
    type: "claude" as const,
    enabled: true,
    agent: {
      model: claudeDefaults?.model ?? claudeFallback.model,
      reasoningEffort:
        claudeDefaults?.reasoningEffort ?? claudeFallback.reasoningEffort,
    },
    instructions,
    continuity,
  };
}

function inflateToSemanticDefinition(
  input: CreateWorkflowInput,
  workflowDefaults?: WorkflowDefaults,
): WorkflowSemanticDefinition {
  const taskValidatorDefault = workflowDefaults?.taskValidator;

  const executionContexts = input.executionContexts.map((ctx) => {
    const ctxModel = ctx.agentConfig?.model ?? DEFAULT_MODEL;
    const ctxEffort = ctx.agentConfig?.reasoningEffort ?? DEFAULT_EFFORT;
    const claudeFallback = { model: ctxModel, reasoningEffort: ctxEffort };

    return {
      id: ctx.slug,
      title: ctx.title,
      description: ctx.instructions,
      agent: { model: ctxModel, reasoningEffort: ctxEffort },
      mutability: {
        allowAgentTaskAdd: ctx.mutabilityPolicy?.allowAgentTaskAdd ?? false,
      },
      circuitBreaker: {
        ...(ctx.circuitBreakerPolicy?.consecutiveFailureThreshold !==
          undefined && {
          consecutiveFailureThreshold:
            ctx.circuitBreakerPolicy.consecutiveFailureThreshold,
        }),
      },
      iterationPolicy: {
        maxIterations:
          ctx.iterationPolicy?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        continuity: {
          enabled: ctx.iterationPolicy?.continuity?.enabled ?? true,
          ...(ctx.iterationPolicy?.continuity?.contextLimitTokens !== undefined
            ? {
                contextLimitTokens:
                  ctx.iterationPolicy.continuity.contextLimitTokens,
              }
            : {}),
        },
      },
      ...(ctx.taskValidation
        ? {
            taskValidation: buildValidatorConfig(
              ctx.taskValidation.instructions,
              ctx.taskValidation.type,
              taskValidatorDefault,
              claudeFallback,
              ctx.taskValidation.continuity,
            ),
          }
        : {}),
    };
  });

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
- Validation is optional. When needed, set the validator type directly: 'claude' (Claude agent) or 'codex' (OpenAI Codex, runs locally). Codex is a first-class validator — set it via the type field. Do NOT configure a Claude validator with instructions to invoke Codex via tools. Omit type to use project defaults.
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
        const config = await deps.readConfig();
        const definition = inflateToSemanticDefinition(
          parsed.data,
          config.workflowDefaults,
        );
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
        const config = await deps.readConfig();
        const definition = inflateToSemanticDefinition(
          parsed.data,
          config.workflowDefaults,
        );
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
  readConfig(): Promise<GlobalConfig>;
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
    readConfig: wireDeps.readConfig,
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
