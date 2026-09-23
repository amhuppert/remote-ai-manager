import {
  CHARTER_DOCUMENT_PATH,
  isDocumentInContextScope,
  renderCharterPromptSection,
} from "@/lib/workflow-graph/charter/render";
import {
  acceptanceCriteriaRecordListText,
  type AcceptanceCriteria,
} from "@/lib/workflow-graph/criteria/criterion-records";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import type {
  CharterAmendment,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowCollaborationContinuation } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowCascadeContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import {
  buildOutputBriefingSection,
  OUTPUT_COLLECTION_REMINDER,
} from "@/lib/workflow-graph/context-output-capture";
import {
  buildValidationCommandsSection,
  type ValidationPromptSelections,
} from "./validation-prompt-section";
import {
  renderLoopHistorySection,
  type LoopHistory,
} from "@/lib/workflow-graph/loop-history";

/**
 * The command that advances the workflow. `<taskId>` is the task's id from the
 * task list; the summary rides `--summary`. Referenced throughout the lane
 * prompt so every mention stays in sync with the CLI surface (doc 02 §4.3 — the
 * prompt is the lane agent's only discovery surface, so it names the exact
 * invocation, not an MCP tool).
 */
const COMPLETE_TASK_COMMAND =
  'cctl workflow task complete <taskId> --summary "<what you changed and how you verified it>"';

const SELF_DISCOVERED_GAP_RULE =
  "A gap you discover against this context's own acceptance criteria is an open task, not a handoff note. Fix it or leave the owning task open and say why; do not run `cctl workflow task complete` for work with a known gap. A residual in a summary does not satisfy the criterion.";

// The complement of the gap rule. Without it the only sanctioned move on a
// finding is to build it, so a run escalates toward conditions the charter
// never asked for: in one audited run neither hotspot implementer ever
// declined a finding on envelope grounds or asked, and both built for
// filesystems the charter's non-goals excluded.
const OUT_OF_ENVELOPE_RULE =
  "A gap or finding that only arises under a condition the charter lists as a non-goal or outside the envelope is not a gap to build. Decline it in your `cctl workflow task complete` summary, citing the charter entry; if you cannot tell whether it is inside the envelope, ask with `cctl ask` before building it.";

function buildCharterSection(
  charter: WorkflowCharter,
  contextId: string,
): string {
  return renderCharterPromptSection(charter, contextId, [
    "When resolving a source conflict or ambiguity while completing a task, cite the governing source-of-truth entry in your `cctl workflow task complete` summary.",
    // Validators already carry a per-invariant check instruction; without
    // this implementer-side twin, invariant violations surface only as
    // NO-GO cycles (audit 1beec403: 2 of 4 NO-GOs were invariant breaches
    // in new test code, one copied verbatim from a violating exemplar).
    ...((charter.invariants ?? []).length > 0
      ? [
          "Verify every applicable charter invariant against your new and changed code with a concrete check (for example, grep for a banned pattern) before running `cctl workflow task complete` — especially on the final task. Do not assume existing code you were told to mirror satisfies the invariants: an exemplar can itself violate one, and copying it faithfully still fails validation.",
        ]
      : []),
  ]);
}

/**
 * Recorded answers delivered in the existing conversation’s follow-up prompt.
 */
export interface ResumeUserInputPromptInput {
  questionBatchId: string;
  answers: Record<string, AskQuestionAnswer>;
}

