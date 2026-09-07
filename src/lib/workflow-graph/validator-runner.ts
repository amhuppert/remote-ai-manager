import { z } from "zod";
import {
  workflowAdvisoryValidatorResultSchema,
  workflowBlockingValidatorResultSchema,
  workflowValidatorOutputPlanDefectSchema,
} from "@/lib/workflow-graph/definition-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  acceptanceCriteriaRecordListText,
  criterionRecordsOf,
} from "@/lib/workflow-graph/criteria/criterion-records";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { renderCharterPromptSection } from "@/lib/workflow-graph/charter/render";
import {
  resolveLogicalAuthoredContextId,
  resolveScopedCharterForContext,
} from "@/lib/workflow-graph/charter/invariant-scope";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import { readConversationTelemetry } from "@/lib/workflow-graph/conversation-telemetry";
import {
  buildGraphWorkflowValidationReviewArtifact,
  type GraphWorkflowExecution,
  type GraphWorkflowLaneKind,
  type GraphWorkflowValidationConversationUsage,
  type GraphWorkflowValidationReviewArtifact,
  type GraphWorkflowValidationSessionRef,
} from "@/lib/workflow-graph/schemas";
import {
  isAcceptanceCriteriaValidatorProfile,
  selectRunnableCohortAssignments,
  type ValidatorAssignment,
  type ValidatorAuthority,
} from "@/lib/workflow-graph/config-schemas";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  assignmentFingerprint,
  laneStateKey,
} from "@/lib/workflow-graph/lane-identity";
import {
  buildValidatorRoleContract,
  composeWorkflowRoleInstructions,
} from "@/lib/workflow-graph/role-instructions";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type {
  GraphWorkflowCascadeContext,
  GraphWorkflowTaskDefinition,
  WorkflowValidatorAdvisory,
  WorkflowValidatorIssue,
  WorkflowValidatorPlanDefect,
} from "@/lib/workflow-graph/definition-schemas";
import {
  adaptValidatorTaskResult,
  classifyGraphDispatchFailure,
} from "./conversation-turn-result";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import { buildAskUserQuestionsReminderSection } from "./iteration-prompt";
import {
  createRegisteredGraphExecutionContract,
  type GraphExecutionContract,
} from "./execution-contract-port";
import { composeGraphRolePrompt } from "./prompt-composer";
import {
  buildValidationCommandsSection,
  buildValidatorDeterministicChecksGuidance,
  loadValidationPromptRegistry,
  resolveValidationPromptSelections,
  type ValidationPromptSelections,
} from "./validation-prompt-section";
import { readRepoConfig } from "@/lib/projects/repo-config";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { LaneConversationPendingState } from "./user-input-gate";

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type {
  GraphWorkflowContextValidatorInput,
  RenderRoundCommonSectionsInput,
  ValidationRoundCommonSections,
  ValidationRoundToken,
} from "./execution-validation";
import type {
  ResolveValidatorCallInput,
  ResolvedValidatorCall,
  RecordLaneTurnOutcomeInput,
  ValidatorExecutionStrategy,
} from "@/lib/workflow-graph/lane-continuity";
import {
  executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun,
  type ExecuteWorkflowTaskRunInput,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import {
  composeValidatorLaneWriteEnvelope as defaultComposeValidatorLaneWriteEnvelope,
  type ComposeValidatorLaneWriteEnvelopeInput,
  type ValidatorLaneWriteEnvelope,
} from "@/lib/workflow-graph/lane-write-policy";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { ConversationBinding } from "@/lib/workflows/conversation/turn-spec";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { getConversation as defaultGetConversation } from "@/lib/state-store";
import {
  candidateScopeForPlacement,
  computeValidationDiffScope as defaultComputeValidationDiffScope,
  diffScopeTreeHash,
  renderDiffScopeSection,
  type ValidationDiffScope,
} from "./validation-diff-scope";
import type { CandidateScope } from "@/lib/git/diff";
import {
  validateStructuredOutput,
  type StructuredOutputSource,
} from "@/lib/agent-backends/structured-output";

/**
 * The advisory item both authorities emit, closed to anything else. No
 * `taskId`: an advisory is addressed to the implementer rather than to a task
 * the engine must reopen.
 */
const ADVISORY_ITEMS_OUTPUT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["implementation", "plan", "out_of_scope"],
      },
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["kind", "title", "description"],
    additionalProperties: false,
  },
} as const;

/**
 * The plan-defect item only a blocking seat may emit: the contract itself is
 * unsatisfiable here, so there is nothing to reopen.
 *
 * Projected from the Zod contract rather than hand-written, so the gate the
 * provider enforces and the twin the runner parses cannot drift: the four
 * fields, their non-emptiness, and the closed object all have one source. The
 * absence of a `taskId` property is what makes this response structurally
 * distinct from an issue rather than a differently-worded one.
 *
 * `$schema` is dropped because this is embedded as a SUBSCHEMA of the dispatched
 * validator schema, where a nested dialect declaration is a keyword the
 * provider's schema validator never asked for.
 */
const { $schema: _planDefectDialect, ...PLAN_DEFECT_ITEMS_OUTPUT_SCHEMA } =
  z.toJSONSchema(z.array(workflowValidatorOutputPlanDefectSchema));

/**
 * The structured-output schema for one validator dispatch, selected by the
 * seat's authority and bound to the context it is reviewing.
 *
 * Two properties are load-bearing. Authority is STRUCTURAL: neither `issues`
 * nor `planDefects` appears in the advisory schema, so a validator with no
 * blocking authority can neither fail a context nor route one to plan repair —
 * the attempt fails the output gate and retries rather than reaching the engine
 * as a verdict. And `taskId` is an enum of this context's task ids, so an id the
 * validator invented is caught at the same gate, where a retry can fix it,
 * instead of arriving as a well-formed verdict the runner can only reject as an
 * infrastructure failure.
 *
 * `planDefects` is the one optional field on the verdict: `issues` and
 * `advisories` stay required because their empty arrays carry meaning (a
 * pass, and a considered absence of observations), while requiring the rare
 * third response would make every clean verdict declare it.
 *
 * `criterionId` is bound to the context's criterion-record ids exactly as
 * `taskId` is bound to its task ids, and the citation rule decides whether an
 * issue must carry it (#69 change 4 seat table): the acceptance seat judges
 * the criteria themselves, so its issues cite one; a specialist's blocking
 * basis is its assigned mandate, so a criterion id appears only when a
 * mandate finding also contradicts a specific criterion.
 */
export function buildValidatorOutputSchema(input: {
  authority: ValidatorAuthority;
  taskIds: readonly string[];
  criterionIds: readonly string[];
  issueCriterionCitation: IssueCriterionCitation;
}): Record<string, unknown> {
  if (input.authority === "advisory") {
    return {
      type: "object",
      properties: {
        summary: { type: "string" },
        advisories: ADVISORY_ITEMS_OUTPUT_SCHEMA,
      },
      required: ["summary", "advisories"],
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // An empty enum matches nothing and providers refuse it outright,
            // so a context with no ids to name falls back to a free-form
            // field rather than dispatching an unsatisfiable schema.
            taskId: {
              type: "string",
              ...(input.taskIds.length > 0 ? { enum: [...input.taskIds] } : {}),
            },
            criterionId: {
              type: "string",
              ...(input.criterionIds.length > 0
                ? { enum: [...input.criterionIds] }
                : {}),
            },
            title: { type: "string" },
            description: { type: "string" },
          },
          required:
            input.issueCriterionCitation === "required"
              ? ["taskId", "criterionId", "title", "description"]
              : ["taskId", "title", "description"],
          additionalProperties: false,
        },
      },
      advisories: ADVISORY_ITEMS_OUTPUT_SCHEMA,
      planDefects: PLAN_DEFECT_ITEMS_OUTPUT_SCHEMA,
    },
    required: ["summary", "issues", "advisories"],
    additionalProperties: false,
  };
}

/**
 * Whether a seat's blocking issues must each cite a criterion id, derived
 * from what the seat is assigned to judge: the default blocking
 * general-reviewer (the acceptance seat) judges the criteria themselves, so
 * its citation is required; every other seat cites its own mandate and
 * carries a criterion id only incidentally. Advisory seats emit no issues at
 * all, so the value is inert for them.
 */
export type IssueCriterionCitation = "required" | "optional";

export function issueCriterionCitationFor(
  validator: Pick<ValidatorAssignment, "authority" | "profile">,
): IssueCriterionCitation {
  return validator.authority === "blocking" &&
    isAcceptanceCriteriaValidatorProfile(validator.profile)
    ? "required"
    : "optional";
}

