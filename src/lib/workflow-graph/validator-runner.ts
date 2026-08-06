import { workflowAgentValidatorResultSchema } from "@/lib/workflow-graph/definition-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  CharterAmendment,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { renderCharterPromptSection } from "@/lib/workflow-graph/charter/render";
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
  selectRunnableCohortAssignments,
  type ValidatorAssignment,
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
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";
import { isQuerySlotAdmissionTimeout } from "@/lib/shared/query-semaphore";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import { buildAskUserQuestionsReminderSection } from "./iteration-prompt";
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
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
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
  type TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  composeValidatorLaneWriteEnvelope as defaultComposeValidatorLaneWriteEnvelope,
  type ComposeValidatorLaneWriteEnvelopeInput,
  type ValidatorLaneWriteEnvelope,
} from "@/lib/workflow-graph/lane-write-policy";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/manager";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { getConversation as defaultGetConversation } from "@/lib/state-store";
import {
  computeValidationDiffScope as defaultComputeValidationDiffScope,
  diffScopeTreeHash,
  renderDiffScopeSection,
  type ValidationDiffScope,
} from "./validation-diff-scope";
import {
  validateStructuredOutput,
  type StructuredOutputSource,
} from "@/lib/agent-backends/structured-output";

export const VALIDATOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["taskId", "title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "issues"],
  additionalProperties: false,
} as const;

export interface BuildContextValidationPromptInput {
  context: GraphWorkflowCascadeContext;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: GraphWorkflowExecution["taskStates"];
  validator: ValidatorAssignment;
  // Optional because the resolved context carries an optional charter; when
  // present the digest is prepended so the prompt opens with it (4.2).
  charter?: WorkflowCharter;
  /** Live amendment history (doc 07) — the validator judges the amended rules. */
  charterAmendments?: CharterAmendment[];
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
  amendments: readonly CharterAmendment[] = [],
): string {
  return renderCharterPromptSection(charter, [], amendments);
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
    ? `${buildCharterSection(input.charter, input.charterAmendments ?? [])}\n\n`
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

  // Active checking, not preamble: rendered only when the charter declares
  // invariants so the guidance never references a section that isn't there.
  const invariantGuidanceLines =
    input.charter?.invariants && input.charter.invariants.length > 0
      ? [
          "- **Check every charter invariant.** The charter above declares invariants that must hold for every change. For each invariant that applies to this context's changes, verify it actually holds in the implementation; when one is violated, raise an issue and cite the invariant id in the issue description.",
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
    "- **Require a production call path for wiring criteria.** When a criterion requires a capability to exist or be wired — an event publication, route, notification, adapter, or control — it is satisfied only by a production call path that reaches it. An exported, unit-tested function with no production caller does not satisfy it. The only exemption is explicit deferral: an acceptance-criteria clause naming the downstream context that owns the wiring. With a named owner, record the deferral in your `summary` instead of failing; with no named owner, raise an issue.",
    ...invariantGuidanceLines,
    "- **Defer to the higher-ranked source on a charter conflict.** When an acceptance criterion conflicts with a higher-ranked source of truth and the implementation follows that higher-ranked source, do not fail the context solely for that acceptance-criterion mismatch — the higher-ranked source prevails. Instead, record the conflict in your `summary`, naming the affected acceptance criterion, the prevailing source, and the resolution. Evaluate each source's precedence within that source's declared applicability scope (`appliesTo`).",
    buildValidatorDeterministicChecksGuidance(
      input.validationSelections.scriptGate,
    ),
    "",
    ...validationSectionLines,
    "## Acceptance Criteria",
    "",
    input.context.acceptanceCriteria,
    "",
    ...(input.diffScopeSection ? [input.diffScopeSection, ""] : []),
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
    "- `issues` (array of `{ taskId, title, description }`): Each issue must reference the `taskId` of the task that needs to be reopened to address it. If the same problem touches multiple tasks in this context, include one issue entry per affected task (duplicate the entry with each distinct `taskId`).",
    "",
    "An empty `issues` array means the context passes validation. A non-empty `issues` array means every referenced task will be reopened.",
  ].join("\n");
}

