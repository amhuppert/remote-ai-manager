import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
} from "@/types";

export interface LatestContextValidationFailureFeedbackIssue {
  title: string;
  description: string;
}

export interface LatestContextValidationFailureFeedbackIssueGroup {
  heading: string;
  issues: LatestContextValidationFailureFeedbackIssue[];
}

export interface LatestContextValidationFailureFeedback {
  summary: string;
  reopenedTasks: Array<{ taskId: string; title: string }>;
  groupedIssues: LatestContextValidationFailureFeedbackIssueGroup[];
}

export interface BuildIterationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: Record<string, GraphWorkflowTaskState>;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  allowAgentTaskAdd: boolean;
  contextValidationAcceptanceCriteria?: string;
  latestContextValidationFailure?: LatestContextValidationFailureFeedback;
}

function buildTaskLines(
  tasks: GraphWorkflowTaskDefinition[],
  taskStates: Record<string, GraphWorkflowTaskState>,
): string[] {
  return tasks.map((task) => {
    const state = taskStates[task.id];
    const status = state?.status ?? "pending";
    const failureHistory = state?.failureHistory ?? [];
    const failureMessage = state?.failureMessage ?? null;
    const lines = [
      `- ${task.id} [${status}] ${task.title}`,
      `  Instructions: ${task.instructions}`,
    ];

    if (failureHistory.length > 0) {
      lines.push("", `  ### Validation Failure History`);
      for (let i = 0; i < failureHistory.length; i++) {
        const failure = failureHistory[i]!;
        lines.push(
          `  **Attempt ${i + 1}** (${failure.timestamp}):`,
          `  ${failure.message}`,
          "",
        );
      }
      lines.push(
        `  Address ALL issues from previous attempts before calling complete_task again.`,
      );
    } else if (failureMessage) {
      // Backward compat: fall back to single failureMessage
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
}

function buildLatestContextValidationFailureSection(
  latestContextValidationFailure?: LatestContextValidationFailureFeedback,
): string | null {
  if (!latestContextValidationFailure) {
    return null;
  }

  const sections = [
    "## Latest Context Validation Failure",
    "You are retrying this execution context after a failed context validation.",
    "",
    "Summary:",
    latestContextValidationFailure.summary,
  ];

  if (latestContextValidationFailure.reopenedTasks.length > 0) {
    sections.push(
      "",
      "Reopened Tasks:",
      ...latestContextValidationFailure.reopenedTasks.map(
        (task) => `- \`${task.taskId}\` - ${task.title}`,
      ),
    );
  }

  if (latestContextValidationFailure.groupedIssues.length > 0) {
    sections.push("", "Issues:");
    for (const group of latestContextValidationFailure.groupedIssues) {
      sections.push(
        `### ${group.heading}`,
        ...group.issues.map(
          (issue) => `- ${issue.title}: ${issue.description}`,
        ),
        "",
      );
    }
  }

  return sections.join("\n").trimEnd();
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

  const latestContextValidationFailureSection =
    buildLatestContextValidationFailureSection(
      input.latestContextValidationFailure,
    );
  if (latestContextValidationFailureSection) {
    sections.push(latestContextValidationFailureSection);
  }

  // Task list with failure feedback inline
  const taskLines = buildTaskLines(input.tasks, input.taskStates);

  sections.push(
    ["## Tasks (work through them in order)", ...taskLines].join("\n"),
  );

  // Acceptance criteria are shared between the implementer and the context validator.
  if (input.contextValidationAcceptanceCriteria) {
    sections.push(
      [
        "## Acceptance Criteria",
        "When every task in this execution context is marked complete, a context validator will review the whole context against these exact acceptance criteria.",
        "If the validator reopens any tasks, address the feedback and call `complete_task` again for those reopened tasks.",
        "",
        input.contextValidationAcceptanceCriteria,
      ].join("\n"),
    );
  }

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
  remainingTasks: GraphWorkflowTaskDefinition[];
  taskStates: Record<string, GraphWorkflowTaskState>;
  attemptNumber: number;
  maxAttempts: number;
  latestContextValidationFailure?: LatestContextValidationFailureFeedback;
}

export function buildFollowUpPrompt(input: BuildFollowUpPromptInput): string {
  const taskLines = buildTaskLines(input.remainingTasks, input.taskStates);
  const sections = [
    `You still have ${input.remainingTasks.length} incomplete task(s):`,
  ];

  const latestContextValidationFailureSection =
    buildLatestContextValidationFailureSection(
      input.latestContextValidationFailure,
    );
  if (latestContextValidationFailureSection) {
    sections.push(latestContextValidationFailureSection);
  }

  sections.push(
    ["## Remaining Tasks", ...taskLines].join("\n"),
    `Please continue working through them in order, calling \`complete_task\` for each.`,
    `This is follow-up attempt ${input.attemptNumber} of ${input.maxAttempts}.`,
    "The workflow cannot progress until tasks are completed via the complete_task MCP tool. Without it, the workflow will stall.",
  );

  return sections.join("\n\n");
}
