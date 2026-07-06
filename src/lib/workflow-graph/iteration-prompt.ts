import {
  CHARTER_DOCUMENT_PATH,
  renderCharterPromptSection,
} from "@/lib/workflow-graph/charter/render";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
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

/**
 * The recorded answers delivered into a resumed turn. Carried into both the
 * pinned follow-up prompt and the rotated seed prompt; the answers block echoes
 * the original question text, so a fresh conversation is self-sufficient (5.3).
 */
export interface ResumeUserInputPromptInput {
  questionBatchId: string;
  answers: Record<string, AskQuestionAnswer>;
}

/**
 * The framed answers section: one line of context ahead of the standard
 * `<cc-question-answers>` block so the agent reads the answers before the task
 * list. Rendered identically in the pinned and rotated variants.
 */
function buildResumeUserInputSection(
  resumeUserInput: ResumeUserInputPromptInput,
): string {
  return [
    "## Your Question Was Answered",
    "The user answered the question(s) you asked. Use these answers to continue:",
    "",
    formatQuestionAnswersBlock(
      resumeUserInput.questionBatchId,
      resumeUserInput.answers,
    ),
  ].join("\n");
}

/**
 * Short in-prompt reminder of the ask protocol, added only when the context's
 * effective ask-user-questions flag is on (resolved toggle AND lane-can-ask).
 * The full protocol lives in the session instructions
 * (`ASK_QUESTION_INSTRUCTIONS_ENABLED`); this keeps the salient rules — the
 * tool is available, ask only at real forks, end the turn, the context PAUSES
 * until answered, skipped = best judgment — in view of every iteration and
 * validator prompt. Shared by the implementer and validator prompt builders so
 * there is one source of the reminder text (Req 8.1-8.4).
 */
export function buildAskUserQuestionsReminderSection(): string {
  return [
    "## Asking the User",
    "The `cctl ask` tool is available on this turn. Ask ONLY at a consequential, hard-to-reverse, or genuinely ambiguous decision point — not for trivial or reversible choices. Batch related questions into one `cctl ask` call, then END YOUR TURN. The workflow PAUSES this context until the user answers (asking is not free), and the answers arrive when this context resumes; a skipped question means proceed with your best judgment.",
  ].join("\n");
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
  /**
   * Answers delivered into a rotated resume: the asking conversation reached its
   * context-window limit, so this fresh (seed) conversation carries the block in
   * its first prompt (5.3).
   */
  resumeUserInput?: ResumeUserInputPromptInput;
  /**
   * Effective ask-user-questions availability (resolved toggle AND lane-can-ask).
   * When true a short ask-protocol reminder section is added; otherwise none.
   */
  askUserQuestionsEnabled?: boolean;
  /**
   * Final handoff message of the conversation this seed replaces after a
   * context-window rotation. Injected verbatim so environment gotchas,
   * workarounds, and in-flight state survive the rotation boundary instead of
   * depending on the agent re-deriving them from the worktree.
   */
  previousConversationHandoff?: {
    conversationId: string;
    note: string;
  };
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

  // Answers first: a rotated resume seeds a fresh conversation, so the block
  // opens the prompt (after the header) before the task list (5.3).
  if (input.resumeUserInput) {
    sections.push(buildResumeUserInputSection(input.resumeUserInput));
  }

  if (input.previousConversationHandoff) {
    sections.push(
      [
        "## Handoff from the previous conversation",
        "This context's previous conversation reached its context limit and was rotated out. Its final handoff (verbatim):",
        "",
        input.previousConversationHandoff.note,
      ].join("\n"),
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

  if (input.askUserQuestionsEnabled) {
    sections.push(buildAskUserQuestionsReminderSection());
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
    'On success it reports how many tasks remain in this context. If it instead prints a stop instruction ("CONTEXT LIMIT REACHED … End your turn now …"), that is mandatory: stop and end your turn with the handoff note it requests — your final message is delivered verbatim to the fresh conversation that resumes the remaining tasks automatically. If the run has been halted the command exits non-zero and prints the reason; stop and end your turn.',
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
  /**
   * Answers delivered into a pinned resume: the asking conversation is reused,
   * so the block rides its follow-up prompt (5.1).
   */
  resumeUserInput?: ResumeUserInputPromptInput;
  /**
   * Effective ask-user-questions availability (resolved toggle AND lane-can-ask).
   * When true a short ask-protocol reminder section is added; otherwise none.
   */
  askUserQuestionsEnabled?: boolean;
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

  // Answers first so the agent reads them before the remaining task list (5.1).
  if (input.resumeUserInput) {
    sections.push(buildResumeUserInputSection(input.resumeUserInput));
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

  if (input.askUserQuestionsEnabled) {
    sections.push(buildAskUserQuestionsReminderSection());
  }

  sections.push(
    ["## Remaining Tasks", ...taskLines].join("\n"),
    `Please continue working through them in order, running \`cctl workflow task complete\` for each.`,
    `This is follow-up attempt ${input.attemptNumber} of ${input.maxAttempts}.`,
    "The workflow cannot progress until tasks are completed via `cctl workflow task complete`. Without it, the workflow will stall.",
  );

  return sections.join("\n\n");
}