export interface BuildContextValidationPromptInput {
  context: GraphWorkflowCascadeContext;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: GraphWorkflowExecution["taskStates"];
  outputCandidate?: GraphWorkflowExecution["contextOutputs"][string];
  validator: ValidatorAssignment;
  // Optional because the resolved context carries an optional charter; when
  // present the digest is prepended so the prompt opens with it (4.2).
  charter?: WorkflowCharter;
  /**
   * The LOGICAL authored context id the charter section renders for — scoped
   * sources bind authored ids, so a loop-instance validation (context id like
   * `group__p2__ctx`) passes its authored template id here. Defaults to
   * `context.id`, which is correct for every non-expanded context.
   */
  charterContextId?: string;
  // Pre-rendered "Changes under review" section anchoring the validator on the
  // context's diff. Inserted after the acceptance criteria. Omitted when scope
  // computation is disabled or fails to produce a section.
  diffScopeSection?: string;
  // Answers delivered into a validator resume: the asking validator conversation
  // is reused (pinned) or, on rotation, a fresh one carries the block. Either
  // way the re-run validator reads the answers before rendering its verdict
  // (5.1, 5.3). The block echoes the question text, so it is self-sufficient.
  resumeUserInput?: {
    questionBatchId: string;
    answers: Record<string, AskQuestionAnswer>;
  };
  /**
   * Effective ask-user-questions availability for this validator turn. It is
   * enabled only for a conversation strategy whose backend declares native
   * mid-turn asking (see `resolveValidatorAskUserQuestionsEnabled`). When true
   * a short ask-protocol reminder section is added; otherwise none (Req
   * 8.1-8.4).
   */
  askUserQuestionsEnabled?: boolean;
  /**
   * This context's effective command selections (validation-concurrency §7/§8):
   * drives the `## Validation Commands` section and makes the deterministic-
   * checks guidance name the actual script-gate selection.
   */
  validationSelections: ValidationPromptSelections;
}

/**
 * The effective ask-user-questions flag for a context validator turn: the
 * context's resolved toggle AND a conversation strategy whose backend supports
 * native mid-turn asking (Req 8.1). Pure so the suppression rule is
 * unit-testable in isolation.
 */
export function resolveValidatorAskUserQuestionsEnabled(
  validator: ValidatorAssignment,
  context: GraphWorkflowCascadeContext,
): boolean {
  return (
    validator.strategy === "conversation" &&
    context.askUserQuestions.enabled &&
    getBackendDescriptor(validator.agent.backend).conversation?.capabilities
      .nativeMidTurnAskUser === true
  );
}

function buildCharterSection(
  charter: WorkflowCharter,
  contextId: string,
): string {
  return renderCharterPromptSection(charter, contextId);
}

function formatTaskBlock(
  task: GraphWorkflowTaskDefinition,
  taskStates: GraphWorkflowExecution["taskStates"],
): string {
  const taskState = taskStates[task.id];
  const summary = taskState?.summary?.trim() || "No summary recorded.";
  return [
    `- **Task ID**: \`${task.id}\``,
    `  - Title: ${task.title}`,
    `  - Instructions: ${task.instructions}`,
    `  - Stored Summary: ${summary}`,
  ].join("\n");
}

/**
 * The output fields this seat's authority actually admits, described in the
 * prompt exactly as the dispatched schema enforces them. An advisory seat is
 * never told about `issues` or `planDefects`: its schema has neither field, so
 * describing one would only produce verdicts that fail the output gate and burn
 * retries.
 *
 * The blocking branch names all three responses because the enumeration is what
 * a seat reads as the list of things it may say. Leaving `planDefects` out —
 * and calling an empty `issues` array a pass without qualification — would
 * describe a two-response contract the schema and the round conclusion no
 * longer implement.
 *
 * The issue line matches the seat's citation rule so the tuple a seat reads
 * is the tuple its dispatched schema enforces.
 */
function requiredOutputFieldLines(
  authority: ValidatorAuthority,
  issueCriterionCitation: IssueCriterionCitation,
): string[] {
  const advisories =
    "- `advisories` (array of `{ kind, title, description }`, `kind` one of `implementation` | `plan` | `out_of_scope`): Non-blocking observations delivered to the implementer, who may act on them or decline. An advisory carries no `taskId`, reopens nothing, and may name matters outside this context — use `out_of_scope` for those. Emit an empty array when you have none.";

  if (authority === "advisory") {
    return [
      advisories,
      "",
      "You have no blocking authority in this round: your findings never reopen a task and never fail this context. Report everything you found as advisories.",
    ];
  }

  const issues =
    issueCriterionCitation === "required"
      ? "- `issues` (array of `{ taskId, criterionId, title, description }`): Each issue must reference the `taskId` of the task that needs to be reopened to address it, and must cite the acceptance criterion it fails — set `criterionId` to the violated criterion's id from the numbered Acceptance Criteria list above. If the same problem touches multiple tasks in this context, include one issue entry per affected task (duplicate the entry with each distinct `taskId`)."
      : "- `issues` (array of `{ taskId, title, description, criterionId? }`): Each issue must reference the `taskId` of the task that needs to be reopened to address it. Your blocking basis is your assigned mandate, not the acceptance criteria: include `criterionId` (a criterion's id from the numbered Acceptance Criteria list above) only when your finding also contradicts that specific criterion — you are not required to map your findings onto criteria. If the same problem touches multiple tasks in this context, include one issue entry per affected task (duplicate the entry with each distinct `taskId`).";

  return [
    issues,
    advisories,
    "- `planDefects` (optional array of `{ title, description, whyNotLocallyRemediable, conflictingContract }`): The contract itself is the defect — no task in this context can remedy it. A plan defect carries no `taskId` and reopens nothing; `whyNotLocallyRemediable` states why the remedy is not local, and `conflictingContract` names the criterion clause, boundary, dependency, or governance rule in conflict. Omit the field entirely when you have none. Your role contract above says when this response is the right one.",
    "",
    "An empty `issues` array is a pass only when you report no plan defect: a plan defect stops this context whatever `issues` holds, and your issues travel with it as evidence rather than as reopens. Otherwise a non-empty `issues` array means every referenced task will be reopened. Advisories never reopen anything, whatever the other arrays hold.",
  ];
}