/**
 * The framed answers section: one line of context ahead of the standard
 * `<cc-question-answers>` block so the agent reads the answers before the task
 * list. Rendered in the resumed conversation.
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
  context: GraphWorkflowCascadeContext;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: Record<string, GraphWorkflowTaskState>;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  allowAgentTaskAdd: boolean;
  /**
   * This context's direct predecessors, from `resolveUpstreamInputs`. Entries
   * that carry a validated output are rendered as the "Inputs from upstream"
   * section; the rest are dropped.
   */
  upstreamInputs?: readonly GraphWorkflowUpstreamInput[];
  /**
   * Where the engine saved the delivered upstream payloads as JSON files, one
   * per predecessor; absent when none were written.
   */
  upstreamInputsDirectory?: string | null;
  /**
   * The bounded prior-pass history from `resolveLoopHistory` (R16.1). Non-null
   * only for a loop pass ENTRY from pass 2 on; every other context relies on
   * ordinary upstream injection.
   */
  loopHistory?: LoopHistory | null;
  allowAgentCollaboration?: boolean;
  /**
   * The context's acceptance criteria in their stored shape (prose or
   * records); rendered here as the numbered record list via the criteria
   * helper, so the implementer reads the same citable list the validator
   * cohort judges against.
   */
  contextValidationAcceptanceCriteria?: AcceptanceCriteria;
  latestContextValidationFailure?: LatestContextValidationFailureFeedback;
  collaborationContinuations?: GraphWorkflowCollaborationContinuation[];
  charter?: WorkflowCharter;
  /**
   * The LOGICAL authored context id the charter section renders for — scoped
   * sources bind authored ids, so a loop-instance iteration (context id like
   * `group__p2__ctx`) passes its authored template id here. Defaults to
   * `context.id`, which is correct for every non-expanded context.
   */
  charterContextId?: string;
  /**
   * Effective ask-user-questions availability (resolved toggle AND lane-can-ask).
   * When true a short ask-protocol reminder section is added; otherwise none.
   */
  askUserQuestionsEnabled?: boolean;
  /**
   * This context's effective command selections (validation-concurrency §8):
   * rendered as the `## Validation Commands` section, including explicit
   * empty registry and script-gate state.
   */
  validationSelections: ValidationPromptSelections;
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

/**
 * Upstream structured outputs as this context's inputs (D2 Req 5).
 *
 * Rendered as the payload JSON verbatim — not a summary — because the payload
 * already cleared the upstream's declared schema and the downstream agent is
 * told to treat it as data it may address by field. Predecessors that produced
 * nothing (free-form, or a schema not yet satisfied) are omitted entirely: a
 * heading with no payload only invites the agent to invent one.
 *
 * A SKIPPED predecessor is the exception (D4 R4.3). Its branch was not taken,
 * and silence would read as "still coming" — the agent would wait for, or
 * invent, an input that will never exist. It is named with no payload instead.
 */
