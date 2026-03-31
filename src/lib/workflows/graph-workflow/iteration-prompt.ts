import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
} from "@/types";

export interface BuildIterationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: Record<string, GraphWorkflowTaskState>;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  allowAgentTaskAdd: boolean;
}

export function buildIterationPrompt(input: BuildIterationPromptInput): string {
  const sections: string[] = [];

  // Context header
  sections.push(`# Execution Context: ${input.context.title}`);
  if (input.context.description) {
    sections.push(`Goal: ${input.context.description}`);
  }

  // Workflow lifecycle explanation
  sections.push(
    [
      "## Workflow Lifecycle",
      "You are an agent running one iteration of a graph workflow execution.",
      "The workflow is a DAG of execution contexts, each containing ordered tasks.",
      "Your job is to work through the tasks below in order, calling `complete_task` for each one as you finish it.",
    ].join("\n"),
  );

  // Task list with failure feedback inline
  const taskLines = input.tasks.map((task) => {
    const state = input.taskStates[task.id];
    const status = state?.status ?? "pending";
    const failureMessage = state?.failureMessage ?? null;
    const lines = [
      `- ${task.id} [${status}] ${task.title}`,
      `  Instructions: ${task.instructions}`,
    ];
    if (failureMessage) {
      lines.push(
        "",
        `  ### Previous Attempt Failed`,
        `  A previous attempt to complete this task was rejected by validation:`,
        `  ${failureMessage}`,
        "",
        `  Address the issues above before calling complete_task again.`,
      );
    }
    return lines.join("\n");
  });

  sections.push(
    ["## Tasks (work through them in order)", ...taskLines].join("\n"),
  );

  // Protocol
  sections.push(
    [
      "## Required Protocol",
      "Follow these steps exactly:",
      "1. Work through the tasks in order, completing each one before moving to the next.",
      "2. Call `complete_task` with the task's slug and a summary after finishing each task.",
      "",
      "IMPORTANT: If you do not call `complete_task`, the task remains open and blocks all workflow progress. The workflow will stall and require manual intervention.",
    ].join("\n"),
  );

  // MCP tool reference
  const toolDocs: string[] = [
    "## MCP Tools Reference",
    "",
    "### complete_task",
    "Mark a task as complete. You MUST call this after finishing each task.",
    "Parameters:",
    "- `taskSlug` (string, required): The task ID of the task to complete.",
    "- `summary` (string, required): What you changed and how you verified it. Include files modified, tests added or run, and notable decisions.",
    "",
    "### upsert_shared_document",
    "Register or update a shared document for agents in later workflow iterations.",
    "Parameters:",
    "- `relativePath` (string, required): Path relative to worktree root.",
    "- `description` (string, required): What the document contains.",
    "- `readWhen` (string, required): When a future agent should read this document.",
  ];

  if (input.allowAgentTaskAdd) {
    toolDocs.push(
      "",
      "### add_task",
      "Append a new task to this execution context when you discover necessary work not covered by existing tasks.",
      "Parameters:",
      "- `title` (string, required): Short, descriptive name.",
      "- `instructions` (string, required): Self-contained instructions for the executing agent.",
      "- `slug` (string, optional): Kebab-case identifier. Auto-generated from title if omitted.",
    );
  }

  sections.push(toolDocs.join("\n"));

  // Shared documents
  const docLines =
    input.sharedDocuments.length === 0
      ? ["- None registered."]
      : input.sharedDocuments.map(
          (doc) =>
            `- \`${doc.relativePath}\`: ${doc.description} — Read when: ${doc.readWhen}`,
        );

  sections.push(["## Shared Documents", ...docLines].join("\n"));

  return sections.join("\n\n");
}

export interface BuildFollowUpPromptInput {
  remainingTaskIds: string[];
  attemptNumber: number;
  maxAttempts: number;
}

const CONTEXT_EXHAUSTION_THRESHOLD = 0.85;

export function isContextExhausted(input: {
  contextTokens: number | null;
  contextWindowMax: number | null;
}): boolean {
  if (
    input.contextTokens == null ||
    input.contextWindowMax == null ||
    input.contextWindowMax === 0
  ) {
    return false;
  }
  return (
    input.contextTokens / input.contextWindowMax >= CONTEXT_EXHAUSTION_THRESHOLD
  );
}

export function buildFollowUpPrompt(input: BuildFollowUpPromptInput): string {
  const taskList = input.remainingTaskIds.map((id) => `- ${id}`).join("\n");
  return [
    `You still have ${input.remainingTaskIds.length} incomplete task(s):`,
    taskList,
    `Please continue working through them in order, calling \`complete_task\` for each.`,
    `This is follow-up attempt ${input.attemptNumber} of ${input.maxAttempts}.`,
    "The workflow cannot progress until tasks are completed via the complete_task MCP tool. Without it, the workflow will stall.",
  ].join("\n");
}
