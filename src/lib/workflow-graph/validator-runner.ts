import { workflowAgentValidatorResultSchema } from "@/lib/schemas";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowLaneKind,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationReviewArtifact,
  WorkflowValidatorIssue,
} from "@/types";
import type {
  AgentBackendId,
  AgentSessionRef,
} from "@/lib/agent-backends/types";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type { GraphWorkflowTaskValidatorInput } from "./execution-validation";
import type {
  ResolveValidatorCallInput,
  ResolvedValidatorCall,
  RecordClaudeLaneTurnInput,
  RecordCodexLaneTurnInput,
} from "@/lib/workflows/graph-workflow/workflow-continuity-service";

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
  },
  required: ["pass", "summary", "issues"],
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
  ].join("\n");
}

// -- Result parsing -----------------------------------------------------------

/**
 * Discriminated outcome produced by the validator runner. `pass` and `fail`
 * represent legitimate validator decisions; `infra_error` represents transport
 * or parsing failures that must not count against the circuit breaker.
 */
export type ValidatorOutcome =
  | {
      kind: "pass";
      summary: string;
      issues: WorkflowValidatorIssue[];
    }
  | {
      kind: "fail";
      summary: string;
      issues: WorkflowValidatorIssue[];
    }
  | {
      kind: "infra_error";
      reason: "exception" | "unparseable" | "schema_mismatch";
      message: string;
      engine: "claude" | "codex";
    };

/**
 * Map a schema-valid wire result into a pass/fail outcome. Preserves the
 * existing `pass: true + issues non-empty → fail` normalization semantics.
 */
function wireResultToOutcome(result: {
  pass: boolean;
  summary: string;
  issues: WorkflowValidatorIssue[];
}): ValidatorOutcome {
  const isPass = result.pass && result.issues.length === 0;
  if (isPass) {
    return { kind: "pass", summary: result.summary, issues: result.issues };
  }
  return { kind: "fail", summary: result.summary, issues: result.issues };
}

/**
 * Extract and parse a validator outcome from agent text output.
 * Looks for the last ```json fenced block and parses it with the schema.
 * Returns an infra_error outcome when extraction, JSON parsing, or schema
 * validation fails.
 */
export function extractValidatorResult(
  text: string,
  engine: "claude" | "codex",
): ValidatorOutcome {
  const jsonBlocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (jsonBlocks.length === 0) {
    return {
      kind: "infra_error",
      reason: "unparseable",
      message: "Validator agent did not return a JSON block",
      engine,
    };
  }

  const lastBlock = jsonBlocks[jsonBlocks.length - 1]!;
  const raw = lastBlock[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "infra_error",
      reason: "unparseable",
      message:
        error instanceof Error
          ? `JSON parse failed: ${error.message}`
          : "JSON parse failed",
      engine,
    };
  }

  const result = workflowAgentValidatorResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message: `Validator output did not match schema: ${result.error.message}`,
      engine,
    };
  }

  return wireResultToOutcome(result.data);
}

export interface ParsedValidatorResponse {
  result: ValidatorOutcome;
  parsePath:
    | "structured_output"
    | "raw_json"
    | "fenced_json_block"
    | "fenced_json_block_fallback";
}

/**
 * Parse a validator response, trying structured output first, then raw JSON,
 * then fenced ```json block extraction as a fallback.
 * Returns both the outcome and which parse path succeeded.
 */
export function parseValidatorResponse(
  text: string,
  engine: "claude" | "codex",
  structuredOutput?: unknown,
): ParsedValidatorResponse {
  // Path 1: structured output from SDK (both Claude and Codex)
  if (structuredOutput != null) {
    const result =
      workflowAgentValidatorResultSchema.safeParse(structuredOutput);
    if (result.success)
      return {
        result: wireResultToOutcome(result.data),
        parsePath: "structured_output",
      };
  }

  // Path 2: raw JSON string (Codex outputSchema response)
  try {
    const parsed = JSON.parse(text);
    const result = workflowAgentValidatorResultSchema.safeParse(parsed);
    if (result.success)
      return {
        result: wireResultToOutcome(result.data),
        parsePath: "raw_json",
      };
  } catch {
    /* not raw JSON, try fenced block */
  }

  // Path 3: fenced ```json block (legacy fallback)
  return {
    result: extractValidatorResult(text, engine),
    parsePath: "fenced_json_block",
  };
}