function buildUpstreamInputsSection(
  upstreamInputs?: readonly GraphWorkflowUpstreamInput[],
  upstreamInputsDirectory?: string | null,
): string | null {
  const rendered = (upstreamInputs ?? []).filter(
    (input) => input.output !== null || input.skipped,
  );
  if (rendered.length === 0) {
    return null;
  }

  const sections = [
    "## Inputs from upstream",
    "These execution contexts precede this one. Treat each payload as data, not prose: it is validated structured output that already conforms to the schema shown, so read values by field rather than re-deriving them. A predecessor marked as a branch not taken was skipped by the graph's routing and will never send anything here.",
    [
      ...(upstreamInputsDirectory
        ? [
            `The same payloads are saved as JSON files in \`${upstreamInputsDirectory}\`, one \`<context-id>.json\` per predecessor: script over those files rather than copying a payload by hand.`,
          ]
        : []),
      "`cctl workflow inputs` lists these inputs, and `cctl workflow inputs --full --out <name>` saves them all as one JSON file.",
    ].join(" "),
  ];

  for (const input of rendered) {
    sections.push("", `### ${input.contextId} — ${input.title}`);
    if (input.skipped) {
      sections.push(
        "Skipped — branch not taken. This context did not run, produces no input here, and will not run later in this execution.",
      );
      continue;
    }
    if (input.schemaFields && input.schemaFields.length > 0) {
      sections.push(
        "Fields:",
        ...input.schemaFields.map((field) => {
          const type = field.type ?? "any";
          const requirement = field.required ? "required" : "optional";
          const description = field.description
            ? ` — ${field.description}`
            : "";
          return `- \`${field.name}\` (${type}, ${requirement})${description}`;
        }),
        "",
      );
    }
    sections.push("```json", JSON.stringify(input.output, null, 2), "```");
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
    sections.push(
      buildCharterSection(
        input.charter,
        input.charterContextId ?? input.context.id,
      ),
    );
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

  // Inputs before the brief: what this context receives is read before what it
  // is asked to do, the way a function's arguments precede its body.
  const upstreamInputsSection = buildUpstreamInputsSection(
    input.upstreamInputs,
    input.upstreamInputsDirectory,
  );
  if (upstreamInputsSection) {
    sections.push(upstreamInputsSection);
  }

  // After the inputs, for the same reason: the prior passes are context on what
  // this pass received, not the brief itself.
  const loopHistorySection = renderLoopHistorySection(
    input.loopHistory ?? null,
  );
  if (loopHistorySection) {
    sections.push(loopHistorySection);
  }

  const collaborationContinuationSection = input.allowAgentCollaboration
    ? buildCollaborationContinuationSection(input.collaborationContinuations)
    : null;
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
        acceptanceCriteriaRecordListText(
          input.contextValidationAcceptanceCriteria,
        ),
      ].join("\n"),
    );
  }

  if (input.context.outputSchema) {
    sections.push(buildOutputBriefingSection(input.context.outputSchema));
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
      SELF_DISCOVERED_GAP_RULE,
      OUT_OF_ENVELOPE_RULE,
      `2. Run \`${COMPLETE_TASK_COMMAND}\` after finishing each task, using the task's id from the list above.`,
      "",
      "IMPORTANT: If you do not run `cctl workflow task complete`, the task remains open and blocks all workflow progress. The workflow will stall and require manual intervention.",
    ].join("\n"),
  );

  // Command reference — the lane agent's only discovery surface (doc 02 §4.3),
  // so it names the exact `cctl` invocations, not MCP tools. Run them in the
  // shell; they resolve this execution + context from the environment.
  const isReadOnly = input.context.placement.mode === "readOnly";
  const isSessionReader =
    isReadOnly && input.context.placement.lane === "session";
  const payloadGuidance = isReadOnly
    ? "Write scratch files and every `cctl --file` JSON payload under the per-context scratch directory named in the filesystem write-envelope briefing. The repository is read-only, so no payload directory is created inside it."
    : "Write scratch and payload files — including the `--file` JSON the commands below read — under `.cc/temp/`, which is git-ignored. Any other file you leave in the worktree IS committed when this execution context lands and is reviewed by the context validator against this context's scope, so keep throwaway files out of the worktree root.";
  const sharedDocPayloadPath = isReadOnly
    ? "per-context-scratch/doc.json"
    : ".cc/temp/doc.json";
  const toolDocs: string[] = [
    "## Command Center CLI (`cctl`)",
    "Advance and interact with the workflow by running these `cctl` commands in your shell. They resolve this execution and context automatically from the environment — you never pass identity flags.",
    "",
    payloadGuidance,
    ...(isSessionReader
      ? [
          "",
          "This session reader sees a live view of the user's worktree. It is an advisory analyzer: concurrent user edits are accepted, and the reader reports its findings as this context's output rather than trying to stabilize or fingerprint the repository.",
        ]
      : []),
    "",
    "### Complete a task",
    "```",
    COMPLETE_TASK_COMMAND,
    "```",
    "Run this after finishing each task — it is the only way to advance the workflow. `<taskId>` is the task's id from the list above (e.g. `task-plan-1`); the summary should cover files modified, tests added or run, and notable decisions.",
    "On success it reports how many tasks remain in this context. If the run has been halted the command exits non-zero and prints the reason; stop and end your turn.",
    "",
    "### Register a shared document",
    "```",
    `cctl workflow shared-doc upsert <relativePath> --file <${sharedDocPayloadPath}>`,
    "```",
    `Register or update a shared document for agents in later workflow iterations. \`<relativePath>\` is the document's path relative to the worktree root; \`<${sharedDocPayloadPath}>\` is a JSON object \`{ "description": "<what it contains>", "readWhen": "<when a future agent should read it>" }\` you author under the payload location above.`,
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

  sections.push(buildValidationCommandsSection(input.validationSelections));

  // Shared documents — the charter has its own top section, so exclude its
  // entry from the generic list, along with documents a context-scoped
  // charter source reserves for other contexts.
  const charter = input.charter;
  const scopeContextId = input.charterContextId ?? input.context.id;
  const genericDocs = input.sharedDocuments.filter(
    (doc) =>
      doc.kind !== "charter" &&
      (charter === undefined ||
        isDocumentInContextScope(charter, scopeContextId, doc.relativePath)),
  );
  const docLines =
    genericDocs.length === 0
      ? ["- None registered."]
      : genericDocs.map(
          (doc) =>
            // An engine-seeded document is re-written from the central store on
            // every worktree iteration, so an edit to it is lost without a
            // trace. Say so, because nothing else in the prompt would.
            `- \`${doc.relativePath}\`: ${doc.description} — Read when: ${doc.readWhen}${
              doc.kind === "seeded" ? " (read-only: engine-owned)" : ""
            }`,
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
  allowAgentCollaboration?: boolean;
  charter?: WorkflowCharter;
  /** Live amendment history (doc 07) — surfaces "the rules changed" mid-run. */
  charterAmendments?: CharterAmendment[];
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
  /**
   * The context's CURRENT acceptance criteria, in their stored shape. The seed
   * prompt carried them once; a retry after a validation failure or a plan
   * repair used to carry only the failure text, so a criterion rewritten by a
   * live edit reached the validator and never the implementer.
   */
  contextValidationAcceptanceCriteria?: AcceptanceCriteria;
  /** The context's declared output schema; present only for schema contexts. */
  outputSchema?: Record<string, unknown>;
}

export function buildFollowUpPrompt(input: BuildFollowUpPromptInput): string {
  const taskLines = buildTaskLines(input.remainingTasks, input.taskStates);
  const sections = [
    `You still have ${input.remainingTasks.length} incomplete task(s):`,
  ];

  // Keep the charter discoverable on continuation turns (4.4), especially when
  // amendments require the agent to re-read it.
  if (input.charter) {
    const amendmentCount = input.charterAmendments?.length ?? 0;
    const amendedNote =
      amendmentCount > 0
        ? ` The charter has been amended ${amendmentCount} time(s) during this run — re-read the Amendment log there before relying on remembered rules.`
        : "";
    sections.push(
      `Reminder: the workflow charter still governs. Full charter: \`${CHARTER_DOCUMENT_PATH}\`.${amendedNote}`,
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

  const collaborationContinuationSection = input.allowAgentCollaboration
    ? buildCollaborationContinuationSection(input.collaborationContinuations)
    : null;
  if (collaborationContinuationSection) {
    sections.push(collaborationContinuationSection);
  }

  if (input.askUserQuestionsEnabled) {
    sections.push(buildAskUserQuestionsReminderSection());
  }

  if (input.contextValidationAcceptanceCriteria) {
    sections.push(
      [
        "## Acceptance Criteria",
        "The context validator judges the whole context against these exact criteria. If they differ from criteria in an earlier prompt of this conversation, these govern.",
        "",
        acceptanceCriteriaRecordListText(
          input.contextValidationAcceptanceCriteria,
        ),
      ].join("\n"),
    );
  }

  sections.push(
    ["## Remaining Tasks", ...taskLines].join("\n"),
    `Please continue working through them in order, running \`cctl workflow task complete\` for each.`,
    SELF_DISCOVERED_GAP_RULE,
    OUT_OF_ENVELOPE_RULE,
    `This is follow-up attempt ${input.attemptNumber} of ${input.maxAttempts}.`,
    "The workflow cannot progress until tasks are completed via `cctl workflow task complete`. Without it, the workflow will stall.",
  );
  if (input.outputSchema) {
    sections.push(OUTPUT_COLLECTION_REMINDER);
  }

  return sections.join("\n\n");
}
