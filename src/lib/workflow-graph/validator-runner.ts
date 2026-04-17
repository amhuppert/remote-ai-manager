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
import type { GraphWorkflowContextValidatorInput } from "./execution-validation";
import type {
  ResolveValidatorCallInput,
  ResolvedValidatorCall,
  RecordClaudeLaneTurnInput,
  RecordCodexLaneTurnInput,
} from "@/lib/workflows/graph-workflow/workflow-continuity-service";

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
          taskId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
    reopenTaskIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["pass", "summary", "issues", "reopenTaskIds"],
  additionalProperties: false,
} as const;

export interface BuildContextValidationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  taskStates: GraphWorkflowExecution["taskStates"];
  validator: GraphWorkflowAgentValidatorConfig;
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

  return [
    "# Context Validation",
    "",
    "You are a validation agent reviewing a completed execution context in a graph workflow.",
    "You must inspect files and verify the agent's claims.",
    "Check the completed context against the exact acceptance criteria below.",
    "",
    "## Acceptance Criteria",
    "",
    input.validator.acceptanceCriteria,
    "",
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
    "- `pass` (boolean): `true` only when the entire context meets the acceptance criteria",
    "- `summary` (string): Brief explanation of your assessment",
    "- `issues` (array of `{ title, description, taskId? }`): Specific problems found. Set `taskId` when the problem clearly belongs to one task in this context.",
    "- `reopenTaskIds` (array of task IDs): Tasks that must be reopened",
    "",
    "Response contract:",
    "- If `pass` is `true`, `reopenTaskIds` must be an empty array.",
    "- If `pass` is `false`, `reopenTaskIds` must contain one or more task IDs from this context.",
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
      engine: "claude" | "codex";
    };

function validateReopenedTaskIds(
  reopenTaskIds: string[],
  allowedTaskIds: Set<string> | null,
): string | null {
  if (!allowedTaskIds) return null;
  const invalidTaskIds = reopenTaskIds.filter(
    (taskId) => !allowedTaskIds.has(taskId),
  );
  if (invalidTaskIds.length === 0) {
    return null;
  }
  return `Validator output referenced tasks outside the context: ${invalidTaskIds.join(", ")}`;
}

function validateIssueTaskIds(
  issues: WorkflowValidatorIssue[],
  allowedTaskIds: Set<string> | null,
): string | null {
  if (!allowedTaskIds) return null;
  const invalidTaskIds = issues
    .map((issue) => issue.taskId)
    .filter(
      (taskId): taskId is string =>
        typeof taskId === "string" && !allowedTaskIds.has(taskId),
    );
  if (invalidTaskIds.length === 0) {
    return null;
  }
  return `Validator issues referenced tasks outside the context: ${invalidTaskIds.join(", ")}`;
}

function wireResultToOutcome(
  result: {
    pass: boolean;
    summary: string;
    issues: WorkflowValidatorIssue[];
    reopenTaskIds: string[];
  },
  engine: "claude" | "codex",
  allowedTaskIds: Set<string> | null,
): ValidatorOutcome {
  const invalidReopenTaskIds = validateReopenedTaskIds(
    result.reopenTaskIds,
    allowedTaskIds,
  );
  if (invalidReopenTaskIds) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message: invalidReopenTaskIds,
      engine,
    };
  }

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

  if (result.pass) {
    if (result.reopenTaskIds.length > 0 || result.issues.length > 0) {
      return {
        kind: "infra_error",
        reason: "schema_mismatch",
        message:
          "Validator output marked pass=true but still reported issues or reopened tasks.",
        engine,
      };
    }
    return {
      kind: "pass",
      summary: result.summary,
      issues: [],
      reopenTaskIds: [],
    };
  }

  if (result.reopenTaskIds.length === 0) {
    return {
      kind: "infra_error",
      reason: "schema_mismatch",
      message:
        "Validator output marked pass=false but did not provide reopenTaskIds.",
      engine,
    };
  }

  return {
    kind: "fail",
    summary: result.summary,
    issues: result.issues,
    reopenTaskIds: result.reopenTaskIds,
  };
}

export function extractValidatorResult(
  text: string,
  engine: "claude" | "codex",
  allowedTaskIds?: string[],
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

  return wireResultToOutcome(
    result.data,
    engine,
    allowedTaskIds ? new Set(allowedTaskIds) : null,
  );
}

export interface ParsedValidatorResponse {
  result: ValidatorOutcome;
  parsePath:
    | "structured_output"
    | "raw_json"
    | "fenced_json_block"
    | "fenced_json_block_fallback";
}