export type ValidatorOutcome =
  | {
      kind: "pass";
      summary: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
    }
  | {
      kind: "fail";
      summary: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
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

/**
 * The outcome for a dispatch that failed, classified by whether it was ever
 * admitted. Both cases arrive here as opaque failure text, so the classification
 * has to happen at every site that turns one into an outcome — otherwise queue
 * pressure reaches the cohort disguised as a provider failure.
 */
function classifyDispatchFailure(
  message: string,
  engine: AgentBackendId,
): Extract<
  ValidatorOutcome,
  { kind: "infra_error" } | { kind: "queue_admission_timeout" }
> {
  return isQuerySlotAdmissionTimeout(message)
    ? { kind: "queue_admission_timeout", message, engine }
    : { kind: "infra_error", reason: "exception", message, engine };
}

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
    issues: WorkflowValidatorIssue[];
  },
  engine: AgentBackendId,
  allowedTaskIds: Set<string> | null,
): ValidatorOutcome {
  const invalidIssueTaskIds = validateIssueTaskIds(
    result.issues,
    allowedTaskIds,
  );
  if (invalidIssueTaskIds) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message: invalidIssueTaskIds,
      engine,
    };
  }

  if (result.issues.length === 0) {
    return {
      kind: "pass",
      summary: result.summary,
      issues: [],
      reopenTaskIds: [],
    };
  }

  return {
    kind: "fail",
    summary: result.summary,
    issues: result.issues,
    reopenTaskIds: deriveReopenTaskIds(result.issues),
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

/**
 * Maps a validator turn's output onto a `ValidatorOutcome` via the shared
 * structured-output module (extraction precedence native → raw JSON → last
 * fenced block, first schema-passing candidate wins), then applies the
 * validator-specific task-id containment check.
 */
export function parseValidatorResponse(
  text: string,
  engine: AgentBackendId,
  structuredOutput?: unknown,
  allowedTaskIds?: string[],
): ParsedValidatorResponse {
  const allowedTaskIdSet = allowedTaskIds ? new Set(allowedTaskIds) : null;

  const validated = validateStructuredOutput(
    workflowAgentValidatorResultSchema,
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
    result: wireResultToOutcome(validated.value, engine, allowedTaskIdSet),
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
   * working-tree-vs-HEAD computation. Injected in tests to avoid spawning git.
   */
  computeValidationDiffScope?: (
    worktreePath: string,
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
interface ValidatorTaskResult {
  text: string | null;
  structuredOutput?: unknown;
  transcript?: AgentTranscriptEntry[];
  error: string | null;
  timedOut: boolean;
  backendRef: AgentSessionRef | null;
  continuationDisposition: TaskRunResult["continuationDisposition"];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    costUsd: number | null;
  } | null;
}

interface ValidatorTaskInvocation {
  prompt: string;
  backend: AgentBackendId;
  workingDirectory: string;
  modelId: string | undefined;
  reasoningEffort: string | undefined;
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

function buildValidatorActorInput(
  invocation: ValidatorTaskInvocation,
  projectName: string,
): EnsureActorInputData {
  return {
    // A validator lane runs against a session worktree, not the project root.
    conversationScope: "session",
    projectName,
    sessionWorktreePath: invocation.workingDirectory,
    // A synthetic validator lane has no persisted ConversationState record, so
    // it runs the ephemeral persistence adapter — every durable side effect is
    // inert (previously these turns logged `Conversation not found in session`
    // on every syncDerived / mark-read / mark-unread transition).
    persistence: "ephemeral",
    conversation: {
      createdAt: new Date().toISOString(),
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: invocation.backend,
      backendRef: invocation.resumeRef ?? null,
      promptCount: 0,
      debugMode: null,
    },
  };
}

function extractValidatorUsage(
  result: TaskRunResult,
): ValidatorTaskResult["usage"] {
  const { inputTokens, outputTokens, cachedInputTokens, costUsd } =
    result.usage;
  if (
    inputTokens === null &&
    outputTokens === null &&
    cachedInputTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cachedInputTokens, costUsd };
}

function taskRunResultToValidatorTaskResult(
  result: TaskRunResult,
): ValidatorTaskResult {
  const usage = extractValidatorUsage(result);
  if (result.kind === "error") {
    return {
      text: null,
      ...(result.transcript !== undefined
        ? { transcript: result.transcript }
        : {}),
      error: result.error,
      timedOut: /timed out after/i.test(result.error),
      backendRef: result.backendRef ?? null,
      continuationDisposition: result.continuationDisposition,
      usage,
    };
  }
  if (result.kind === "structured") {
    return {
      text: result.text.length > 0 ? result.text : null,
      structuredOutput: result.structuredOutput,
      ...(result.transcript !== undefined
        ? { transcript: result.transcript }
        : {}),
      error: null,
      timedOut: false,
      backendRef: result.backendRef ?? null,
      continuationDisposition: result.continuationDisposition,
      usage,
    };
  }
  return {
    text: result.text,
    ...(result.transcript !== undefined
      ? { transcript: result.transcript }
      : {}),
    error: null,
    timedOut: false,
    backendRef: result.backendRef ?? null,
    continuationDisposition: result.continuationDisposition,
    usage,
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
  modelId: string | undefined;
  reasoningEffort: string | undefined;
  contextLimitTokens: number | undefined;
  allowedTaskIds: string[];
  overrideWorktreePath: string | undefined;
  pinnedConversationId: string | undefined;
}

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
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
    const actorInput = buildValidatorActorInput(invocation, projectName);

    const result = await executeWorkflowTaskRun({
      projectPath: invocation.projectPath,
      sessionName: invocation.sessionName,
      conversationId: invocation.conversationId,
      kind: "task_run",
      prompt: invocation.prompt,
      systemInstructions: invocation.systemInstructions,
      fsWritePolicy: invocation.fsWritePolicy,
      outputFormat: {
        type: "json_schema",
        schema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
      timeoutMs: invocation.timeoutMs,
      ...(invocation.modelId !== undefined
        ? { modelId: invocation.modelId }
        : {}),
      ...(invocation.reasoningEffort !== undefined
        ? { effort: invocation.reasoningEffort }
        : {}),
      actorInput,
      origin: {
        source: "workflow",
        workflow: {
          executionId: invocation.laneRef.workflowId,
          nodeId: invocation.laneRef.laneId,
          iterationIndex: 0,
        },
      },
    });

    return taskRunResultToValidatorTaskResult(result);
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
      modelId,
      reasoningEffort,
      contextLimitTokens,
      allowedTaskIds,
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
        prompt,
        systemInstructions,
        backend,
        workingDirectory: worktreePath,
        modelId,
        reasoningEffort,
        timeoutMs,
        resumeRef: undefined,
        laneRef: { workflowId: execution.id, laneId: lane },
        projectPath,
        sessionName,
        conversationId: noServiceConversationId,
        fsWritePolicy,
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
        const outcome: ValidatorOutcome = classifyDispatchFailure(
          taskResult.error,
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
      const { result: parsed, parsePath } = parseValidatorResponse(
        text,
        backend,
        taskResult.structuredOutput,
        allowedTaskIds,
      );

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
      prompt,
      systemInstructions,
      backend,
      workingDirectory: worktreePath,
      modelId,
      reasoningEffort,
      timeoutMs,
      resumeRef,
      laneRef: { workflowId: execution.id, laneId: lane },
      projectPath,
      sessionName,
      conversationId: dispatchConversationId,
      fsWritePolicy,
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
          result: classifyDispatchFailure(runnerError, backend),
          parsePath: "runner_error",
        }
      : parseValidatorResponse(
          text,
          backend,
          taskResult.structuredOutput,
          allowedTaskIds,
        );

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
   */
  async function renderScopedDiffSection(params: {
    executionId: string;
    contextId: string;
    inspection: InspectionWorktree;
    contextLimitTokens?: number;
    execLogger: ReturnType<typeof getExecutionLogger>;
  }): Promise<{ section: string; treeHash: string | null }> {
    const { executionId, contextId, inspection, execLogger } = params;

    let diffScope: ValidationDiffScope;
    if (inspection.worktreePath === undefined) {
      diffScope = {
        kind: "unavailable",
        reason: `scope computation error: ${inspection.resolveError ?? "worktree path unavailable"}`,
      };
    } else {
      try {
        diffScope = await computeValidationDiffScope(inspection.worktreePath);
      } catch (error) {
        diffScope = {
          kind: "unavailable",
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
      modelId: input.validator.agent.model,
      reasoningEffort: input.validator.agent.reasoningEffort,
    };
    const contextLimitTokens = input.validator.continuity.contextLimitTokens;
    const allowedTaskIds = getContextTaskIds(index, input.context.id);

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
    const prompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      taskStates: input.execution.taskStates,
      validator: input.validator,
      validationSelections,
      ...(input.context.charter ? { charter: input.context.charter } : {}),
      charterAmendments: input.execution.charterAmendments,
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

    // Role contract first, the assignment's seeded lens after it. Composed here
    // — above both adapters — because the ORDER is the security property and a
    // per-adapter decision could invert it (R10).
    const systemInstructions = composeWorkflowRoleInstructions({
      roleContract: buildValidatorRoleContract({
        verdictSchema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
      }),
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
        modelId: validatorPlan.modelId,
        reasoningEffort: validatorPlan.reasoningEffort,
        contextLimitTokens,
        allowedTaskIds,
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
        result: classifyDispatchFailure(errorMessage, validatorPlan.backend),
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runContextValidator, renderRoundCommonSections };
}
