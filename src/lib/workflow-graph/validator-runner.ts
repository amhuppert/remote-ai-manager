import { workflowAgentValidatorResultSchema } from "@/lib/schemas";
import type {
  ClaudeModel,
  CodexReasoningEffort,
  EffortLevel,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowAgentValidatorResult,
} from "@/types";
import type {
  GraphWorkflowTaskValidatorInput,
  GraphWorkflowContextAgentValidatorInput,
} from "./execution-validation";

// -- JSON Schema for structured output (used by both Claude and Codex) --------

export const VALIDATOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
    reopenTaskIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["pass", "summary", "issues", "reopenTaskIds"],
  additionalProperties: false,
} as const;

// -- Prompt builders ----------------------------------------------------------

export interface BuildTaskValidationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  task: GraphWorkflowTaskDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  summary: string;
  validator: GraphWorkflowAgentValidatorConfig;
}

export function buildTaskValidationPrompt(
  input: BuildTaskValidationPromptInput,
): string {
  const taskList = input.tasks
    .map((t) => `- \`${t.id}\`: ${t.title}`)
    .join("\n");

  return [
    "# Task Validation",
    "",
    "You are a validation agent reviewing a completed task in a graph workflow.",
    "Your job is to assess whether the task was completed correctly and thoroughly.",
    "",
    "## Your Validation Instructions",
    "",
    input.validator.instructions,
    "",
    "## Context",
    "",
    `Execution context: ${input.context.title}`,
    ...(input.context.description
      ? [`Goal: ${input.context.description}`]
      : []),
    "",
    "## Task Under Review",
    "",
    `- **Task ID**: \`${input.task.id}\``,
    `- **Title**: ${input.task.title}`,
    `- **Instructions**: ${input.task.instructions}`,
    `- **Agent Summary**: ${input.summary}`,
    "",
    "## All Tasks in This Context",
    "",
    taskList,
    "",
    "## Required Output",
    "",
    "You MUST review the work the agent did — read files, check for correctness, verify the agent's claims.",
    "Then output your assessment as a JSON object with these fields:",
    "",
    "- `pass` (boolean): `true` if the task meets all validation criteria, `false` otherwise",
    "- `summary` (string): Brief explanation of your assessment",
    "- `issues` (array of `{ title, description }`): Specific problems found (empty array if pass is true)",
    "- `reopenTaskIds` (array of strings): IDs of previously completed tasks that need rework (only from the task list above, empty array if none)",
  ].join("\n");
}

export interface BuildContextValidationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  validator: GraphWorkflowAgentValidatorConfig;
}

export function buildContextValidationPrompt(
  input: BuildContextValidationPromptInput,
): string {
  const taskList = input.tasks
    .map((t) => `- \`${t.id}\`: ${t.title} — ${t.instructions}`)
    .join("\n");

  return [
    "# Execution Context Validation",
    "",
    "You are a validation agent reviewing all completed work in an execution context.",
    "Your job is to assess whether the overall goal has been met.",
    "",
    "## Your Validation Instructions",
    "",
    input.validator.instructions,
    "",
    "## Context",
    "",
    `Execution context: ${input.context.title}`,
    ...(input.context.description
      ? [`Goal: ${input.context.description}`]
      : []),
    "",
    "## Completed Tasks",
    "",
    taskList,
    "",
    "## Required Output",
    "",
    "Review the combined work across all tasks — read files, run checks, verify correctness.",
    "Then output your assessment as a JSON object with these fields:",
    "",
    "- `pass` (boolean): `true` if the execution context goal has been fully met, `false` otherwise",
    "- `summary` (string): Brief explanation of your assessment",
    "- `issues` (array of `{ title, description }`): Specific problems found (empty array if pass is true)",
    "- `reopenTaskIds` (array of strings): IDs of tasks that need rework (only from the task list above, empty array if none)",
  ].join("\n");
}

// -- Result parsing -----------------------------------------------------------

/**
 * Extract and parse a WorkflowAgentValidatorResult from agent text output.
 * Looks for the last ```json fenced block and parses it with the schema.
 * Returns a synthetic failing result when extraction or parsing fails.
 */
