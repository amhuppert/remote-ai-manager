import { workflowAgentValidatorResultSchema } from "@/lib/schemas";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  ClaudeModel,
  CodexReasoningEffort,
  EffortLevel,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowExecutionSessionRef,
  GraphWorkflowLaneKind,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationReviewArtifact,
  WorkflowAgentValidatorResult,
} from "@/types";
import type {
  GraphWorkflowTaskValidatorInput,
  GraphWorkflowContextAgentValidatorInput,
} from "./execution-validation";
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
    reopenTaskIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["pass", "summary", "issues", "reopenTaskIds"],
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
    "- `reopenTaskIds` (array of strings): IDs of previously completed tasks that need rework (only from the task list above, empty array if none)",
  ].join("\n");
}

export interface BuildContextValidationPromptInput {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  validator: GraphWorkflowAgentValidatorConfig;
}

export function buildContextValidationPrompt(
  input: BuildContextValidationPromptInput,
): string {
  const taskList = input.tasks
    .map((t) => `- \`${t.id}\`: ${t.title} — ${t.instructions}`)
    .join("\n");

  return [
    "# Execution Context Validation",
    "",
    "You are a validation agent reviewing all completed work in an execution context.",
    "Your job is to assess whether the overall goal has been met.",
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
    "## Completed Tasks",
    "",
    taskList,
    "",
    "## Required Output",
    "",
    "Review the combined work across all tasks — read files, run checks, verify correctness.",
    "Then output your assessment as a JSON object with these fields:",
    "",
    "- `pass` (boolean): `true` if the execution context goal has been fully met, `false` otherwise",
    "- `summary` (string): Brief explanation of your assessment",
    "- `issues` (array of `{ title, description }`): Specific problems found (empty array if pass is true)",
    "- `reopenTaskIds` (array of strings): IDs of tasks that need rework (only from the task list above, empty array if none)",
  ].join("\n");
}

// -- Result parsing -----------------------------------------------------------

/**
 * Extract and parse a WorkflowAgentValidatorResult from agent text output.
 * Looks for the last ```json fenced block and parses it with the schema.
 * Returns a synthetic failing result when extraction or parsing fails.
 */
