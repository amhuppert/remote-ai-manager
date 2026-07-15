import { workflowAgentValidatorResultSchema } from "@/lib/workflow-graph/definition-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { renderCharterPromptSection } from "@/lib/workflow-graph/charter/render";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import {
  buildGraphWorkflowValidationReviewArtifact,
  type GraphWorkflowValidationEventSessionRef,
  type GraphWorkflowValidationReviewArtifact,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";
import {
  resolveGraphWorkflowValidatorExecutionPlan,
  type GraphWorkflowAgentValidatorConfig,
} from "@/lib/workflow-graph/config-schemas";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import { buildAskUserQuestionsReminderSection } from "./iteration-prompt";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { LaneConversationPendingState } from "./user-input-gate";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { GraphWorkflowContextValidatorInput } from "./execution-validation";
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
import type { EnsureActorInputData } from "@/lib/workflows/conversation/manager";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { getConversation as defaultGetConversation } from "@/lib/state-store";
import {
  computeValidationDiffScope as defaultComputeValidationDiffScope,
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
  context: GraphWorkflowResolvedContext;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: GraphWorkflowExecution["taskStates"];
  validator: GraphWorkflowAgentValidatorConfig;
  // Optional because the resolved context carries an optional charter; when
  // present the digest is prepended so the prompt opens with it (4.2).
  charter?: WorkflowCharter;
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
}

/**
 * The effective ask-user-questions flag for a context validator turn: the
 * context's resolved toggle AND a conversation strategy whose backend supports
 * native mid-turn asking (Req 8.1). Pure so the suppression rule is
 * unit-testable in isolation.
 */
export function resolveValidatorAskUserQuestionsEnabled(
  validator: GraphWorkflowAgentValidatorConfig,
  context: GraphWorkflowResolvedContext,
): boolean {
  const plan = resolveGraphWorkflowValidatorExecutionPlan(validator);
  return (
    plan.strategy === "conversation" &&
    context.askUserQuestions.enabled &&
    getBackendDescriptor(plan.backend).conversation?.capabilities
      .nativeMidTurnAskUser === true
  );
}

