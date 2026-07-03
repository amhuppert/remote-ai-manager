import {
  CHARTER_DOCUMENT_PATH,
  renderCharterPromptSection,
} from "@/lib/workflow-graph/charter/render";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type {
  GraphWorkflowCollaborationContinuation,
  GraphWorkflowResolvedContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
} from "@/lib/workflows/schemas";

/**
 * The command that advances the workflow. `<taskId>` is the task's id from the
 * task list; the summary rides `--summary`. Referenced throughout the lane
 * prompt so every mention stays in sync with the CLI surface (doc 02 §4.3 — the
 * prompt is the lane agent's only discovery surface, so it names the exact
 * invocation, not an MCP tool).
 */
const COMPLETE_TASK_COMMAND =
  'cctl workflow task complete <taskId> --summary "<what you changed and how you verified it>"';

function buildCharterSection(charter: WorkflowCharter): string {
  return renderCharterPromptSection(charter, [
    "When resolving a source conflict or ambiguity while completing a task, cite the governing source-of-truth entry in your `cctl workflow task complete` summary.",
    "Sources marked outside the worktree are read-only: never read, write, or verify them; out-of-worktree access requires explicit human permission.",
  ]);
}
interface LatestContextValidationFailureFeedbackIssue {
  title: string;
  description: string;
}

interface LatestContextValidationFailureFeedbackIssueGroup {
  heading: string;
  issues: LatestContextValidationFailureFeedbackIssue[];
}

export interface LatestContextValidationFailureFeedback {
  summary: string;
  reopenedTasks: Array<{ taskId: string; title: string }>;
  groupedIssues: LatestContextValidationFailureFeedbackIssueGroup[];
}