export function extractValidatorResult(
  text: string,
): WorkflowAgentValidatorResult {
  const jsonBlocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (jsonBlocks.length === 0) {
    return {
      pass: false,
      summary: "Validator agent did not return structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  const lastBlock = jsonBlocks[jsonBlocks.length - 1]!;
  const raw = lastBlock[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      pass: false,
      summary: "Validator agent returned invalid structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  const result = workflowAgentValidatorResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      pass: false,
      summary: "Validator agent returned invalid structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  return result.data;
}

/**
 * Parse a validator response, trying structured output first, then raw JSON,
 * then fenced ```json block extraction as a fallback.
 */
export function parseValidatorResponse(
  text: string,
  structuredOutput?: unknown,
): WorkflowAgentValidatorResult {
  // Path 1: structured output from SDK (both Claude and Codex)
  if (structuredOutput != null) {
    const result =
      workflowAgentValidatorResultSchema.safeParse(structuredOutput);
    if (result.success) return result.data;
  }

  // Path 2: raw JSON string (Codex outputSchema response)
  try {
    const parsed = JSON.parse(text);
    const result = workflowAgentValidatorResultSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    /* not raw JSON, try fenced block */
  }

  // Path 3: fenced ```json block (legacy fallback)
  return extractValidatorResult(text);
}

// -- Validator runner ---------------------------------------------------------

export interface ValidatorExecutionResult {
  text: string;
  structuredOutput?: unknown;
}

export interface ExecuteValidatorAgentInput {
  projectPath: string;
  sessionName: string;
  prompt: string;
  model: ClaudeModel;
  reasoningEffort: EffortLevel;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

export interface ExecuteValidatorCodexInput {
  projectPath: string;
  sessionName: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface ValidatorRunnerDeps {
  executeValidatorAgent(
    input: ExecuteValidatorAgentInput,
  ): Promise<ValidatorExecutionResult>;
  executeValidatorCodex(input: ExecuteValidatorCodexInput): Promise<string>;
}

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
  async function runTaskValidator(
    input: GraphWorkflowTaskValidatorInput,
  ): Promise<WorkflowAgentValidatorResult> {
    const contextTasks = input.execution.workingDefinition.tasks.filter(
      (t) => t.contextId === input.context.id,
    );

    const prompt = buildTaskValidationPrompt({
      context: input.context,
      task: input.task,
      tasks: contextTasks,
      summary: input.summary,
      validator: input.validator,
    });

    try {
      if (input.validator.type === "codex") {
        const text = await deps.executeValidatorCodex({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          prompt,
          model: input.validator.codex.model,
          reasoningEffort: input.validator.codex.reasoningEffort,
        });
        return parseValidatorResponse(text);
      }

      const result = await deps.executeValidatorAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        prompt,
        model: input.validator.agent.model,
        reasoningEffort: input.validator.agent.reasoningEffort,
        outputFormat: {
          type: "json_schema",
          schema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        },
      });
      return parseValidatorResponse(result.text, result.structuredOutput);
    } catch (error) {
      return {
        pass: false,
        summary: `Validator agent failed: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
        reopenTaskIds: [],
      };
    }
  }

  async function runContextAgentValidator(
    input: GraphWorkflowContextAgentValidatorInput,
  ): Promise<WorkflowAgentValidatorResult> {
    const contextTasks = input.execution.workingDefinition.tasks.filter(
      (t) => t.contextId === input.context.id,
    );

    const prompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      validator: input.validator,
    });

    try {
      if (input.validator.type === "codex") {
        const text = await deps.executeValidatorCodex({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          prompt,
          model: input.validator.codex.model,
          reasoningEffort: input.validator.codex.reasoningEffort,
        });
        return parseValidatorResponse(text);
      }

      const result = await deps.executeValidatorAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        prompt,
        model: input.validator.agent.model,
        reasoningEffort: input.validator.agent.reasoningEffort,
        outputFormat: {
          type: "json_schema",
          schema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        },
      });
      return parseValidatorResponse(result.text, result.structuredOutput);
    } catch (error) {
      return {
        pass: false,
        summary: `Validator agent failed: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
        reopenTaskIds: [],
      };
    }
  }

  return { runTaskValidator, runContextAgentValidator };
}