export function buildContextValidationPrompt(
  input: BuildContextValidationPromptInput,
): string {
  const orderedTasks = [...input.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const taskList = orderedTasks
    .map((task) => formatTaskBlock(task, input.taskStates))
    .join("\n");

  const charterSection = input.charter
    ? `${buildCharterSection(
        input.charter,
        input.charterContextId ?? input.context.id,
      )}\n\n`
    : "";

  // A validator resume opens with the answers so the re-run validator reads them
  // before its verdict; framed identically to the implementer variant (5.1, 5.3).
  const resumeUserInputLines = input.resumeUserInput
    ? [
        "## Your Question Was Answered",
        "The user answered the question(s) you asked. Use these answers to continue:",
        "",
        formatQuestionAnswersBlock(
          input.resumeUserInput.questionBatchId,
          input.resumeUserInput.answers,
        ),
        "",
      ]
    : [];

  const askUserQuestionsLines = input.askUserQuestionsEnabled
    ? [buildAskUserQuestionsReminderSection(), ""]
    : [];

  const validationSectionLines = [
    buildValidationCommandsSection(input.validationSelections),
    "",
  ];

  // Active checking, not preamble: rendered only when the scoped charter
  // declares invariants so the guidance never references a section that isn't there.
  const invariantGuidanceLines =
    input.charter?.invariants && input.charter.invariants.length > 0
      ? [
          "- **Check every applicable charter invariant.** The charter above declares the invariants that apply to this context's changes. Verify each one actually holds in the implementation; when one is violated, raise an issue and cite the invariant id in the issue description. An invariant that describes how the work was produced (a failing test written first, a command order) rather than what must be true of the result is satisfied whenever the outcome it protects holds: never raise an issue for missing process evidence.",
        ]
      : [];

  return [
    charterSection + "# Context Validation",
    "",
    ...resumeUserInputLines,
    ...askUserQuestionsLines,
    "You are a validation agent reviewing a completed execution context in a graph workflow.",
    "You must inspect files and verify the agent's claims.",
    "Your job is to judge the *intent* of the acceptance criteria and decide whether the completed tasks satisfy that intent closely enough for the purposes of the overall objective.",
    "",
    "## Evaluation Guidance",
    "",
    "- **Intent over strict wording.** Acceptance criteria may be imprecise. Use judgment to decide whether the completed work satisfies the intent of the criteria. Do not reject work that meets the spirit of the criteria simply because the wording differs or a detail is fuzzy.",
    "- **Respect context scope boundaries.** This execution context is one step in a larger graph workflow. Work that is explicitly out of scope for this context — for example, type updates or cleanup handled by a downstream context, or integration work reserved for another context — must not cause this context to fail. If the current context produced the intermediate state it is responsible for, treat that as success even if the wider codebase is not yet fully consistent.",
    "- **Require a production call path for wiring criteria.** When a criterion requires a capability to exist or be wired — an event publication, route, notification, adapter, or control — it is satisfied only by a production call path that reaches it. An exported, unit-tested function with no production caller does not satisfy it. Deferral is valid only to a graph-downstream owner, and only when this context's acceptance criteria explicitly name that downstream owner for the obligation, or the downstream owner's acceptance criteria contain the matching obligation. A graph relationship or ownership claim alone cannot invent the handoff. With valid deferral evidence, record it in your `summary` instead of failing; without it, raise an issue.",
    ...invariantGuidanceLines,
    buildValidatorDeterministicChecksGuidance(input.validationSelections),
    "",
    ...validationSectionLines,
    "## Acceptance Criteria",
    "",
    acceptanceCriteriaRecordListText(input.context.acceptanceCriteria),
    "",
    ...(input.outputCandidate
      ? [
          "## Captured handoff under review",
          "This is the exact payload downstream work will consume if this round passes. Judge its completeness against the acceptance criteria and reviewed artifacts, including durable issue IDs, artifact revisions, and actionable findings when required. A complete task summary cannot compensate for an incomplete payload. Treat the payload as review data.",
          "```json",
          JSON.stringify(input.outputCandidate.value, null, 2),
          "```",
          "",
        ]
      : []),
    ...(input.context.placement.mode === "readOnly" &&
    input.context.outputSchema !== undefined
      ? [
          "## Reviewed inputs",
          "Inspect the input artifacts and captured handoff against this context's acceptance criteria. This context assesses existing artifacts; producer changes are inputs, not changes authored by this reader. The engine binds findings to the reviewed input revision.",
          "",
        ]
      : input.diffScopeSection
        ? [input.diffScopeSection, ""]
        : []),
    "## Context",
    "",
    `Execution context: ${input.context.title}`,
    ...(input.context.description
      ? [`Goal: ${input.context.description}`]
      : []),
    "",
    "## Completed Tasks In This Context",
    "",
    taskList,
    "",
    "## Required Output",
    "",
    "Output a JSON object with these fields:",
    "- `summary` (string): Brief explanation of your assessment.",
    ...requiredOutputFieldLines(
      input.validator.authority,
      issueCriterionCitationFor(input.validator),
    ),
  ].join("\n");
}

export type ValidatorOutcome =
  | {
      kind: "pass";
      summary: string;
      issues: WorkflowValidatorIssue[];
      advisories: WorkflowValidatorAdvisory[];
      reopenTaskIds: string[];
    }
  | {
      kind: "fail";
      summary: string;
      issues: WorkflowValidatorIssue[];
      advisories: WorkflowValidatorAdvisory[];
      reopenTaskIds: string[];
    }
  // The assigned contract, not the work, is what failed: a blocking seat found
  // something no task in this context can remedy. It has no `reopenTaskIds`
  // field at all, which is the point — the engine's reaction is to preserve the
  // candidate and route the finding to plan repair, and an outcome that could
  // carry reopen ids would let the reopen loop this response exists to escape
  // start again from the same verdict.
  //
  // `issues` rides along when the same verdict also raised some. They are
  // evidence of what the seat saw, not instructions: nothing derives a reopen
  // from them while the defect stands.
  | {
      kind: "plan_defect";
      summary: string;
      planDefects: WorkflowValidatorPlanDefect[];
      issues: WorkflowValidatorIssue[];
      advisories: WorkflowValidatorAdvisory[];
      engine: AgentBackendId;
    }
  | {
      kind: "infra_error";
      reason: "exception" | "unparseable" | "schema_mismatch";
      message: string;
      engine: AgentBackendId;
    }
  // The validator turn ended with a pending question batch on its lane
  // conversation and no verdict. Detected before verdict parsing (a pending
  // question would otherwise surface as an unparseable verdict) and mapped by
  // the orchestrator to the awaiting-user-input park path — never to the inline
  // validation-failure accounting (Req 3.2, 3.3).
  | {
      kind: "asked_user";
      conversationId: string;
      questionBatchId: string;
      questions: AskQuestionItem[];
    }
  // The turn never started: the global query semaphore never admitted it. This
  // is PRE-admission, which is the whole reason it is not an `infra_error` — no
  // provider was reached, nothing about the validator or its inputs is known to
  // be wrong, and the only fact established is that the engine is busy. A cohort
  // charging a specialist attempt for this would spend the specialist's retry
  // budget on queue depth (D5).
  | {
      kind: "queue_admission_timeout";
      message: string;
      engine: AgentBackendId;
    };

function validateIssueTaskIds(
  issues: WorkflowValidatorIssue[],
  allowedTaskIds: Set<string> | null,
): string | null {
  if (!allowedTaskIds) return null;
  const invalidTaskIds = issues
    .map((issue) => issue.taskId)
    .filter((taskId) => !allowedTaskIds.has(taskId));
  if (invalidTaskIds.length === 0) {
    return null;
  }
  return `Validator issues referenced tasks outside the context: ${invalidTaskIds.join(", ")}`;
}

/**
 * The criterion twin of {@link validateIssueTaskIds}, plus the per-seat
 * requirement the shared parse twin cannot carry: one Zod contract serves
 * every blocking seat, so the acceptance seat's "every issue cites a
 * criterion" rule has to be applied here, where the dispatch knows which seat
 * it is parsing for.
 */
function validateIssueCriterionIds(
  issues: WorkflowValidatorIssue[],
  allowedCriterionIds: Set<string> | null,
  requireIssueCriterionId: boolean,
): string | null {
  if (requireIssueCriterionId) {
    const missing = issues.filter((issue) => issue.criterionId === undefined);
    if (missing.length > 0) {
      return `Validator issues omitted the required criterionId: ${missing
        .map((issue) => issue.title)
        .join(", ")}`;
    }
  }
  if (!allowedCriterionIds) return null;
  const invalidCriterionIds = issues
    .map((issue) => issue.criterionId)
    .filter(
      (criterionId): criterionId is string =>
        criterionId !== undefined && !allowedCriterionIds.has(criterionId),
    );
  if (invalidCriterionIds.length === 0) {
    return null;
  }
  return `Validator issues referenced criteria outside the context: ${invalidCriterionIds.join(", ")}`;
}

function validatorOutcomeLogFields(outcome: ValidatorOutcome): {
  issueCount: number;
  reopenTaskIds: string[];
} {
  if (outcome.kind === "pass" || outcome.kind === "fail") {
    return {
      issueCount: outcome.issues.length,
      reopenTaskIds: outcome.reopenTaskIds,
    };
  }
  // A plan defect reopens nothing, so the reopen list is empty as a fact about
  // the outcome rather than as the absence of one.
  if (outcome.kind === "plan_defect") {
    return { issueCount: outcome.issues.length, reopenTaskIds: [] };
  }
  return { issueCount: 0, reopenTaskIds: [] };
}

function deriveReopenTaskIds(issues: WorkflowValidatorIssue[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const issue of issues) {
    if (seen.has(issue.taskId)) continue;
    seen.add(issue.taskId);
    ordered.push(issue.taskId);
  }
  return ordered;
}

function wireResultToOutcome(
  result: {
    summary: string;
    issues?: WorkflowValidatorIssue[];
    advisories: WorkflowValidatorAdvisory[];
    planDefects?: WorkflowValidatorPlanDefect[];
  },
  engine: AgentBackendId,
  allowedTaskIds: Set<string> | null,
  allowedCriterionIds: Set<string> | null,
  requireIssueCriterionId: boolean,
): ValidatorOutcome {
  // Both absent for an advisory assignment, whose schema has neither field.
  const issues = result.issues ?? [];
  const planDefects = result.planDefects ?? [];
  // Only issues are checked against the context's task and criterion sets.
  // Advisories and plan defects pass through untouched — neither names a task
  // or a criterion — which is what keeps an out-of-context observation from
  // taking the infra_error path and spending one of the lane's attempts.
  const invalidIssueTaskIds = validateIssueTaskIds(issues, allowedTaskIds);
  if (invalidIssueTaskIds) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message: invalidIssueTaskIds,
      engine,
    };
  }
  const invalidIssueCriterionIds = validateIssueCriterionIds(
    issues,
    allowedCriterionIds,
    requireIssueCriterionId,
  );
  if (invalidIssueCriterionIds) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message: invalidIssueCriterionIds,
      engine,
    };
  }

  // Precedence over issues, not coexistence with them: a task reopened to
  // satisfy a contract the same verdict calls unsatisfiable is the unfair work
  // this outcome exists to stop, so the defect decides the round and the issues
  // travel with it as evidence.
  if (planDefects.length > 0) {
    return {
      kind: "plan_defect",
      summary: result.summary,
      planDefects,
      issues,
      advisories: result.advisories,
      engine,
    };
  }

  if (issues.length === 0) {
    return {
      kind: "pass",
      summary: result.summary,
      issues: [],
      advisories: result.advisories,
      reopenTaskIds: [],
    };
  }

  return {
    kind: "fail",
    summary: result.summary,
    issues,
    advisories: result.advisories,
    reopenTaskIds: deriveReopenTaskIds(issues),
  };
}

