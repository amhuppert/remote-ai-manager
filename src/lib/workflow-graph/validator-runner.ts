import { workflowAgentValidatorResultSchema } from "@/lib/schemas";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import type {
  AgentTaskResult,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowResolvedContext,
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
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";

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
    "Your job is to judge the *intent* of the acceptance criteria and decide whether the completed tasks satisfy that intent closely enough for the purposes of the overall objective.",
    "",
    "## Evaluation Guidance",
    "",
    "- **Intent over strict wording.** Acceptance criteria may be imprecise. Use judgment to decide whether the completed work satisfies the intent of the criteria. Do not reject work that meets the spirit of the criteria simply because the wording differs or a detail is fuzzy.",
    "- **Respect context scope boundaries.** This execution context is one step in a larger graph workflow. Work that is explicitly out of scope for this context — for example, type updates or cleanup handled by a downstream context, or integration work reserved for another context — must not cause this context to fail. If the current context produced the intermediate state it is responsible for, treat that as success even if the wider codebase is not yet fully consistent.",
    "- **Do not enforce deterministic checks.** You must not fail the context for failing tests, type errors, lint violations, build failures, or compile errors. Those concerns are handled separately by the project's pre-merge validation script and are not your responsibility. Focus on judgments that only a reviewing agent can make.",
    "",
    "## Acceptance Criteria",
    "",
    input.context.acceptanceCriteria,
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
      engine: "claude" | "codex";
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
  engine: "claude" | "codex",
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
    | "fenced_json_block_fallback"
    | "runner_error";
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
  ): Promise<GraphWorkflowExecution>;
  recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): Promise<GraphWorkflowExecution>;
}

export interface ValidatorContinuityRepository {
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
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
  /**
   * Optional override for the AgentCall primitive entry point. The validator
   * routes every task-style turn through `executeAgentCall` so the facade
   * applies the structured-output gate and uniform failure normalization.
   */
  executeAgentCall?: (
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ) => Promise<AgentCallResult>;
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

function getContextTaskIds(index: ExecutionIndex, contextId: string): string[] {
  return (index.tasksByContext.get(contextId) ?? []).map((task) => task.id);
}

interface ValidatorTaskInvocation {
  prompt: string;
  backend: "claude" | "codex";
  workingDirectory: string;
  modelId: string | undefined;
  reasoningEffort: string | undefined;
  timeoutMs: number;
  resumeRef: AgentSessionRef | null | undefined;
  laneRef: { workflowId: string; laneId: GraphWorkflowLaneKind };
}

function isCodexHardenedSettingsBackend(
  backend: "claude" | "codex",
): backend is "codex" {
  return backend === "codex";
}

function agentCallResultToTaskResult(result: AgentCallResult): AgentTaskResult {
  if (result.outcome.kind === "completed") {
    const completed: AgentTaskResult = {
      text: result.outcome.text,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          }
        : null,
      error: null,
      timedOut: false,
      backendRef: result.backendRef ?? null,
    };
    if (result.outcome.structuredOutput !== undefined) {
      completed.structuredOutput = result.outcome.structuredOutput;
    }
    return completed;
  }

  if (result.outcome.kind === "failed") {
    return {
      text: null,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          }
        : null,
      error: result.outcome.error.message,
      timedOut: result.outcome.error.failureKind === "timeout",
      backendRef: result.backendRef ?? null,
    };
  }

  return {
    text: null,
    usage: null,
    error: `validator paused unexpectedly (pauseKind=${result.outcome.pauseKind})`,
    timedOut: false,
    backendRef: result.backendRef ?? null,
  };
}