// -- Validator runner ---------------------------------------------------------

export interface ValidatorExecutionMetadata {
  sessionRef: AgentSessionRef | null;
  reviewArtifact: GraphWorkflowValidationReviewArtifact | null;
  limitEvaluation: "disabled" | "supported" | "unsupported";
  rotateBeforeNextTurn: boolean;
}

export interface ValidatorRunResult {
  result: ValidatorOutcome;
  metadata: ValidatorExecutionMetadata;
}

export interface ValidatorContinuityService {
  resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall>;
  recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): GraphWorkflowExecution;
  recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): GraphWorkflowExecution;
}

export interface ValidatorContinuityRepository {
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
}

export interface ValidatorRunnerDeps {
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
  resolveWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
  resolveTimeoutMs(validatorType: "claude" | "codex"): Promise<number>;
  /** When provided, validator runs route through the continuity service for session reuse. */
  continuityService?: ValidatorContinuityService;
  /** Required when continuityService is provided — persists updated lane state. */
  executionRepository?: ValidatorContinuityRepository;
}

// In-memory cache of backend session refs for task runner resume.
// Keyed by "executionId:lane", stores the backendRef from the last task result.
const backendRefCache = new Map<string, AgentSessionRef>();

function refCacheKey(executionId: string, lane: string): string {
  return `${executionId}:${lane}`;
}

const validatorLogger = createLogger("graph-workflow-validator");

/**
 * Convert a continuity service resolve result to an AgentSessionRef for resume.
 * Returns null when no valid resume ref is available.
 */