export function parseValidatorResponse(
  text: string,
  engine: "claude" | "codex",
  structuredOutput?: unknown,
  allowedTaskIds?: string[],
): ParsedValidatorResponse {
  const allowedTaskIdSet = allowedTaskIds ? new Set(allowedTaskIds) : null;

  if (structuredOutput != null) {
    const result =
      workflowAgentValidatorResultSchema.safeParse(structuredOutput);
    if (result.success) {
      return {
        result: wireResultToOutcome(result.data, engine, allowedTaskIdSet),
        parsePath: "structured_output",
      };
    }
  }

  try {
    const parsed = JSON.parse(text);
    const result = workflowAgentValidatorResultSchema.safeParse(parsed);
    if (result.success) {
      return {
        result: wireResultToOutcome(result.data, engine, allowedTaskIdSet),
        parsePath: "raw_json",
      };
    }
  } catch {
    // Fall through to fenced JSON extraction.
  }

  return {
    result: extractValidatorResult(text, engine, allowedTaskIds),
    parsePath: "fenced_json_block",
  };
}

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
  continuityService?: ValidatorContinuityService;
  executionRepository?: ValidatorContinuityRepository;
}

const backendRefCache = new Map<string, AgentSessionRef>();

function refCacheKey(executionId: string, lane: string): string {
  return `${executionId}:${lane}`;
}

const validatorLogger = createLogger("graph-workflow-validator");

function resolvedCallToResumeRef(
  resolved: ResolvedValidatorCall,
  executionId: string,
  lane: string,
): AgentSessionRef | null {
  if (resolved.sessionAction === "create") {
    backendRefCache.delete(refCacheKey(executionId, lane));
    return null;
  }

  const cached = backendRefCache.get(refCacheKey(executionId, lane));
  if (cached) return cached;

  if (resolved.engine === "codex") {
    return { backend: "codex", threadId: resolved.threadId };
  }

  return null;
}

function getContextTaskIds(
  execution: GraphWorkflowExecution,
  contextId: string,
): string[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .map((task) => task.id);
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
    lane: "context_validator",
    validatorType: "claude" | "codex",
    prompt: string,
    modelId: string | undefined,
    reasoningEffort: string | undefined,
    contextLimitTokens: number | undefined,
    allowedTaskIds: string[],
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
      const taskResult = await runner.run({ ...baseRequest, ...codexSettings });
      const text = taskResult.text ?? "";
      const { result: parsed, parsePath } = parseValidatorResponse(
        text,
        validatorType,
        taskResult.structuredOutput,
        allowedTaskIds,
      );

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        engine: validatorType,
        parsePath,
        kind: parsed.kind,
        issueCount: parsed.kind === "infra_error" ? 0 : parsed.issues.length,
        reopenTaskIds:
          parsed.kind === "infra_error" ? [] : parsed.reopenTaskIds,
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
      engine: validatorType,
    });

    const resumeRef = resolvedCallToResumeRef(resolved, execution.id, lane);
    const taskResult = await runner.run({
      ...baseRequest,
      ...codexSettings,
      resumeRef,
    });

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
      allowedTaskIds,
    );

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
          : (newThreadId ?? null);
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
        reopenTaskIds:
          parsed.kind === "infra_error" ? [] : parsed.reopenTaskIds,
        sessionAction: resolved.sessionAction,
        threadId: codexThreadId,
      });
      execLogger?.writeValidatorResponse(contextId, "context-validator.json", {
        raw: text,
        parsed,
        parsePath,
      });

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
      reopenTaskIds: parsed.kind === "infra_error" ? [] : parsed.reopenTaskIds,
      sessionAction: resolved.sessionAction,
      backendSessionId: backendSessionId || null,
    });
    execLogger?.writeValidatorResponse(contextId, "context-validator.json", {
      raw: text,
      parsed,
      parsePath,
    });

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

  async function runContextValidator(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult> {
    const contextTasks = input.execution.workingDefinition.tasks
      .filter((task) => task.contextId === input.context.id)
      .sort((left, right) => left.order - right.order);

    const prompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      taskStates: input.execution.taskStates,
      validator: input.validator,
    });

    const execLogger = getExecutionLogger(input.execution.id);
    execLogger?.writePrompt(input.context.id, "context-validator.md", prompt);
    execLogger?.validation(input.context.id, "context_validator.started", {
      engine: input.validator.type,
      promptLength: prompt.length,
      taskCount: contextTasks.length,
    });

    const contextLimitTokens = input.validator.continuity.contextLimitTokens;
    const allowedTaskIds = getContextTaskIds(input.execution, input.context.id);

    try {
      if (input.validator.type === "codex") {
        return await runValidatorTurn(
          input.projectPath,
          input.sessionName,
          input.execution,
          "context_validator",
          "codex",
          prompt,
          input.validator.codex.model,
          input.validator.codex.reasoningEffort,
          contextLimitTokens,
          allowedTaskIds,
        );
      }

      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        "context_validator",
        "claude",
        prompt,
        input.validator.agent.model,
        input.validator.agent.reasoningEffort,
        contextLimitTokens,
        allowedTaskIds,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      execLogger?.validation(input.context.id, "context_validator.error", {
        engine: input.validator.type,
        error: errorMessage,
      });
      execLogger?.validation(input.context.id, "validator.infra_error", {
        lane: "context_validator",
        engine: input.validator.type,
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
          engine: input.validator.type,
        },
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runContextValidator };
}