export interface BuildIterationPromptInput {
  context: GraphWorkflowResolvedContext;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: Record<string, GraphWorkflowTaskState>;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  allowAgentTaskAdd: boolean;
  allowAgentCollaboration?: boolean;
  contextValidationAcceptanceCriteria?: string;
  latestContextValidationFailure?: LatestContextValidationFailureFeedback;
  collaborationContinuations?: GraphWorkflowCollaborationContinuation[];
  charter?: WorkflowCharter;
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
        `  Address ALL issues from previous attempts before running \`cctl workflow task complete\` again.`,
      );
    } else if (failureMessage) {
      // Backward compat: fall back to single failureMessage
      lines.push(
        "",
        `  ### Previous Attempt Failed`,
        `  A previous attempt to complete this task was rejected by validation:`,
        `  ${failureMessage}`,
        "",
        `  Address the issues above before running \`cctl workflow task complete\` again.`,
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

function buildCollaborationContinuationSection(
  collaborationContinuations?: GraphWorkflowCollaborationContinuation[],
): string | null {
  if (!collaborationContinuations || collaborationContinuations.length === 0) {
    return null;
  }

  const sections = [
    "## Collaboration Results",
    "Use these collaboration outcomes while continuing the remaining tasks.",
  ];

  for (const continuation of collaborationContinuations) {
    sections.push(
      "",
      `### ${continuation.workflowId}`,
      `Brief: ${continuation.brief}`,
      `Status: ${continuation.result.status}`,
    );
    if (continuation.result.finalAnswer) {
      sections.push("", continuation.result.finalAnswer);
    }
    if (continuation.result.openConflicts.length > 0) {
      sections.push(
        "",
        "Open Conflicts:",
        ...continuation.result.openConflicts.map(
          (conflict) =>
            `- ${conflict.severity}/${conflict.category}: ${conflict.disputedPoint}`,
        ),
      );
    }
  }

  return sections.join("\n").trimEnd();
}

export function buildIterationPrompt(input: BuildIterationPromptInput): string {
  const sections: string[] = [];

  // Charter digest at the very top, before the context header (4.1, 4.3).
  if (input.charter) {
    sections.push(buildCharterSection(input.charter));
  }

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
      "Your job is to work through the tasks below in order, running `cctl workflow task complete` for each one as you finish it.",
    ].join("\n"),
  );

  const latestContextValidationFailureSection =
    buildLatestContextValidationFailureSection(
      input.latestContextValidationFailure,
    );
  if (latestContextValidationFailureSection) {
    sections.push(latestContextValidationFailureSection);
  }

  const collaborationContinuationSection =
    buildCollaborationContinuationSection(input.collaborationContinuations);
  if (collaborationContinuationSection) {
    sections.push(collaborationContinuationSection);
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
        "If the validator reopens any tasks, address the feedback and run `cctl workflow task complete` again for those reopened tasks.",
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
      `2. Run \`${COMPLETE_TASK_COMMAND}\` after finishing each task, using the task's id from the list above.`,
      "3. If `cctl workflow task complete` prints a stop instruction (CONTEXT LIMIT REACHED …), end your turn immediately — do not begin another task. The workflow continues the remaining tasks in a fresh conversation automatically.",
      "",
      "IMPORTANT: If you do not run `cctl workflow task complete`, the task remains open and blocks all workflow progress. The workflow will stall and require manual intervention.",
    ].join("\n"),
  );

  // Command reference — the lane agent's only discovery surface (doc 02 §4.3),
  // so it names the exact `cctl` invocations, not MCP tools. Run them in the
  // shell; they resolve this execution + context from the environment.
  const toolDocs: string[] = [
    "## Command Center CLI (`cctl`)",
    "Advance and interact with the workflow by running these `cctl` commands in your shell. They resolve this execution and context automatically from the environment — you never pass identity flags.",
    "",
    "### Complete a task",
    "```",
    COMPLETE_TASK_COMMAND,
    "```",
    "Run this after finishing each task — it is the only way to advance the workflow. `<taskId>` is the task's id from the list above (e.g. `task-plan-1`); the summary should cover files modified, tests added or run, and notable decisions.",
    'On success it reports how many tasks remain in this context. If it instead prints a stop instruction ("CONTEXT LIMIT REACHED … End your turn now …"), that is mandatory: stop and end your turn with a brief handoff note — the workflow resumes the remaining tasks in a fresh conversation automatically. If the run has been halted the command exits non-zero and prints the reason; stop and end your turn.',
    "",
    "### Register a shared document",
    "```",
    "cctl workflow shared-doc upsert <relativePath> --file <doc.json>",
    "```",
    'Register or update a shared document for agents in later workflow iterations. `<relativePath>` is the document\'s path relative to the worktree root; `<doc.json>` is a JSON object `{ "description": "<what it contains>", "readWhen": "<when a future agent should read it>" }` you author with the Write tool.',
  ];

  if (input.allowAgentTaskAdd) {
    toolDocs.push(
      "",
      "### Add a task",
      "```",
      'cctl workflow task add --title "<short name>" --instructions "<self-contained instructions>" [--slug <kebab-case-id>]',
      "```",
      "Append a new task to this execution context when you discover necessary work not covered by the existing tasks. `--instructions` must be self-contained for the agent that runs it; `--slug` is optional (auto-generated from the title when omitted).",
    );
  }

  if (input.allowAgentCollaboration) {
    toolDocs.push(
      "",
      "### Request a collaboration",
      "```",
      'cctl workflow collab request --brief "<the question or decision, with the context the partner needs>"',
      "```",
      "Request a structured second opinion from another agent on a consequential design decision. Use this only when you hit a genuinely ambiguous, high-impact, or hard-to-reverse trade-off where an independent perspective would materially de-risk the choice — not for routine decisions you can resolve yourself. State the problem and the context clearly in `--brief`; do not include your preferred solution. Command Center runs the collaboration asynchronously and returns a workflow id immediately — stop work on this turn and wait for the follow-up that delivers the outcome.",
    );
  }

  sections.push(toolDocs.join("\n"));

  // Shared documents — the charter has its own top section, so exclude its
  // entry from the generic list.
  const genericDocs = input.sharedDocuments.filter(
    (doc) => doc.kind !== "charter",
  );
  const docLines =
    genericDocs.length === 0
      ? ["- None registered."]
      : genericDocs.map(
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
  collaborationContinuations?: GraphWorkflowCollaborationContinuation[];
  charter?: WorkflowCharter;
}

export function buildFollowUpPrompt(input: BuildFollowUpPromptInput): string {
  const taskLines = buildTaskLines(input.remainingTasks, input.taskStates);
  const sections = [
    `You still have ${input.remainingTasks.length} incomplete task(s):`,
  ];

  // Compact charter reminder on every continuation turn (4.4). The full digest
  // is re-presented when a fresh session is re-seeded via buildIterationPrompt.
  if (input.charter) {
    sections.push(
      `Reminder: the workflow charter still governs — a higher-ranked source prevails over a lower-ranked one on conflict. Full charter: \`${CHARTER_DOCUMENT_PATH}\`.`,
    );
  }

  const latestContextValidationFailureSection =
    buildLatestContextValidationFailureSection(
      input.latestContextValidationFailure,
    );
  if (latestContextValidationFailureSection) {
    sections.push(latestContextValidationFailureSection);
  }

  const collaborationContinuationSection =
    buildCollaborationContinuationSection(input.collaborationContinuations);
  if (collaborationContinuationSection) {
    sections.push(collaborationContinuationSection);
  }

  sections.push(
    ["## Remaining Tasks", ...taskLines].join("\n"),
    `Please continue working through them in order, running \`cctl workflow task complete\` for each.`,
    `This is follow-up attempt ${input.attemptNumber} of ${input.maxAttempts}.`,
    "The workflow cannot progress until tasks are completed via `cctl workflow task complete`. Without it, the workflow will stall.",
  );

  return sections.join("\n\n");
}
