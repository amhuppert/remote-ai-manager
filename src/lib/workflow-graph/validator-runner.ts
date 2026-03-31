import { workflowAgentValidatorResultSchema } from "@/lib/schemas";
import type {
  ClaudeModel,
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

// -- Prompt builders ----------------------------------------------------------

const OUTPUT_SCHEMA_EXAMPLE = `\`\`\`json
{
  "pass": true,
  "summary": "Brief explanation of your assessment",
  "issues": [
    { "title": "Issue title", "description": "What is wrong and how to fix it." }
  ],
  "reopenTaskIds": ["task-id-to-reopen"]
}
\`\`\``;

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
    "Then output your assessment as a JSON object in a ```json fenced block:",
    "",
    OUTPUT_SCHEMA_EXAMPLE,
    "",
    "Fields:",
    "- `pass`: `true` if the task meets all validation criteria, `false` otherwise",
    "- `summary`: Brief explanation of your assessment",
    "- `issues`: Specific problems found (empty array if pass is true)",
    "- `reopenTaskIds`: IDs of previously completed tasks that need rework (only from the task list above, empty array if none)",
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
    "Then output your assessment as a JSON object in a ```json fenced block:",
    "",
    OUTPUT_SCHEMA_EXAMPLE,
    "",
    "Fields:",
    "- `pass`: `true` if the execution context goal has been fully met, `false` otherwise",
    "- `summary`: Brief explanation of your assessment",
    "- `issues`: Specific problems found (empty array if pass is true)",
    "- `reopenTaskIds`: IDs of tasks that need rework (only from the task list above, empty array if none)",
  ].join("\n");
}

// -- Result extraction --------------------------------------------------------

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

// -- Validator runner ---------------------------------------------------------

export interface ExecuteValidatorAgentInput {
  projectPath: string;
  sessionName: string;
  prompt: string;
  model: ClaudeModel;
  reasoningEffort: EffortLevel;
}

export interface ValidatorRunnerDeps {
  executeValidatorAgent(input: ExecuteValidatorAgentInput): Promise<string>;
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

    let text: string;
    try {
      text = await deps.executeValidatorAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        prompt,
        model: input.validator.agent.model,
        reasoningEffort: input.validator.agent.reasoningEffort,
      });
    } catch (error) {
      return {
        pass: false,
        summary: `Validator agent failed: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
        reopenTaskIds: [],
      };
    }

    return extractValidatorResult(text);
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

    let text: string;
    try {
      text = await deps.executeValidatorAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        prompt,
        model: input.validator.agent.model,
        reasoningEffort: input.validator.agent.reasoningEffort,
      });
    } catch (error) {
      return {
        pass: false,
        summary: `Validator agent failed: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
        reopenTaskIds: [],
      };
    }

    return extractValidatorResult(text);
  }

  return { runTaskValidator, runContextAgentValidator };
}