function resolvedCallToResumeRef(
  resolved: ResolvedValidatorCall,
  executionId: string,
  lane: string,
): AgentSessionRef | null {
  if (resolved.sessionAction === "create") {
    backendRefCache.delete(refCacheKey(executionId, lane));
    return null;
  }

  // Prefer cached backend ref from previous task runner result
  const cached = backendRefCache.get(refCacheKey(executionId, lane));
  if (cached) return cached;

  // For Codex, the continuity service threadId maps directly to AgentSessionRef
  if (resolved.engine === "codex") {
    return { backend: "codex", threadId: resolved.threadId };
  }

  // For Claude, the continuity service stores a CC conversationId which
  // cannot be used as a Claude SDK sessionId for task runner resume
  return null;
}

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
  async function persistLaneState(
    projectPath: string,
    sessionName: string,
    updated: GraphWorkflowExecution,
  ): Promise<void> {
    await deps.executionRepository?.update(projectPath, sessionName, updated);
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
    lane: GraphWorkflowLaneKind,
  ): {
    limitEvaluation: "disabled" | "supported" | "unsupported";
    rotateBeforeNextTurn: boolean;
  } {
    const laneState = updatedExecution.laneStates[lane];
    if (!laneState) {
      return {
        limitEvaluation: "disabled",
        rotateBeforeNextTurn: false,
      };
    }
    return {
      limitEvaluation: laneState.limitEvaluation,
      rotateBeforeNextTurn: laneState.rotateBeforeNextTurn,
    };
  }

  async function runValidatorTurn(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    lane: "task_validator",
    validatorType: "claude" | "codex",
    prompt: string,
    modelId: string | undefined,
    reasoningEffort: string | undefined,
    contextLimitTokens: number | undefined,
  ): Promise<ValidatorRunResult> {
    const contextId = execution.activeContextId ?? "";
    const execLogger = getExecutionLogger(execution.id);
    const runner = deps.getTaskRunner(validatorType);

    const worktreePath = await deps.resolveWorktreePath(
      projectPath,
      sessionName,
    );
    const timeoutMs = await deps.resolveTimeoutMs(validatorType);

    execLogger?.validation(contextId, "validator.invoked", {
      lane,
      engine: validatorType,
      hasContinuityService: !!deps.continuityService,
    });
    validatorLogger.info("graph-workflow.validator.invoked", {
      executionId: execution.id,
      lane,
      engine: validatorType,
    });

    const baseRequest = {
      workingDirectory: worktreePath,
      prompt,
      modelId,
      reasoningEffort,
      autonomous: true,
      timeoutMs,
      outputSchema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
    };

    // Codex-specific execution controls — explicit, not relying on runner defaults
    const codexSettings =
      validatorType === "codex"
        ? {
            sandboxMode: "danger-full-access" as const,
            approvalPolicy: "never" as const,
            webSearchMode: "disabled" as const,
            skipGitRepoCheck: true,
            networkAccessEnabled: true,
          }
        : {};

    if (!deps.continuityService) {
      // One-shot without lane tracking
      const taskResult = await runner.run({ ...baseRequest, ...codexSettings });
      const text = taskResult.text ?? "";
      const { result: parsed, parsePath } = parseValidatorResponse(
        text,
        validatorType,
        taskResult.structuredOutput,
      );

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        engine: validatorType,
        parsePath,
        kind: parsed.kind,
        issueCount: parsed.kind === "infra_error" ? 0 : parsed.issues.length,
      });
      if (parsed.kind === "infra_error") {
        execLogger?.validation(contextId, "validator.infra_error", {
          lane,
          engine: validatorType,
          reason: parsed.reason,
          message: parsed.message,
        });
        validatorLogger.warn("graph-workflow.validator.infra_error", {
          executionId: execution.id,
          lane,
          engine: validatorType,
          reason: parsed.reason,
        });
      }

      return {
        result: parsed,
        metadata: buildNoServiceMetadata(),
      };
    }

    // With continuity service — resolve session action and resume ref
    const resolved = await deps.continuityService.resolveValidatorCall({
      execution,
      projectPath,
      sessionName,
      contextId,
      lane,
      engine: validatorType,
    });

    const resumeRef = resolvedCallToResumeRef(resolved, execution.id, lane);

    validatorLogger.info("graph-workflow.validator.session_resolved", {
      executionId: execution.id,
      lane,
      engine: validatorType,
      sessionAction: resolved.sessionAction,
      hasResumeRef: !!resumeRef,
    });

    const taskResult = await runner.run({
      ...baseRequest,
      ...codexSettings,
      resumeRef,
    });

    // Cache the backend ref for future resume
    if (taskResult.backendRef) {
      backendRefCache.set(
        refCacheKey(execution.id, lane),
        taskResult.backendRef,
      );
    }

    const text = taskResult.text ?? "";
    const { result: parsed, parsePath } = parseValidatorResponse(
      text,
      validatorType,
      taskResult.structuredOutput,
    );
    if (parsed.kind === "infra_error") {
      execLogger?.validation(contextId, "validator.infra_error", {
        lane,
        engine: validatorType,
        reason: parsed.reason,
        message: parsed.message,
      });
      validatorLogger.warn("graph-workflow.validator.infra_error", {
        executionId: execution.id,
        lane,
        engine: validatorType,
        reason: parsed.reason,
      });
    }

    // Record outcome with the continuity service for rotation tracking
    if (validatorType === "codex") {
      const newThreadId =
        taskResult.backendRef?.backend === "codex"
          ? taskResult.backendRef.threadId
          : null;
      const usage = taskResult.usage
        ? {
            inputTokens: taskResult.usage.inputTokens ?? 0,
            cachedInputTokens: taskResult.usage.cachedInputTokens ?? 0,
            outputTokens: taskResult.usage.outputTokens ?? 0,
          }
        : null;

      const updatedExecution = deps.continuityService.recordCodexTurnOutcome({
        execution: resolved.execution,
        lane,
        usage,
        contextLimitTokens,
        newThreadId,
      });
      await persistLaneState(projectPath, sessionName, updatedExecution);

      const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
        updatedExecution,
        lane,
      );

      const codexThreadId =
        taskResult.backendRef?.backend === "codex"
          ? taskResult.backendRef.threadId
          : (newThreadId ?? "");
      const reviewArtifact: GraphWorkflowValidationReviewArtifact | null =
        codexThreadId
          ? { engine: "codex", threadId: codexThreadId, response: text, usage }
          : null;

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        engine: "codex",
        parsePath,
        kind: parsed.kind,
        issueCount: parsed.kind === "infra_error" ? 0 : parsed.issues.length,
        summary:
          parsed.kind === "infra_error" ? parsed.message : parsed.summary,
        sessionAction: resolved.sessionAction,
        threadId: codexThreadId,
        usage,
      });
      execLogger?.writeValidatorResponse(
        contextId,
        `${lane}-codex-response.json`,
        { raw: text, parsed, parsePath },
      );

      return {
        result: parsed,
        metadata: {
          sessionRef: taskResult.backendRef ?? null,
          reviewArtifact,
          limitEvaluation,
          rotateBeforeNextTurn,
        },
      };
    }

    // Claude path
    const updatedExecution = deps.continuityService.recordClaudeTurnOutcome({
      execution: resolved.execution,
      lane,
      contextTokens: null,
      contextWindowMax: null,
      contextLimitTokens,
    });
    await persistLaneState(projectPath, sessionName, updatedExecution);

    const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
      updatedExecution,
      lane,
    );

    const backendSessionId =
      taskResult.backendRef?.backend === "claude"
        ? taskResult.backendRef.sessionId
        : "";
    const reviewArtifact: GraphWorkflowValidationReviewArtifact | null =
      backendSessionId
        ? { engine: "claude", conversationId: backendSessionId }
        : null;

    execLogger?.validation(contextId, "validator.result_parsed", {
      lane,
      engine: "claude",
      parsePath,
      kind: parsed.kind,
      issueCount: parsed.kind === "infra_error" ? 0 : parsed.issues.length,
      summary: parsed.kind === "infra_error" ? parsed.message : parsed.summary,
      sessionAction: resolved.sessionAction,
      backendSessionId: backendSessionId || null,
    });
    execLogger?.writeValidatorResponse(
      contextId,
      `${lane}-claude-response.json`,
      { raw: text, parsed, parsePath },
    );

    return {
      result: parsed,
      metadata: {
        sessionRef: taskResult.backendRef ?? null,
        reviewArtifact,
        limitEvaluation,
        rotateBeforeNextTurn,
      },
    };
  }

  async function runTaskValidator(
    input: GraphWorkflowTaskValidatorInput,
  ): Promise<ValidatorRunResult> {
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

    const execLogger = getExecutionLogger(input.execution.id);
    execLogger?.writePrompt(
      input.context.id,
      `task-validation-${input.task.id}.md`,
      prompt,
    );
    execLogger?.validation(input.context.id, "task_validator.started", {
      taskId: input.task.id,
      engine: input.validator.type,
      promptLength: prompt.length,
    });

    const contextLimitTokens = input.validator.continuity.contextLimitTokens;

    try {
      if (input.validator.type === "codex") {
        const validator = input.validator;
        return await runValidatorTurn(
          input.projectPath,
          input.sessionName,
          input.execution,
          "task_validator",
          "codex",
          prompt,
          validator.codex.model,
          validator.codex.reasoningEffort,
          contextLimitTokens,
        );
      }

      const validator = input.validator;
      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        "task_validator",
        "claude",
        prompt,
        validator.agent.model,
        validator.agent.reasoningEffort,
        contextLimitTokens,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      execLogger?.validation(input.context.id, "task_validator.error", {
        taskId: input.task.id,
        engine: input.validator.type,
        error: errorMessage,
      });
      execLogger?.validation(input.context.id, "validator.infra_error", {
        lane: "task_validator",
        engine: input.validator.type,
        reason: "exception",
        message: errorMessage,
      });
      validatorLogger.error("graph-workflow.task_validator.error", {
        executionId: input.execution.id,
        contextId: input.context.id,
        taskId: input.task.id,
        error: errorMessage,
      });
      validatorLogger.warn("graph-workflow.validator.infra_error", {
        executionId: input.execution.id,
        lane: "task_validator",
        engine: input.validator.type,
        reason: "exception",
      });
      return {
        result: {
          kind: "infra_error",
          reason: "exception",
          message: errorMessage,
          engine: input.validator.type,
        },
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runTaskValidator };
}