export function createValidatorRunner(deps: ValidatorRunnerDeps) {
  const executeAgentCall = deps.executeAgentCall ?? defaultExecuteAgentCall;

  async function dispatchValidatorTurn(
    invocation: ValidatorTaskInvocation,
  ): Promise<AgentTaskResult> {
    const runner = deps.getTaskRunner(invocation.backend);
    const codexSettings = isCodexHardenedSettingsBackend(invocation.backend)
      ? {
          sandboxMode: "danger-full-access" as const,
          approvalPolicy: "never" as const,
          webSearchMode: "disabled" as const,
          skipGitRepoCheck: true,
          networkAccessEnabled: true,
        }
      : {};

    const request: AgentCallRequest = {
      kind: "task_run",
      backend: invocation.backend,
      prompt: invocation.prompt,
      writeCapability: "write_capable",
      outputSchema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
      timeoutMs: invocation.timeoutMs,
      laneRef: {
        workflowId: invocation.laneRef.workflowId,
        laneId: invocation.laneRef.laneId,
      },
    };

    const result = await executeAgentCall(request, {
      resolveTaskRunner: () => ({
        runner,
        capabilityView: capabilityViewForBackend(invocation.backend),
        workingDirectory: invocation.workingDirectory,
        autonomous: true,
        defaultTimeoutMs: invocation.timeoutMs,
        ...(invocation.modelId !== undefined
          ? { modelId: invocation.modelId }
          : {}),
        ...(invocation.reasoningEffort !== undefined
          ? { reasoningEffort: invocation.reasoningEffort }
          : {}),
        ...(invocation.resumeRef !== undefined
          ? { resumeRef: invocation.resumeRef }
          : {}),
        ...codexSettings,
      }),
      // The validator runner parses fenced JSON, raw JSON, and structured
      // output via `parseValidatorResponse`, so the post-dispatch gate is
      // intentionally bypassed here — schema enforcement still happens at
      // the runner level via the forwarded `outputSchema` request field.
      validateStructuredOutput: () => ({ valid: true }),
    });

    return agentCallResultToTaskResult(result);
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
    limitEvaluation: "disabled" | "supported" | "unsupported";
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
      rotateBeforeNextTurn: laneState.rotateBeforeNextTurn,
    };
  }

  async function runValidatorTurn(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    contextId: string,
    lane: "context_validator",
    validatorType: "claude" | "codex",
    prompt: string,
    modelId: string | undefined,
    reasoningEffort: string | undefined,
    contextLimitTokens: number | undefined,
    allowedTaskIds: string[],
    overrideWorktreePath: string | undefined,
  ): Promise<ValidatorRunResult> {
    const execLogger = getExecutionLogger(execution.id);
    const worktreePath =
      overrideWorktreePath ??
      (await deps.resolveWorktreePath(projectPath, sessionName));
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

    if (!deps.continuityService) {
      const taskResult = await dispatchValidatorTurn({
        prompt,
        backend: validatorType,
        workingDirectory: worktreePath,
        modelId,
        reasoningEffort,
        timeoutMs,
        resumeRef: undefined,
        laneRef: { workflowId: execution.id, laneId: lane },
      });

      if (taskResult.error) {
        const outcome: ValidatorOutcome = {
          kind: "infra_error",
          reason: "exception",
          message: taskResult.error,
          engine: validatorType,
        };
        execLogger?.validation(contextId, "validator.result_parsed", {
          lane,
          engine: validatorType,
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

    const resumeRef = resolvedCallToResumeRef(resolved, execution.id, lane);
    const taskResult = await dispatchValidatorTurn({
      prompt,
      backend: validatorType,
      workingDirectory: worktreePath,
      modelId,
      reasoningEffort,
      timeoutMs,
      resumeRef,
      laneRef: { workflowId: execution.id, laneId: lane },
    });

    if (taskResult.backendRef) {
      backendRefCache.set(
        refCacheKey(execution.id, lane),
        taskResult.backendRef,
      );
    }

    const runnerError = taskResult.error;
    const text = taskResult.text ?? "";
    const { result: parsed, parsePath }: ParsedValidatorResponse = runnerError
      ? {
          result: {
            kind: "infra_error",
            reason: "exception",
            message: runnerError,
            engine: validatorType,
          },
          parsePath: "runner_error",
        }
      : parseValidatorResponse(
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

      const continuityService = deps.continuityService;
      const persistedExecution = await applyLaneStateUpdate(
        projectPath,
        sessionName,
        async (latest) =>
          continuityService.recordCodexTurnOutcome({
            execution: applyResolvedLaneState(latest),
            contextId,
            lane,
            usage,
            contextLimitTokens,
            newThreadId,
            failed: runnerError != null,
          }),
      );
      const updatedExecution = persistedExecution ?? execution;

      const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
        updatedExecution,
        contextId,
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

    const continuityService = deps.continuityService;
    const persistedExecution = await applyLaneStateUpdate(
      projectPath,
      sessionName,
      async (latest) =>
        continuityService.recordClaudeTurnOutcome({
          execution: applyResolvedLaneState(latest),
          contextId,
          lane,
          contextTokens: null,
          contextWindowMax: null,
          contextLimitTokens,
        }),
    );
    const updatedExecution = persistedExecution ?? execution;

    const { limitEvaluation, rotateBeforeNextTurn } = extractLaneMetadata(
      updatedExecution,
      contextId,
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
    const index = createExecutionIndex(
      input.execution.workingDefinition,
      input.execution,
    );
    const contextTasks = index.tasksByContext.get(input.context.id) ?? [];

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
    const allowedTaskIds = getContextTaskIds(index, input.context.id);

    const overrideWorktreePath = input.executionTarget?.worktreePath;

    try {
      if (input.validator.type === "codex") {
        return await runValidatorTurn(
          input.projectPath,
          input.sessionName,
          input.execution,
          input.context.id,
          "context_validator",
          "codex",
          prompt,
          input.validator.codex.model,
          input.validator.codex.reasoningEffort,
          contextLimitTokens,
          allowedTaskIds,
          overrideWorktreePath,
        );
      }

      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        input.context.id,
        "context_validator",
        "claude",
        prompt,
        input.validator.agent.model,
        input.validator.agent.reasoningEffort,
        contextLimitTokens,
        allowedTaskIds,
        overrideWorktreePath,
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