export interface ParsedValidatorResponse {
  result: ValidatorOutcome;
  parsePath:
    | "structured_output"
    | "raw_json"
    | "fenced_json_block"
    | "runner_error";
}

const PARSE_PATH_BY_SOURCE: Record<
  StructuredOutputSource,
  Exclude<ParsedValidatorResponse["parsePath"], "runner_error">
> = {
  native: "structured_output",
  raw_json: "raw_json",
  fenced: "fenced_json_block",
};

export interface ParseValidatorResponseInput {
  text: string;
  engine: AgentBackendId;
  /**
   * Selects the parse twin. Required rather than defaulted: a caller that
   * forgot it would parse an advisory validator's output under the blocking
   * schema, which is precisely the shape the split exists to refuse.
   */
  authority: ValidatorAuthority;
  structuredOutput?: unknown;
  allowedTaskIds?: string[];
  /** The context's criterion-record ids, mirroring `allowedTaskIds`. */
  allowedCriterionIds?: string[];
  /**
   * True for the acceptance seat, whose issues must each cite a criterion
   * (the "required" citation rule); the shared parse twin keeps the field
   * optional, so the requirement is enforced here per dispatch.
   */
  requireIssueCriterionId?: boolean;
}

/**
 * Maps a validator turn's output onto a `ValidatorOutcome` via the shared
 * structured-output module (extraction precedence native → raw JSON → last
 * fenced block, first schema-passing candidate wins), then applies the
 * validator-specific task-id containment check.
 */
export function parseValidatorResponse(
  input: ParseValidatorResponseInput,
): ParsedValidatorResponse {
  const {
    text,
    engine,
    authority,
    structuredOutput,
    allowedTaskIds,
    allowedCriterionIds,
    requireIssueCriterionId,
  } = input;
  const allowedTaskIdSet = allowedTaskIds ? new Set(allowedTaskIds) : null;
  const allowedCriterionIdSet = allowedCriterionIds
    ? new Set(allowedCriterionIds)
    : null;

  const validated = validateStructuredOutput(
    authority === "advisory"
      ? workflowAdvisoryValidatorResultSchema
      : workflowBlockingValidatorResultSchema,
    {
      ...(structuredOutput != null ? { native: structuredOutput } : {}),
      text,
    },
  );

  if (!validated.ok) {
    return {
      result: {
        kind: "infra_error",
        reason:
          validated.stage === "extraction" ? "unparseable" : "schema_mismatch",
        message: validated.error,
        engine,
      },
      // No candidate was accepted; log the terminal fallback path.
      parsePath: "fenced_json_block",
    };
  }

  return {
    result: wireResultToOutcome(
      validated.value,
      engine,
      allowedTaskIdSet,
      allowedCriterionIdSet,
      requireIssueCriterionId ?? false,
    ),
    parsePath: PARSE_PATH_BY_SOURCE[validated.source],
  };
}

export interface ValidatorExecutionMetadata {
  sessionRef: GraphWorkflowValidationSessionRef | null;
  reviewArtifact: GraphWorkflowValidationReviewArtifact | null;
  limitEvaluation:
    | "disabled"
    | "supported"
    | "unsupported"
    | "metrics_unavailable";
  rotateBeforeNextTurn: boolean;
}

export interface ValidatorRunResult {
  result: ValidatorOutcome;
  metadata: ValidatorExecutionMetadata;
  /**
   * The round token this run was dispatched with, echoed back verbatim. It is
   * what makes a result attributable to a round as data — a result from an
   * earlier round of the same context carries that round's token no matter how
   * the worktree looks by the time it arrives. Null outside a round.
   */
  roundToken?: ValidationRoundToken | null;
}

/**
 * The worktree a validator inspects, or the reason it could not be resolved.
 * Carried as data rather than thrown so a resolve failure degrades the review
 * to acceptance-criteria-only instead of failing the round.
 */
interface InspectionWorktree {
  worktreePath: string | undefined;
  resolveError: string | null;
}

interface ValidatorContinuityService {
  resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall>;
  recordLaneTurnOutcome(
    input: RecordLaneTurnOutcomeInput,
  ): Promise<GraphWorkflowExecution>;
}

interface ValidatorContinuityRepository {
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
}

export interface ValidatorRunnerDeps {
  resolveWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
  resolveTimeoutMs(backend: AgentBackendId): Promise<number>;
  /**
   * Reads `CommandCenter.json` so the validator prompt can list the context's
   * effective command selections with costs (validation-concurrency §8).
   * Degraded-not-fatal: a read failure renders the section with an explicit
   * unavailable-registry notice.
   */
  readRepoConfig?: typeof readRepoConfig;
  continuityService?: ValidatorContinuityService;
  executionRepository?: ValidatorContinuityRepository;
  /**
   * Optional override for the conversation entrypoint that the validator
   * uses to drive each `task_run` turn. Every validator turn flows through
   * the conversation actor — there is no direct AgentCall facade call in
   * this module — so the actor handles transcript persistence, backend-native
   * continuity (via context.backendRef), and structured-output dispatch in one
   * place.
   */
  executeWorkflowTaskRun?: (
    input: ExecuteWorkflowTaskRunInput,
  ) => Promise<TaskRunResult>;
  /**
   * Optional override for project-display-name resolution. Used only to
   * populate the synthetic actor input for transient validator
   * conversations — no state-store side effects depend on it.
   */
  getProjectDisplayName?: (projectPath: string) => string;
  /**
   * Optional override for diff-scope computation. Defaults to the real
   * working-tree-vs-HEAD computation, restricted to the reviewed context's
   * candidate scope. Injected in tests to avoid spawning git.
   */
  computeValidationDiffScope?: (
    worktreePath: string,
    candidateScope: CandidateScope,
  ) => Promise<ValidationDiffScope>;
  /**
   * Read the post-turn pending-question state of the validator's lane
   * conversation. Runs before verdict parsing so a question-ending turn yields
   * `asked_user` instead of an unparseable verdict (Req 3.2). Returns null when
   * the strategy has no CC conversation and therefore cannot produce
   * `asked_user`. Defaults to reading the conversation via the state store.
   */
  readLaneConversation?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<LaneConversationPendingState | null>;
  /**
   * Read cost/turn telemetry for a validator CC conversation after its turn.
   * Defaults to the transcript-backed reader. Conversation-strategy
   * validators have no task-runner usage payload, so without this read every
   * conversation-validator decision is unpriced in cost audits.
   */
  readValidatorConversationTelemetry?(
    conversationId: string,
  ): Promise<GraphWorkflowValidationConversationUsage | null>;
  /**
   * Establish the lane's filesystem-write envelope. Defaults to the real
   * composer, which creates and canonicalizes the lane's scratch directories;
   * injected in tests so a validator turn does not touch the filesystem. A
   * throw here is fail-closed — the turn never dispatches.
   */
  composeLaneWriteEnvelope?(
    input: ComposeValidatorLaneWriteEnvelopeInput,
  ): ValidatorLaneWriteEnvelope;
  executionContract?: GraphExecutionContract;
}

const validatorLogger = createLogger("graph-workflow-validator");

/**
 * Resume reference for a reused validator lane, sourced entirely from durable
 * state. Task strategies resume through the lane's opaque backend ref;
 * conversation strategies resume through the CC conversation's persisted
 * state, so no ref is passed here. No in-memory ref cache exists — a process
 * restart resumes exactly what was persisted (bug §1.9.4).
 */
function resolvedCallToResumeRef(
  resolved: ResolvedValidatorCall,
): AgentSessionRef | null {
  if (resolved.sessionAction === "create") return null;
  return resolved.strategy === "task" ? resolved.backendRef : null;
}

function buildConversationValidationSessionRef(
  backend: AgentBackendId,
  lane: GraphWorkflowLaneKind,
  assignmentId: string,
  conversationId: string,
): GraphWorkflowValidationSessionRef {
  return {
    backend,
    ref: conversationId,
    lane,
    assignmentId,
    refKind: "conversation",
    workflowConversationId: conversationId,
  };
}