export function extractValidatorResult(
  text: string,
): WorkflowAgentValidatorResult {
  const jsonBlocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (jsonBlocks.length === 0) {
    return {
      pass: false,
      summary: "Validator agent did not return structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  const lastBlock = jsonBlocks[jsonBlocks.length - 1]!;
  const raw = lastBlock[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      pass: false,
      summary: "Validator agent returned invalid structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  const result = workflowAgentValidatorResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      pass: false,
      summary: "Validator agent returned invalid structured output",
      issues: [],
      reopenTaskIds: [],
    };
  }

  return result.data;
}

export interface ParsedValidatorResponse {
  result: WorkflowAgentValidatorResult;
  parsePath:
    | "structured_output"
    | "raw_json"
    | "fenced_json_block"
    | "fenced_json_block_fallback";
}

/**
 * Parse a validator response, trying structured output first, then raw JSON,
 * then fenced ```json block extraction as a fallback.
 * Returns both the result and which parse path succeeded.
 */
export function parseValidatorResponse(
  text: string,
  structuredOutput?: unknown,
): ParsedValidatorResponse {
  // Path 1: structured output from SDK (both Claude and Codex)
  if (structuredOutput != null) {
    const result =
      workflowAgentValidatorResultSchema.safeParse(structuredOutput);
    if (result.success)
      return { result: result.data, parsePath: "structured_output" };
  }

  // Path 2: raw JSON string (Codex outputSchema response)
  try {
    const parsed = JSON.parse(text);
    const result = workflowAgentValidatorResultSchema.safeParse(parsed);
    if (result.success) return { result: result.data, parsePath: "raw_json" };
  } catch {
    /* not raw JSON, try fenced block */
  }

  // Path 3: fenced ```json block (legacy fallback)
  return {
    result: extractValidatorResult(text),
    parsePath: "fenced_json_block",
  };
}

// -- Validator runner ---------------------------------------------------------

export interface ValidatorExecutionResult {
  text: string;
  structuredOutput?: unknown;
  contextTokens?: number | null;
  contextWindowMax?: number | null;
}

export interface ExecuteValidatorAgentInput {
  projectPath: string;
  sessionName: string;
  prompt: string;
  model: ClaudeModel;
  reasoningEffort: EffortLevel;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** When provided, reuse this conversation instead of creating a new one. */
  conversationId?: string;
}

export interface ExecuteValidatorCodexInput {
  projectPath: string;
  sessionName: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** Whether to start a fresh thread or resume an existing one. */
  sessionAction?: "create" | "reuse";
  /** Thread ID to resume when sessionAction is "reuse". */
  storedThreadId?: string;
}

export interface ExecuteValidatorCodexResult {
  text: string;
  /** Real Codex thread ID captured after the turn completes. Null if unavailable. */
  realThreadId: string | null;
  /** Per-turn token usage from the Codex SDK. Null when unavailable. */
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
}

export interface ValidatorExecutionMetadata {
  sessionRef: GraphWorkflowExecutionSessionRef | null;
  reviewArtifact: GraphWorkflowValidationReviewArtifact | null;
  limitEvaluation: "disabled" | "supported" | "unsupported";
  rotateBeforeNextTurn: boolean;
}

export interface ValidatorRunResult {
  result: WorkflowAgentValidatorResult;
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
  executeValidatorAgent(
    input: ExecuteValidatorAgentInput,
  ): Promise<ValidatorExecutionResult>;
  executeValidatorCodex(
    input: ExecuteValidatorCodexInput,
  ): Promise<ExecuteValidatorCodexResult | string>;
  /** When provided, validator runs route through the continuity service for session reuse. */
  continuityService?: ValidatorContinuityService;
  /** Required when continuityService is provided — persists updated lane state. */
  executionRepository?: ValidatorContinuityRepository;
}

const validatorLogger = createLogger("graph-workflow-validator");

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
    sessionRef: GraphWorkflowExecutionSessionRef | null;
    limitEvaluation: "disabled" | "supported" | "unsupported";
    rotateBeforeNextTurn: boolean;
  } {
    const laneState = updatedExecution.laneStates[lane];
    if (!laneState) {
      return {
        sessionRef: null,
        limitEvaluation: "disabled",
        rotateBeforeNextTurn: false,
      };
    }
    return {
      sessionRef: laneState.sessionRef,
      limitEvaluation: laneState.limitEvaluation,
      rotateBeforeNextTurn: laneState.rotateBeforeNextTurn,
    };
  }

  async function runValidatorTurn(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    lane: "task_validator" | "context_validator",
    validatorType: "claude" | "codex",
    contextLimitTokens: number | undefined,
    runClaudeAgent: (
      conversationId?: string,
    ) => Promise<ValidatorExecutionResult>,
    runCodexAgent: (
      sessionAction: "create" | "reuse",
      storedThreadId?: string,
    ) => Promise<ExecuteValidatorCodexResult | string>,
  ): Promise<ValidatorRunResult> {
    const contextId = execution.activeContextId ?? "";
    const execLogger = getExecutionLogger(execution.id);

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
      // No continuity service — execute one-shot without lane tracking
      if (validatorType === "codex") {
        const rawResult = await runCodexAgent("create");
        const text = typeof rawResult === "string" ? rawResult : rawResult.text;
        const { result: parsed, parsePath } = parseValidatorResponse(text);
        execLogger?.validation(contextId, "validator.result_parsed", {
          lane,
          engine: validatorType,
          parsePath,
          pass: parsed.pass,
          issueCount: parsed.issues.length,
          reopenTaskIds: parsed.reopenTaskIds,
        });
        return {
          result: parsed,
          metadata: buildNoServiceMetadata(),
        };
      }
      const rawResult = await runClaudeAgent();
      const { result: parsed, parsePath } = parseValidatorResponse(
        rawResult.text,
        rawResult.structuredOutput,
      );
      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        engine: validatorType,
        parsePath,
        pass: parsed.pass,
        issueCount: parsed.issues.length,
        reopenTaskIds: parsed.reopenTaskIds,
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
      contextId: execution.activeContextId ?? "",
      lane,
      engine: validatorType,
    });

    if (validatorType === "codex") {
      const sessionAction = resolved.sessionAction;
      const storedThreadId =
        resolved.engine === "codex" ? resolved.threadId : undefined;

      const codexResult = await runCodexAgent(sessionAction, storedThreadId);
      const text =
        typeof codexResult === "string" ? codexResult : codexResult.text;
      const realThreadId =
        typeof codexResult === "string" ? null : codexResult.realThreadId;
      const usage =
        typeof codexResult === "string" ? null : (codexResult.usage ?? null);

      const updatedExecution = deps.continuityService.recordCodexTurnOutcome({
        execution: resolved.execution,
        lane,
        usage,
        contextLimitTokens,
        newThreadId: realThreadId,
      });
      await persistLaneState(projectPath, sessionName, updatedExecution);

      const { sessionRef, limitEvaluation, rotateBeforeNextTurn } =
        extractLaneMetadata(updatedExecution, lane);

      // Build Codex review artifact using the real thread ID stored after the turn
      const codexThreadId =
        sessionRef?.engine === "codex"
          ? sessionRef.threadId
          : (realThreadId ?? "");
      const reviewArtifact: GraphWorkflowValidationReviewArtifact = {
        engine: "codex",
        threadId: codexThreadId,
        response: text,
        usage,
      };

      const { result: parsed, parsePath } = parseValidatorResponse(text);

      execLogger?.validation(contextId, "validator.result_parsed", {
        lane,
        engine: "codex",
        parsePath,
        pass: parsed.pass,
        issueCount: parsed.issues.length,
        summary: parsed.summary,
        reopenTaskIds: parsed.reopenTaskIds,
        sessionAction,
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
          sessionRef,
          reviewArtifact,
          limitEvaluation,
          rotateBeforeNextTurn,
        },
      };
    }

    const conversationId =
      resolved.engine === "claude" ? resolved.conversationId : undefined;

    const claudeResult = await runClaudeAgent(conversationId);

    const updatedExecution = deps.continuityService.recordClaudeTurnOutcome({
      execution: resolved.execution,
      lane,
      contextTokens: claudeResult.contextTokens ?? null,
      contextWindowMax: claudeResult.contextWindowMax ?? null,
      contextLimitTokens,
    });
    await persistLaneState(projectPath, sessionName, updatedExecution);

    const { sessionRef, limitEvaluation, rotateBeforeNextTurn } =
      extractLaneMetadata(updatedExecution, lane);

    const reviewArtifact: GraphWorkflowValidationReviewArtifact | null =
      sessionRef?.engine === "claude"
        ? { engine: "claude", conversationId: sessionRef.conversationId }
        : null;

    const { result: parsed, parsePath } = parseValidatorResponse(
      claudeResult.text,
      claudeResult.structuredOutput,
    );

    execLogger?.validation(contextId, "validator.result_parsed", {
      lane,
      engine: "claude",
      parsePath,
      pass: parsed.pass,
      issueCount: parsed.issues.length,
      summary: parsed.summary,
      reopenTaskIds: parsed.reopenTaskIds,
      conversationId,
      contextTokens: claudeResult.contextTokens,
      contextWindowMax: claudeResult.contextWindowMax,
    });
    execLogger?.writeValidatorResponse(
      contextId,
      `${lane}-claude-response.json`,
      { raw: claudeResult.text, parsed, parsePath },
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
          contextLimitTokens,
          async () => ({ text: "" }),
          async (sessionAction, storedThreadId) =>
            deps.executeValidatorCodex({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              prompt,
              model: validator.codex.model,
              reasoningEffort: validator.codex.reasoningEffort,
              sessionAction,
              storedThreadId,
            }),
        );
      }

      const validator = input.validator;
      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        "task_validator",
        "claude",
        contextLimitTokens,
        async (conversationId) =>
          deps.executeValidatorAgent({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            prompt,
            model: validator.agent.model,
            reasoningEffort: validator.agent.reasoningEffort,
            outputFormat: {
              type: "json_schema",
              schema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<
                string,
                unknown
              >,
            },
            conversationId,
          }),
        async () => ({ text: "", realThreadId: null, usage: null }),
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      execLogger?.validation(input.context.id, "task_validator.error", {
        taskId: input.task.id,
        engine: input.validator.type,
        error: errorMessage,
      });
      validatorLogger.error("graph-workflow.task_validator.error", {
        executionId: input.execution.id,
        contextId: input.context.id,
        taskId: input.task.id,
        error: errorMessage,
      });
      return {
        result: {
          pass: false,
          summary: `Validator agent failed: ${errorMessage}`,
          issues: [],
          reopenTaskIds: [],
        },
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  async function runContextAgentValidator(
    input: GraphWorkflowContextAgentValidatorInput,
  ): Promise<ValidatorRunResult> {
    const contextTasks = input.execution.workingDefinition.tasks.filter(
      (t) => t.contextId === input.context.id,
    );

    const prompt = buildContextValidationPrompt({
      context: input.context,
      tasks: contextTasks,
      validator: input.validator,
    });

    const execLogger = getExecutionLogger(input.execution.id);
    const retryState = input.execution.retryState[input.context.id];
    const attemptLabel = retryState ? `-attempt-${retryState.attempt}` : "";
    execLogger?.writePrompt(
      input.context.id,
      `context-validation${attemptLabel}.md`,
      prompt,
    );
    execLogger?.validation(input.context.id, "context_validator.started", {
      engine: input.validator.type,
      promptLength: prompt.length,
      taskCount: contextTasks.length,
      retryAttempt: retryState?.attempt ?? 0,
    });

    const contextLimitTokens = input.validator.continuity.contextLimitTokens;

    try {
      if (input.validator.type === "codex") {
        const validator = input.validator;
        return await runValidatorTurn(
          input.projectPath,
          input.sessionName,
          input.execution,
          "context_validator",
          "codex",
          contextLimitTokens,
          async () => ({ text: "" }),
          async (sessionAction, storedThreadId) =>
            deps.executeValidatorCodex({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              prompt,
              model: validator.codex.model,
              reasoningEffort: validator.codex.reasoningEffort,
              sessionAction,
              storedThreadId,
            }),
        );
      }

      const validator = input.validator;
      return await runValidatorTurn(
        input.projectPath,
        input.sessionName,
        input.execution,
        "context_validator",
        "claude",
        contextLimitTokens,
        async (conversationId) =>
          deps.executeValidatorAgent({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            prompt,
            model: validator.agent.model,
            reasoningEffort: validator.agent.reasoningEffort,
            outputFormat: {
              type: "json_schema",
              schema: VALIDATOR_OUTPUT_SCHEMA as unknown as Record<
                string,
                unknown
              >,
            },
            conversationId,
          }),
        async () => ({ text: "", realThreadId: null, usage: null }),
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      execLogger?.validation(input.context.id, "context_validator.error", {
        engine: input.validator.type,
        error: errorMessage,
      });
      validatorLogger.error("graph-workflow.context_validator.error", {
        executionId: input.execution.id,
        contextId: input.context.id,
        error: errorMessage,
      });
      return {
        result: {
          pass: false,
          summary: `Validator agent failed: ${errorMessage}`,
          issues: [],
          reopenTaskIds: [],
        },
        metadata: buildNoServiceMetadata(),
      };
    }
  }

  return { runTaskValidator, runContextAgentValidator };
}