function buildCharterSection(charter: WorkflowCharter): string {
  return renderCharterPromptSection(charter);
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
    ? `${buildCharterSection(input.charter)}\n\n`
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
    "- **Defer to the higher-ranked source on a charter conflict.** When an acceptance criterion conflicts with a higher-ranked source of truth and the implementation follows that higher-ranked source, do not fail the context solely for that acceptance-criterion mismatch — the higher-ranked source prevails. Instead, record the conflict in your `summary`, naming the affected acceptance criterion, the prevailing source, and the resolution. Evaluate each source's precedence within that source's declared applicability scope (`appliesTo`).",
    "- **Do not enforce deterministic checks.** You must not fail the context for failing tests, type errors, lint violations, build failures, or compile errors. Those concerns are handled separately by the project's pre-merge validation script and are not your responsibility. Focus on judgments that only a reviewing agent can make.",
    "",
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
  sessionRef: GraphWorkflowValidationEventSessionRef | null;
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
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

export interface ValidatorRunnerDeps {
  resolveWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
  resolveTimeoutMs(backend: AgentBackendId): Promise<number>;
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
  conversationId: string,
): GraphWorkflowValidationEventSessionRef {
  return {
    backend,
    ref: conversationId,
    lane,
    refKind: "conversation",
    workflowConversationId: conversationId,
  };
}

function buildTaskValidationSessionRef(
  execution: GraphWorkflowExecution,
  contextId: string,
  lane: GraphWorkflowLaneKind,
  backend: AgentBackendId,
  continuationDisposition: TaskRunResult["continuationDisposition"],
): GraphWorkflowValidationEventSessionRef | null {
  if (continuationDisposition === "clear") return null;

  const laneState = execution.laneStates[contextId]?.[lane];
  if (
    laneState?.refKind !== "backend" ||
    laneState.sessionRef?.backend !== backend
  ) {
    return null;
  }

  return {
    ...laneState.sessionRef,
    lane,
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
}

function syntheticValidatorConversationId(
  executionId: string,
  contextId: string,
  lane: GraphWorkflowLaneKind,
  backend: AgentBackendId,
): string {
  return `__validator__:${executionId}:${contextId}:${lane}:${backend}`;
}

function buildValidatorActorInput(
  invocation: ValidatorTaskInvocation,
  projectName: string,
): EnsureActorInputData {
  return {
    projectName,
    sessionWorktreePath: invocation.workingDirectory,
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

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  const getProjectDisplayName =
    deps.getProjectDisplayName ?? defaultGetProjectDisplayName;
  const computeValidationDiffScope =
    deps.computeValidationDiffScope ?? defaultComputeValidationDiffScope;
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
    transform: (
      latest: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
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
  ): {
    limitEvaluation:
      | "disabled"
      | "supported"
      | "unsupported"
      | "metrics_unavailable";
    rotateBeforeNextTurn: boolean;
  } {
    const laneState = updatedExecution.laneStates[contextId]?.[lane];
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
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    contextId: string,
    lane: "context_validator",
    strategy: ValidatorExecutionStrategy,
    backend: AgentBackendId,
    prompt: string,
    modelId: string | undefined,
    reasoningEffort: string | undefined,
    contextLimitTokens: number | undefined,
    allowedTaskIds: string[],
    overrideWorktreePath: string | undefined,
    pinnedConversationId: string | undefined,
  ): Promise<ValidatorRunResult> {
    const execLogger = getExecutionLogger(execution.id);
    const worktreePath =
      overrideWorktreePath ??
      (await deps.resolveWorktreePath(projectPath, sessionName));
    const timeoutMs = await deps.resolveTimeoutMs(backend);

    execLogger?.validation(contextId, "validator.invoked", {
      lane,
      engine: backend,
      hasContinuityService: !!deps.continuityService,
    });
    validatorLogger.info("graph-workflow.validator.invoked", {
      executionId: execution.id,
      lane,
      engine: backend,
      strategy,
    });

    if (!deps.continuityService) {
      const noServiceConversationId = syntheticValidatorConversationId(
        execution.id,
        contextId,
        lane,
        backend,
      );
      const taskResult = await dispatchValidatorTurn({
        prompt,
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
      });

      if (taskResult.transcript) {
        execLogger?.writeValidatorTranscript(
          contextId,
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
        const outcome: ValidatorOutcome = {
          kind: "infra_error",
          reason: "exception",
          message: taskResult.error,
          engine: backend,
        };
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
      backend,
      strategy,
      pinnedConversationId,
    });

    const resolvedLaneState =
      resolved.execution.laneStates[contextId]?.[lane] ?? null;

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
            [lane]: resolvedLaneState,
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
            [lane]: laneStateForDispatch,
          },
        },
      }));
    }
    const taskResult = await dispatchValidatorTurn({
      prompt,
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
    });

    if (taskResult.transcript) {
      execLogger?.writeValidatorTranscript(
        contextId,
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
                  resolved.conversationId,
                )
              : buildTaskValidationSessionRef(
                  resolved.execution,
                  contextId,
                  lane,
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
          result: {
            kind: "infra_error",
            reason: "exception",
            message: runnerError,
            engine: backend,
          },
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
      );

      const sessionRef = buildTaskValidationSessionRef(
        updatedExecution,
        contextId,
        lane,
        backend,
        taskResult.continuationDisposition,
      );
      const responseRef =
        taskResult.backendRef?.backend === backend
          ? taskResult.backendRef.ref
          : updatedExecution.laneStates[contextId]?.[lane]?.sessionRef
                ?.backend === backend
            ? (updatedExecution.laneStates[contextId]?.[lane]?.sessionRef
                ?.ref ?? null)
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
        engine: backend,
        parsePath,
        kind: parsed.kind,
        ...validatorOutcomeLogFields(parsed),
        sessionAction: resolved.sessionAction,
        threadId: responseRef,
      });
      execLogger?.writeValidatorResponse(contextId, "context-validator.json", {
        raw: text,
        parsed,
        parsePath,
      });

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
    );

    const backendSessionId = Object.is(taskResult.backendRef?.backend, backend)
      ? (taskResult.backendRef?.ref ?? null)
      : null;
    const conversationSessionRef = buildConversationValidationSessionRef(
      backend,
      lane,
      resolved.conversationId,
    );
    const reviewArtifact = buildGraphWorkflowValidationReviewArtifact({
      backend,
      strategy,
      ref: resolved.conversationId,
      response: text,
      usage: null,
    });

    execLogger?.validation(contextId, "validator.result_parsed", {
      lane,
      engine: backend,
      parsePath,
      kind: parsed.kind,
      ...validatorOutcomeLogFields(parsed),
      sessionAction: resolved.sessionAction,
      backendSessionId,
    });
    execLogger?.writeValidatorResponse(contextId, "context-validator.json", {
      raw: text,
      parsed,
      parsePath,
    });

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

  async function runContextValidator(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult> {
    const index = createExecutionIndex(
      input.execution.workingDefinition,
      input.execution,
    );
    const contextTasks = index.tasksByContext.get(input.context.id) ?? [];
    const execLogger = getExecutionLogger(input.execution.id);
    const validatorPlan = resolveGraphWorkflowValidatorExecutionPlan(
      input.validator,
    );
    const contextLimitTokens = input.validator.continuity.contextLimitTokens;
    const allowedTaskIds = getContextTaskIds(index, input.context.id);

    // Resolve the exact worktree the validator will inspect, then compute the
    // context's uncommitted change set there. Diff scoping is default-on and
    // degraded-not-fatal: any failure yields an "unavailable" scope rather than
    // halting validation, and the validator falls back to AC-only review.
    const targetWorktreePath = input.executionTarget?.worktreePath;
    let resolvedWorktreePath: string | undefined;
    let diffScope: ValidationDiffScope;
    try {
      resolvedWorktreePath =
        targetWorktreePath ??
        (await deps.resolveWorktreePath(input.projectPath, input.sessionName));
      diffScope = await computeValidationDiffScope(resolvedWorktreePath);
    } catch (error) {
      diffScope = {
        kind: "unavailable",
        reason: `scope computation error: ${getErrorMessage(error)}`,
      };
    }

    const renderedDiffScope = renderDiffScopeSection(diffScope, {
      contextLimitTokens,
    });
    const diffScopeWorktreePath =
      resolvedWorktreePath ?? targetWorktreePath ?? null;

    if (diffScope.kind === "unavailable") {
      execLogger?.validation(input.context.id, "diff_scope.unavailable", {
        worktreePath: diffScopeWorktreePath,
        reason: diffScope.reason,
      });
      validatorLogger.warn("graph-workflow.validator.diff_scope.unavailable", {
        executionId: input.execution.id,
        contextId: input.context.id,
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
        input.context.id,
        "diff_scope.computed",
        diffScopeMetadata,
      );
      validatorLogger.info("graph-workflow.validator.diff_scope.computed", {
        executionId: input.execution.id,
        contextId: input.context.id,
        ...diffScopeMetadata,
      });
    }

    const prompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      taskStates: input.execution.taskStates,
      validator: input.validator,
      ...(input.context.charter ? { charter: input.context.charter } : {}),
      diffScopeSection: renderedDiffScope.section,
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

    execLogger?.writePrompt(input.context.id, "context-validator.md", prompt);
    execLogger?.validation(input.context.id, "context_validator.started", {
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
      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        input.context.id,
        "context_validator",
        validatorPlan.strategy,
        validatorPlan.backend,
        prompt,
        validatorPlan.modelId,
        validatorPlan.reasoningEffort,
        contextLimitTokens,
        allowedTaskIds,
        overrideWorktreePath,
        input.resumeUserInput?.conversationId,
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      execLogger?.validation(input.context.id, "context_validator.error", {
        engine: validatorPlan.backend,
        error: errorMessage,
      });
      execLogger?.validation(input.context.id, "validator.infra_error", {
        lane: "context_validator",
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
        result: {
          kind: "infra_error",
          reason: "exception",
          message: errorMessage,
          engine: validatorPlan.backend,
        },
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runContextValidator };
}