function buildTaskValidationSessionRef(
  execution: GraphWorkflowExecution,
  contextId: string,
  lane: GraphWorkflowLaneKind,
  assignmentId: string,
  backend: AgentBackendId,
  continuationDisposition: TaskRunResult["continuationDisposition"],
): GraphWorkflowValidationSessionRef | null {
  if (continuationDisposition === "clear") return null;

  const laneState =
    execution.laneStates[contextId]?.[laneStateKey(lane, assignmentId)];
  if (
    laneState?.refKind !== "backend" ||
    laneState.sessionRef?.backend !== backend
  ) {
    return null;
  }

  return {
    ...laneState.sessionRef,
    lane,
    assignmentId,
    refKind: "backend",
  };
}

function getContextTaskIds(index: ExecutionIndex, contextId: string): string[] {
  return (index.tasksByContext.get(contextId) ?? []).map((task) => task.id);
}

/**
 * Internal validator task result. Mirrors the legacy `AgentTaskResult` shape
 * that `parseValidatorResponse` consumes — kept here so the parser remains
 * backend-agnostic and is the single place that maps raw text plus optional
 * structured output into a `ValidatorOutcome`.
 */
type ValidatorTaskResult = ReturnType<typeof adaptValidatorTaskResult>;

interface ValidatorTaskInvocation {
  strategy: "task" | "conversation";
  prompt: string;
  backend: AgentBackendId;
  workingDirectory: string;
  modelSelection: BackendModelSelection;
  timeoutMs: number;
  resumeRef: AgentSessionRef | null | undefined;
  laneRef: { workflowId: string; laneId: GraphWorkflowLaneKind };
  projectPath: string;
  sessionName: string;
  conversationId: string;
  /**
   * The turn's authoritative instruction payload: role contract first, the
   * assignment's seeded profile block after it. Delivered through the strongest
   * privileged channel each backend offers rather than folded into the prompt
   * (R10), which is what keeps user-authored profile text subordinate.
   */
  systemInstructions: string;
  /**
   * The lane's filesystem-write envelope. Always present on a validator turn —
   * a validator reviews a frozen candidate, so "no policy" is never a legal
   * shape here even though the transport allows it for implementer lanes.
   */
  fsWritePolicy: FsWritePolicy;
  /**
   * The authority-selected, task-bound output schema for this dispatch (D2).
   * Built once per turn by the caller so the schema the provider enforces is
   * the same one the role contract quotes.
   */
  outputSchema: Record<string, unknown>;
}

/**
 * The dispatch id for a task-strategy validator turn, which has no CC
 * conversation of its own. The assignment segment is what keeps two cohort
 * members reviewing one context from sharing a dispatch anchor — and with it,
 * an abort registry entry.
 */
function syntheticValidatorConversationId(
  executionId: string,
  contextId: string,
  lane: GraphWorkflowLaneKind,
  assignmentId: string,
  backend: AgentBackendId,
): string {
  return `__validator__:${executionId}:${contextId}:${lane}:${assignmentId}:${backend}`;
}

function buildValidatorBinding(
  invocation: ValidatorTaskInvocation,
  projectName: string,
): ConversationBinding {
  // A validator lane runs against a session worktree, not the project root.
  const address = {
    projectPath: invocation.projectPath,
    target: sessionConversationTarget(
      projectName,
      invocation.sessionName,
      invocation.conversationId,
    ),
  };
  if (invocation.strategy === "conversation")
    return {
      kind: "durable",
      address,
      worktreePath: invocation.workingDirectory,
    };
  // A synthetic validator lane has no persisted ConversationState record, so
  // it runs the ephemeral persistence adapter — every durable side effect is
  // inert.
  return {
    kind: "ephemeral",
    address,
    worktreePath: invocation.workingDirectory,
    backend: invocation.backend,
    role: null,
    transcriptPath: null,
  };
}

interface RunValidatorTurnInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  lane: "context_validator";
  /** The cohort member running this turn — the lane's identity. */
  assignmentId: string;
  assignmentFingerprint: string;
  strategy: ValidatorExecutionStrategy;
  backend: AgentBackendId;
  prompt: string;
  systemInstructions: string;
  profileSnapshot: AgentProfileSnapshot;
  modelSelection: BackendModelSelection;
  contextLimitTokens: number | undefined;
  allowedTaskIds: string[];
  /** The context's criterion-record ids, mirroring `allowedTaskIds`. */
  allowedCriterionIds: string[];
  /** True for the acceptance seat, whose issues must each cite a criterion. */
  requireIssueCriterionId: boolean;
  /** Selects both the dispatched output schema and the parse twin (D2). */
  authority: ValidatorAuthority;
  outputSchema: Record<string, unknown>;
  overrideWorktreePath: string | undefined;
  pinnedConversationId: string | undefined;
}

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
  const executionContract =
    deps.executionContract ?? createRegisteredGraphExecutionContract();
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  const getProjectDisplayName =
    deps.getProjectDisplayName ?? defaultGetProjectDisplayName;
  const readValidatorConversationTelemetry =
    deps.readValidatorConversationTelemetry ??
    (async (
      conversationId: string,
    ): Promise<GraphWorkflowValidationConversationUsage | null> => {
      const summary = await readConversationTelemetry(conversationId);
      return summary === null
        ? null
        : { costUsd: summary.costUsd, apiTurns: summary.apiTurns };
    });
  const computeValidationDiffScope =
    deps.computeValidationDiffScope ?? defaultComputeValidationDiffScope;
  const composeLaneWriteEnvelope =
    deps.composeLaneWriteEnvelope ??
    ((input: ComposeValidatorLaneWriteEnvelopeInput) =>
      defaultComposeValidatorLaneWriteEnvelope(input));
  const readLaneConversation =
    deps.readLaneConversation ??
    (async (projectPath, sessionName, conversationId) => {
      try {
        const conversation = await defaultGetConversation(
          projectPath,
          sessionName,
          conversationId,
        );
        if (!conversation) {
          return null;
        }
        return {
          pendingQuestionId: conversation.pendingQuestionId,
          pendingQuestions: conversation.pendingQuestions ?? [],
        };
      } catch (error) {
        // A read failure cannot confirm a pending question, so the park check
        // treats it as "no question" (deny-by-default). Logged so a systematic
        // failure surfaces rather than silently suppressing every validator park.
        validatorLogger.warn(
          "graph-workflow.validator.read_lane_conversation_failed",
          {
            conversationId,
            error: getErrorMessage(error),
          },
        );
        return null;
      }
    });

  async function dispatchValidatorTurn(
    invocation: ValidatorTaskInvocation,
  ): Promise<ValidatorTaskResult> {
    const projectName = getProjectDisplayName(invocation.projectPath);
    const binding = buildValidatorBinding(invocation, projectName);

    const result = await executeWorkflowTaskRun({
      binding,
      kind: "task_run",
      executionClass: "governed-execution",
      executionProfile: "standard",
      prompt: invocation.prompt,
      systemInstructions: invocation.systemInstructions,
      fsWritePolicy: invocation.fsWritePolicy,
      outputFormat: {
        type: "json_schema",
        schema: invocation.outputSchema,
      },
      timeoutMs: invocation.timeoutMs,
      modelSelection: invocation.modelSelection,
      ...(invocation.strategy === "task"
        ? { resumeRef: invocation.resumeRef }
        : {}),
      origin: {
        source: "workflow",
        workflow: {
          executionId: invocation.laneRef.workflowId,
          nodeId: invocation.laneRef.laneId,
          iterationIndex: 0,
        },
      },
    });

    return adaptValidatorTaskResult(result);
  }

  /**
   * Pre-verdict pending-question check (Req 3.2, 3.3; design "Park detection →
   * Validator"). Reads the lane conversation the turn dispatched against; if a
   * question batch is pending, returns an `asked_user` outcome so the caller
   * short-circuits before verdict parsing and the orchestrator maps it to the
   * park path. Null → parse the verdict as normal. Strategies without a real CC
   * conversation return null and therefore never produce `asked_user`.
   */
  async function checkValidatorPendingQuestion(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
    conversationId: string,
    engine: AgentBackendId,
  ): Promise<Extract<ValidatorOutcome, { kind: "asked_user" }> | null> {
    const laneConversation = await readLaneConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    const pendingQuestionId = laneConversation?.pendingQuestionId ?? null;
    if (pendingQuestionId === null) {
      return null;
    }
    const questions = laneConversation?.pendingQuestions ?? [];
    validatorLogger.info("graph-workflow.validator.asked_user", {
      executionId,
      contextId,
      engine,
      conversationId,
      questionBatchId: pendingQuestionId,
      questionCount: questions.length,
    });
    return {
      kind: "asked_user",
      conversationId,
      questionBatchId: pendingQuestionId,
      questions,
    };
  }

  async function applyLaneStateUpdate(
    projectPath: string,
    sessionName: string,
    transform: (latest: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution | null> {
    if (!deps.executionRepository) {
      return null;
    }
    return deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      transform,
    );
  }

  function buildNoServiceMetadata(): ValidatorExecutionMetadata {
    return {
      sessionRef: null,
      reviewArtifact: null,
      limitEvaluation: "disabled",
      rotateBeforeNextTurn: false,
    };
  }

  function extractLaneMetadata(
    updatedExecution: GraphWorkflowExecution,
    contextId: string,
    lane: GraphWorkflowLaneKind,
    assignmentId: string,
  ): {
    limitEvaluation:
      | "disabled"
      | "supported"
      | "unsupported"
      | "metrics_unavailable";
    rotateBeforeNextTurn: boolean;
  } {
    const laneState =
      updatedExecution.laneStates[contextId]?.[
        laneStateKey(lane, assignmentId)
      ];
    if (!laneState) {
      return {
        limitEvaluation: "disabled",
        rotateBeforeNextTurn: false,
      };
    }
    return {
      limitEvaluation: laneState.limitEvaluation,
      rotateBeforeNextTurn: laneState.metrics.rotateBeforeNextTurn,
    };
  }

  async function runValidatorTurn(
    input: RunValidatorTurnInput,
  ): Promise<ValidatorRunResult> {
    const {
      projectPath,
      sessionName,
      execution,
      contextId,
      lane,
      assignmentId,
      assignmentFingerprint,
      strategy,
      backend,
      prompt,
      systemInstructions,
      profileSnapshot,
      modelSelection,
      contextLimitTokens,
      allowedTaskIds,
      allowedCriterionIds,
      requireIssueCriterionId,
      authority,
      outputSchema,
      overrideWorktreePath,
      pinnedConversationId,
    } = input;
    const execLogger = getExecutionLogger(execution.id);
    // Every artifact this turn writes is scoped to the assignment, so a cohort
    // leaves one reviewable trail per specialist instead of overwriting a
    // single shared prompt/response pair.
    const artifactScope = { contextId, assignmentId };
    const worktreePath =
      overrideWorktreePath ??
      (await deps.resolveWorktreePath(projectPath, sessionName));
    const timeoutMs = await deps.resolveTimeoutMs(backend);
    // Established BEFORE any dispatch decision: a lane whose envelope cannot be
    // composed throws here, and the caller's catch turns that into an
    // infrastructure outcome rather than a turn that ran unrestricted.
    const { policy: fsWritePolicy } = composeLaneWriteEnvelope({
      executionId: execution.id,
      contextId,
      assignmentId,
      worktreePath,
    });

    execLogger?.validation(contextId, "validator.invoked", {
      lane,
      assignmentId,
      engine: backend,
      hasContinuityService: !!deps.continuityService,
    });
    validatorLogger.info("graph-workflow.validator.invoked", {
      executionId: execution.id,
      lane,
      assignmentId,
      engine: backend,
      strategy,
    });

    if (!deps.continuityService) {
      const noServiceConversationId = syntheticValidatorConversationId(
        execution.id,
        contextId,
        lane,
        assignmentId,
        backend,
      );
      const taskResult = await dispatchValidatorTurn({
        strategy: "task",
        prompt,
        systemInstructions,
        backend,
        workingDirectory: worktreePath,
        modelSelection,
        timeoutMs,
        resumeRef: undefined,
        laneRef: { workflowId: execution.id, laneId: lane },
        projectPath,
        sessionName,
        conversationId: noServiceConversationId,
        fsWritePolicy,
        outputSchema,
      });

      if (taskResult.transcript) {
        execLogger?.writeValidatorTranscript(
          artifactScope,
          { lane, engine: backend },
          taskResult.transcript,
        );
      }

      const askedUser = await checkValidatorPendingQuestion(
        projectPath,
        sessionName,
        execution.id,
        contextId,
        noServiceConversationId,
        backend,
      );
      if (askedUser) {
        return {
          result: askedUser,
          metadata: buildNoServiceMetadata(),
        };
      }

      if (taskResult.error) {
        const outcome: ValidatorOutcome = classifyGraphDispatchFailure(
          taskResult,
          backend,
        );
        execLogger?.validation(contextId, "validator.result_parsed", {
          lane,
          engine: backend,
          parsePath: "runner_error" as const,
          kind: outcome.kind,
          issueCount: 0,
          reopenTaskIds: [],
        });
        return {
          result: outcome,
          metadata: buildNoServiceMetadata(),
        };
      }

      const text = taskResult.text ?? "";
      const { result: parsed, parsePath } = parseValidatorResponse({
        text,
        engine: backend,
        authority,
        structuredOutput: taskResult.structuredOutput,
        allowedTaskIds,
        allowedCriterionIds,
        requireIssueCriterionId,
      });

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        assignmentId,
        engine: backend,
        parsePath,
        kind: parsed.kind,
        ...validatorOutcomeLogFields(parsed),
      });

      return {
        result: parsed,
        metadata: buildNoServiceMetadata(),
      };
    }

    const resolved = await deps.continuityService.resolveValidatorCall({
      execution,
      projectPath,
      sessionName,
      contextId,
      lane,
      assignmentId,
      assignmentFingerprint,
      backend,
      strategy,
      profileSnapshot,
      pinnedConversationId,
    });

    const laneKey = laneStateKey(lane, assignmentId);
    const resolvedLaneState =
      resolved.execution.laneStates[contextId]?.[laneKey] ?? null;

    function applyResolvedLaneState(
      target: GraphWorkflowExecution,
    ): GraphWorkflowExecution {
      if (!resolvedLaneState) return target;
      return {
        ...target,
        laneStates: {
          ...target.laneStates,
          [contextId]: {
            ...target.laneStates[contextId],
            [laneKey]: resolvedLaneState,
          },
        },
      };
    }

    const resumeRef = resolvedCallToResumeRef(resolved);
    const dispatchConversationId =
      resolved.strategy === "conversation"
        ? resolved.conversationId
        : syntheticValidatorConversationId(
            execution.id,
            contextId,
            lane,
            assignmentId,
            backend,
          );
    // Persist the lane binding BEFORE dispatch. Active cancellation
    // (pause/abort/halt/resume) collects abortable conversations from
    // execution.laneStates; a lane resolved only in local state — every
    // first or rotated conversation turn, and every task-strategy turn (whose
    // synthetic dispatch id is never part of continuity state) — would otherwise be
    // undiscoverable for the whole run, letting the turn burn to completion.
    if (resolvedLaneState) {
      const laneStateForDispatch = {
        ...resolvedLaneState,
        workflowConversationId: dispatchConversationId,
      };
      await applyLaneStateUpdate(projectPath, sessionName, (latest) => ({
        ...latest,
        laneStates: {
          ...latest.laneStates,
          [contextId]: {
            ...latest.laneStates[contextId],
            [laneKey]: laneStateForDispatch,
          },
        },
      }));
    }
    const taskResult = await dispatchValidatorTurn({
      strategy: resolved.strategy,
      prompt,
      systemInstructions,
      backend,
      workingDirectory: worktreePath,
      modelSelection,
      timeoutMs,
      resumeRef,
      laneRef: { workflowId: execution.id, laneId: lane },
      projectPath,
      sessionName,
      conversationId: dispatchConversationId,
      fsWritePolicy,
      outputSchema,
    });

    if (taskResult.transcript) {
      execLogger?.writeValidatorTranscript(
        artifactScope,
        { lane, engine: backend },
        taskResult.transcript,
      );
    }

    // Pre-verdict park check: a pending question short-circuits before parsing
    // and before the continuity turn bookkeeping, so the asking turn never
    // reaches the inline validation-failure accounting (Req 3.2, 3.3).
    const askedUser = await checkValidatorPendingQuestion(
      projectPath,
      sessionName,
      execution.id,
      contextId,
      dispatchConversationId,
      backend,
    );
    if (askedUser) {
      return {
        result: askedUser,
        metadata: {
          sessionRef:
            resolved.strategy === "conversation"
              ? buildConversationValidationSessionRef(
                  backend,
                  lane,
                  assignmentId,
                  resolved.conversationId,
                )
              : buildTaskValidationSessionRef(
                  resolved.execution,
                  contextId,
                  lane,
                  assignmentId,
                  backend,
                  taskResult.continuationDisposition,
                ),
          reviewArtifact: null,
          limitEvaluation: "disabled",
          rotateBeforeNextTurn: false,
        },
      };
    }

    const runnerError = taskResult.error;
    const text = taskResult.text ?? "";
    const { result: parsed, parsePath }: ParsedValidatorResponse = runnerError
      ? {
          result: classifyGraphDispatchFailure(taskResult, backend),
          parsePath: "runner_error",
        }
      : parseValidatorResponse({
          text,
          engine: backend,
          authority,
          structuredOutput: taskResult.structuredOutput,
          allowedTaskIds,
          allowedCriterionIds,
          requireIssueCriterionId,
        });

    if (resolved.strategy === "task") {
      const updatedRef =
        taskResult.backendRef?.backend === backend
          ? (taskResult.backendRef?.ref ?? null)
          : null;
      const usage = taskResult.usage
        ? {
            inputTokens: taskResult.usage.inputTokens ?? 0,
            cachedInputTokens: taskResult.usage.cachedInputTokens ?? 0,
            outputTokens: taskResult.usage.outputTokens ?? 0,
          }
        : null;

      const updatedExecution =
        await deps.continuityService.recordLaneTurnOutcome({
          execution: applyResolvedLaneState(execution),
          projectPath,
          sessionName,
          contextId,
          lane,
          assignmentId,
          outcome: {
            backend,
            lastTurnUsage: usage,
            ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
            ...(updatedRef != null ? { ref: updatedRef } : {}),
            continuationDisposition: taskResult.continuationDisposition,
          },
        });

      const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
        updatedExecution,
        contextId,
        lane,
        assignmentId,
      );

      const sessionRef = buildTaskValidationSessionRef(
        updatedExecution,
        contextId,
        lane,
        assignmentId,
        backend,
        taskResult.continuationDisposition,
      );
      const updatedLaneRef =
        updatedExecution.laneStates[contextId]?.[laneKey]?.sessionRef;
      const responseRef =
        taskResult.backendRef?.backend === backend
          ? taskResult.backendRef.ref
          : updatedLaneRef?.backend === backend
            ? (updatedLaneRef.ref ?? null)
            : null;

      const reviewArtifact = buildGraphWorkflowValidationReviewArtifact({
        backend,
        strategy,
        ref: responseRef,
        response: text,
        usage: usage
          ? { ...usage, costUsd: taskResult.usage?.costUsd ?? null }
          : null,
      });

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        assignmentId,
        engine: backend,
        parsePath,
        kind: parsed.kind,
        ...validatorOutcomeLogFields(parsed),
        sessionAction: resolved.sessionAction,
        threadId: responseRef,
      });
      execLogger?.writeValidatorResponse(
        artifactScope,
        "context-validator.json",
        {
          raw: text,
          parsed,
          parsePath,
        },
      );

      return {
        result: parsed,
        metadata: {
          sessionRef,
          reviewArtifact,
          limitEvaluation,
          rotateBeforeNextTurn,
        },
      };
    }

    const updatedExecution = await deps.continuityService.recordLaneTurnOutcome(
      {
        execution: applyResolvedLaneState(execution),
        projectPath,
        sessionName,
        contextId,
        lane,
        assignmentId,
        outcome: {
          backend,
          ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
        },
      },
    );

    const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
      updatedExecution,
      contextId,
      lane,
      assignmentId,
    );

    const backendSessionId = Object.is(taskResult.backendRef?.backend, backend)
      ? (taskResult.backendRef?.ref ?? null)
      : null;
    const conversationSessionRef = buildConversationValidationSessionRef(
      backend,
      lane,
      assignmentId,
      resolved.conversationId,
    );
    const conversationUsage = await readValidatorConversationTelemetry(
      resolved.conversationId,
    );
    const reviewArtifact = buildGraphWorkflowValidationReviewArtifact({
      backend,
      strategy,
      ref: resolved.conversationId,
      response: text,
      usage: null,
      conversationUsage,
    });

    execLogger?.validation(contextId, "validator.result_parsed", {
      lane,
      assignmentId,
      engine: backend,
      parsePath,
      kind: parsed.kind,
      ...validatorOutcomeLogFields(parsed),
      sessionAction: resolved.sessionAction,
      backendSessionId,
    });
    execLogger?.writeValidatorResponse(
      artifactScope,
      "context-validator.json",
      {
        raw: text,
        parsed,
        parsePath,
      },
    );

    return {
      result: parsed,
      metadata: {
        sessionRef: conversationSessionRef,
        reviewArtifact,
        limitEvaluation,
        rotateBeforeNextTurn,
      },
    };
  }

  /**
   * The exact worktree a validator will inspect. Degraded-not-fatal: a resolve
   * failure yields no path and a reason, and review continues against the
   * acceptance criteria alone rather than halting the round.
   */
  async function resolveInspectionWorktree(input: {
    projectPath: string;
    sessionName: string;
    executionTarget?: ExecutionTarget;
  }): Promise<InspectionWorktree> {
    const targetWorktreePath = input.executionTarget?.worktreePath;
    if (targetWorktreePath !== undefined) {
      return { worktreePath: targetWorktreePath, resolveError: null };
    }
    try {
      return {
        worktreePath: await deps.resolveWorktreePath(
          input.projectPath,
          input.sessionName,
        ),
        resolveError: null,
      };
    } catch (error) {
      return { worktreePath: undefined, resolveError: getErrorMessage(error) };
    }
  }

  /**
   * Compute the context's uncommitted change set in the inspected worktree and
   * render it as the "Changes under review" section, logging what was scoped.
   * Any failure yields an "unavailable" scope rather than halting validation.
   *
   * The candidate scope comes from the reviewed context's own placement, which is
   * the same source the round's freeze reads (R15). An enveloped context's
   * validators are shown its owned subset and nothing a concurrent sibling wrote;
   * a full-access member's still see the whole tree.
   */
  async function renderScopedDiffSection(params: {
    executionId: string;
    contextId: string;
    candidateScope: CandidateScope;
    inspection: InspectionWorktree;
    contextLimitTokens?: number;
    execLogger: ReturnType<typeof getExecutionLogger>;
  }): Promise<{ section: string; treeHash: string | null }> {
    const { executionId, contextId, candidateScope, inspection, execLogger } =
      params;

    let diffScope: ValidationDiffScope;
    if (inspection.worktreePath === undefined) {
      diffScope = {
        kind: "unavailable",
        candidateScope,
        reason: `scope computation error: ${inspection.resolveError ?? "worktree path unavailable"}`,
      };
    } else {
      try {
        diffScope = await computeValidationDiffScope(
          inspection.worktreePath,
          candidateScope,
        );
      } catch (error) {
        diffScope = {
          kind: "unavailable",
          candidateScope,
          reason: `scope computation error: ${getErrorMessage(error)}`,
        };
      }
    }

    const renderedDiffScope = renderDiffScopeSection(diffScope, {
      contextLimitTokens: params.contextLimitTokens,
    });
    const diffScopeWorktreePath = inspection.worktreePath ?? null;

    if (diffScope.kind === "unavailable") {
      execLogger?.validation(contextId, "diff_scope.unavailable", {
        worktreePath: diffScopeWorktreePath,
        reason: diffScope.reason,
      });
      validatorLogger.warn("graph-workflow.validator.diff_scope.unavailable", {
        executionId,
        contextId,
        worktreePath: diffScopeWorktreePath,
        reason: diffScope.reason,
      });
    } else {
      const fileCount =
        diffScope.kind === "available" ? diffScope.fileCount : 0;
      const totalAdditions =
        diffScope.kind === "available" ? diffScope.totalAdditions : 0;
      const totalDeletions =
        diffScope.kind === "available" ? diffScope.totalDeletions : 0;
      const diffScopeMetadata = {
        worktreePath: diffScopeWorktreePath,
        status: diffScope.kind,
        candidateScopeMode: candidateScope.mode,
        ownedPathCount:
          candidateScope.mode === "owned"
            ? candidateScope.ownedPaths.length
            : null,
        fileCount,
        totalAdditions,
        totalDeletions,
        truncated: renderedDiffScope.truncated,
        omittedFileCount: renderedDiffScope.omittedFileCount,
      };
      execLogger?.validation(
        contextId,
        "diff_scope.computed",
        diffScopeMetadata,
      );
      validatorLogger.info("graph-workflow.validator.diff_scope.computed", {
        executionId,
        contextId,
        ...diffScopeMetadata,
      });
    }

    return {
      section: renderedDiffScope.section,
      treeHash: diffScopeTreeHash(diffScope),
    };
  }

  /**
   * Render a round's shared prompt inputs exactly once, before any specialist
   * runs.
   *
   * The diff budget is the TIGHTEST context limit in the cohort, not each
   * member's own: one rendering has to fit inside every specialist that will
   * read it, and a block sized for the roomiest member would overflow the
   * others. Choosing the minimum keeps the bytes identical — which is the
   * property being bought — at the cost of showing a roomy specialist a
   * slightly smaller diff than it could have held.
   */
  async function renderRoundCommonSections(
    input: RenderRoundCommonSectionsInput,
  ): Promise<ValidationRoundCommonSections> {
    const limits = selectRunnableCohortAssignments(
      input.context.contextValidator,
    )
      .map((assignment) => assignment.continuity.contextLimitTokens)
      .filter((limit): limit is number => limit !== undefined);

    const rendered = await renderScopedDiffSection({
      executionId: input.execution.id,
      contextId: input.context.id,
      candidateScope: candidateScopeForPlacement(input.context.placement, {
        stableRead: input.context.outputSchema !== undefined,
      }),
      inspection: await resolveInspectionWorktree(input),
      ...(limits.length > 0 ? { contextLimitTokens: Math.min(...limits) } : {}),
      execLogger: getExecutionLogger(input.execution.id),
    });

    return {
      diffScopeSection: rendered.section,
      candidateTreeHash: rendered.treeHash,
    };
  }

  /**
   * Stamp every result with the round it was dispatched for, on every exit —
   * verdict, infra error, or thrown. A result that could reach its caller
   * without a token would be a result the caller cannot attribute, which is the
   * one thing the token exists to prevent.
   */
  async function runContextValidator(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult> {
    const result = await runContextValidatorTurn(input);
    return { ...result, roundToken: input.roundToken ?? null };
  }

  async function runContextValidatorTurn(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult> {
    const index = createExecutionIndex(
      input.execution.workingDefinition,
      input.execution,
    );
    const contextTasks = index.tasksByContext.get(input.context.id) ?? [];
    const execLogger = getExecutionLogger(input.execution.id);
    // Dispatch reads the assignment directly: strategy and backend are
    // independent axes, so all four combinations reach the right runner.
    const validatorPlan = {
      strategy: input.validator.strategy,
      backend: input.validator.agent.backend,
      modelSelection: input.validator.agent.modelSelection,
    };
    const contextLimitTokens = input.validator.continuity.contextLimitTokens;
    const allowedTaskIds = getContextTaskIds(index, input.context.id);
    // The criterion twin of the task-id enum: the context's record ids (prose
    // wraps as the single `ac-1` record), bound into the dispatched schema and
    // the parse-side containment check alike.
    const allowedCriterionIds = criterionRecordsOf(
      input.context.acceptanceCriteria,
    ).map((record) => record.id);
    const issueCriterionCitation = issueCriterionCitationFor(input.validator);

    const inspection = await resolveInspectionWorktree(input);
    const resolvedWorktreePath = inspection.worktreePath;
    const targetWorktreePath = input.executionTarget?.worktreePath;

    // A round renders its shared inputs once and hands the same bytes to every
    // specialist; only a standalone run (no round, or a cohort of one) derives
    // its own here.
    const diffScopeSection =
      input.roundCommonSections?.diffScopeSection ??
      (
        await renderScopedDiffSection({
          executionId: input.execution.id,
          contextId: input.context.id,
          candidateScope: candidateScopeForPlacement(input.context.placement, {
            stableRead: input.context.outputSchema !== undefined,
          }),
          inspection,
          contextLimitTokens,
          execLogger,
        })
      ).section;

    // The frozen seed-time snapshot decides the enabled set; the registry
    // read feeds only cost annotation and the disabled list, and a failed
    // read renders an explicit "registry unavailable" notice instead of
    // silently dropping the section.
    const validationSelections = resolveValidationPromptSelections({
      role: "contextValidator",
      context: input.context,
      registry: await loadValidationPromptRegistry(async () => {
        const repoConfig = await (deps.readRepoConfig ?? readRepoConfig)(
          input.projectPath,
        );
        return repoConfig?.validation;
      }),
    });
    const scopedCharter = input.context.charter
      ? resolveScopedCharterForContext({
          execution: input.execution,
          contextId: input.context.id,
          charter: input.context.charter,
        })
      : undefined;
    const basePrompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      taskStates: input.execution.taskStates,
      outputCandidate:
        input.execution.contextStates[input.context.id]?.validationRound
          ?.outputCandidate,
      validator: input.validator,
      validationSelections,
      ...(scopedCharter ? { charter: scopedCharter } : {}),
      // Scoped sources bind authored ids: a loop-instance context renders the
      // charter section under its authored template id, same as invariants.
      charterContextId:
        resolveLogicalAuthoredContextId({
          execution: input.execution,
          contextId: input.context.id,
        }) ?? input.context.id,
      diffScopeSection,
      askUserQuestionsEnabled: resolveValidatorAskUserQuestionsEnabled(
        input.validator,
        input.context,
      ),
      ...(input.resumeUserInput
        ? {
            resumeUserInput: {
              questionBatchId: input.resumeUserInput.questionBatchId,
              answers: input.resumeUserInput.answers,
            },
          }
        : {}),
    });
    const prompt = await composeGraphRolePrompt({
      execution: input.execution,
      executionContract,
      prompt: basePrompt,
      role: "context-validator",
      contextId: input.context.id,
    });

    // One schema per dispatch, quoted in the role contract and enforced by the
    // provider: the validator is told exactly the shape it will be held to.
    const outputSchema = buildValidatorOutputSchema({
      authority: input.validator.authority,
      taskIds: allowedTaskIds,
      criterionIds: allowedCriterionIds,
      issueCriterionCitation,
    });

    // Role contract first, the assignment's seeded lens after it. Composed here
    // — above both adapters — because the ORDER is the security property and a
    // per-adapter decision could invert it (R10).
    //
    // A blocking seat's authored instructions ride in the contract as its
    // mandate; seeding leaves them out of that seat's profile block, so the
    // text is delivered exactly once, at the one authority level it is meant to
    // carry (D4). An advisory seat's instructions stay inside the block, where
    // the snapshot already put them.
    const systemInstructions = composeWorkflowRoleInstructions({
      roleContract: buildValidatorRoleContract(
        input.validator.authority === "advisory"
          ? { authority: "advisory", verdictSchema: outputSchema }
          : {
              authority: "blocking",
              verdictSchema: outputSchema,
              ...(input.validator.focus === undefined
                ? {}
                : { mandate: input.validator.focus }),
            },
      ),
      profileBlock: input.validator.profileSnapshot.renderedInstructionBlock,
    });

    const artifactScope = {
      contextId: input.context.id,
      assignmentId: input.validator.id,
    };
    execLogger?.writePrompt(artifactScope, "context-validator.md", prompt);
    execLogger?.validation(input.context.id, "context_validator.started", {
      assignmentId: input.validator.id,
      engine: validatorPlan.backend,
      strategy: validatorPlan.strategy,
      promptLength: prompt.length,
      taskCount: contextTasks.length,
    });

    // Pass the worktree we already resolved so runValidatorTurn does not
    // re-resolve it; fall back to the target path (or undefined) when scope
    // resolution failed, preserving runValidatorTurn's own error surfacing.
    const overrideWorktreePath = resolvedWorktreePath ?? targetWorktreePath;

    try {
      return await runValidatorTurn({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution: input.execution,
        contextId: input.context.id,
        lane: "context_validator",
        assignmentId: input.validator.id,
        assignmentFingerprint: assignmentFingerprint(input.validator),
        strategy: validatorPlan.strategy,
        backend: validatorPlan.backend,
        prompt,
        systemInstructions,
        profileSnapshot: input.validator.profileSnapshot,
        modelSelection: validatorPlan.modelSelection,
        contextLimitTokens,
        allowedTaskIds,
        allowedCriterionIds,
        requireIssueCriterionId: issueCriterionCitation === "required",
        authority: input.validator.authority,
        outputSchema,
        overrideWorktreePath,
        pinnedConversationId: input.resumeUserInput?.conversationId,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      execLogger?.validation(input.context.id, "context_validator.error", {
        assignmentId: input.validator.id,
        engine: validatorPlan.backend,
        error: errorMessage,
      });
      execLogger?.validation(input.context.id, "validator.infra_error", {
        lane: "context_validator",
        assignmentId: input.validator.id,
        engine: validatorPlan.backend,
        reason: "exception",
        message: errorMessage,
      });
      validatorLogger.error("graph-workflow.context_validator.error", {
        executionId: input.execution.id,
        contextId: input.context.id,
        error: errorMessage,
      });

      return {
        result: classifyGraphDispatchFailure(
          error instanceof Error ? error : new Error(errorMessage),
          validatorPlan.backend,
        ),
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runContextValidator, renderRoundCommonSections };
}
