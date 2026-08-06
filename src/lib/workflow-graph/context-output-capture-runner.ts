/**
 * Dispatches the D2 format turn that captures a context's structured output.
 *
 * The turn is an AgentCall carrying the context's declared `outputSchema`,
 * dispatched onto the context's EXISTING implementer lane conversation so the
 * payload is restated from the work the lane already did. Validation is not
 * re-implemented here: `executeWorkflowTaskRun` routes the turn through the
 * conversation actor into `executeAgentCall`, whose `applyStructuredOutputGate`
 * performs candidate extraction fall-through plus bounded repair. This module
 * only translates that single verdict into the engine's capture vocabulary —
 * the same composition `validator-runner.ts` uses for its schema-validated turn.
 */

import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { GraphWorkflowContextOutputCaptureInput } from "@/lib/workflow-graph/iteration-orchestrator";
import {
  buildOutputCapturePrompt,
  toOutputSchemaIssues,
  type GraphWorkflowContextOutputCaptureOutcome,
} from "@/lib/workflow-graph/context-output-capture";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import {
  executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun,
  type ExecuteWorkflowTaskRunInput,
  type TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";

const logger = createLogger("graph-workflow-output-capture");

/**
 * Bound on the refused payload copied into the validation-failure record. The
 * record is persisted per attempt, so an agent that answers with a whole file
 * must not be able to grow the execution's event rows without limit.
 */
const MAX_REJECTED_TEXT_CHARS = 4_000;

interface ExecuteWorkflowTaskRunFn {
  (input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
}

export interface GraphWorkflowOutputCaptureRunnerDeps {
  executeWorkflowTaskRun?: ExecuteWorkflowTaskRunFn;
  /** Per-turn wall-clock bound, resolved from the same backend defaults the
   *  validator turn uses. Omitted leaves the actor's own default in force.
   *  Typed as `AgentBackendId` — the resolved context already carries one, so
   *  widening to `string` here would only force the caller to cast it back. */
  resolveTimeoutMs?(backend: AgentBackendId): Promise<number | undefined>;
}

export function createGraphWorkflowOutputCaptureRunner(
  deps: GraphWorkflowOutputCaptureRunnerDeps = {},
) {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;

  async function captureContextOutput(
    input: GraphWorkflowContextOutputCaptureInput,
  ): Promise<GraphWorkflowContextOutputCaptureOutcome> {
    const context = input.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    if (!context) {
      throw new Error(
        `Execution context "${input.contextId}" was not found in the working definition`,
      );
    }

    const prompt = buildOutputCapturePrompt({
      contextTitle: context.title,
      outputSchema: input.outputSchema,
      ...(input.previousRejection !== undefined
        ? { previousRejection: input.previousRejection }
        : {}),
    });
    const timeoutMs = await deps.resolveTimeoutMs?.(
      context.implementer.agent.backend,
    );

    logger.info("graph-workflow.output_capture.turn_started", {
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      backend: context.implementer.agent.backend,
      retry: input.previousRejection !== undefined,
    });

    const result = await executeWorkflowTaskRun({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      kind: "task_run",
      prompt,
      // The declared contract, verbatim: the gate validates against this exact
      // document, so anything less than the whole schema would validate a
      // different contract than the author wrote.
      outputFormat: { type: "json_schema", schema: input.outputSchema },
      modelId: context.implementer.agent.model,
      effort: context.implementer.agent.reasoningEffort,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(input.executionTarget !== undefined
        ? { worktreePath: input.executionTarget.worktreePath }
        : {}),
      origin: {
        source: "workflow",
        workflow: {
          executionId: input.execution.id,
          nodeId: input.contextId,
          iterationIndex:
            input.execution.contextStates[input.contextId]?.iterationCount ?? 0,
        },
      },
    });

    return toCaptureOutcome(result, input);
  }

  return { captureContextOutput };
}

function toCaptureOutcome(
  result: TaskRunResult,
  input: GraphWorkflowContextOutputCaptureInput,
): GraphWorkflowContextOutputCaptureOutcome {
  if (result.kind === "structured") {
    if (!isJsonObject(result.structuredOutput)) {
      // Defence in depth: the authoring walker refuses a non-object root, so a
      // passing gate should never yield one. Treat it as a rejection rather
      // than persisting a shape the read side cannot address.
      return {
        kind: "rejected",
        summary:
          "The captured output cleared validation but is not a JSON object, so it cannot be recorded as this context's output.",
        issues: toOutputSchemaIssues(["$ must be object"]),
        rejectedText: truncate(result.text),
      };
    }
    return {
      kind: "captured",
      value: result.structuredOutput,
      parse: result.parse ?? { source: "native" },
    };
  }

  if (result.kind === "text") {
    // `outputFormat` was set, so a text result means the gate accepted nothing
    // and the actor still reported success — no payload exists to record.
    return {
      kind: "rejected",
      summary:
        "The format turn returned no JSON payload for this context's declared output schema.",
      issues: toOutputSchemaIssues(["$ is required"]),
      rejectedText: truncate(result.text),
    };
  }

  // An error carrying gate issues IS the schema rejection; anything else is an
  // infrastructure failure of the turn itself and must not be counted as one.
  if (result.structuredOutputIssues === undefined) {
    logger.error("graph-workflow.output_capture.turn_failed", {
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      aborted: result.aborted,
      error: result.error,
    });
    throw new AgentTurnFailedError(result.error, {
      contextId: input.contextId,
      engine:
        input.execution.workingDefinition.executionContexts.find(
          (entry) => entry.id === input.contextId,
        )?.implementer.agent.backend ?? "claude",
      cause: result.aborted ? "abort" : "sdk_error",
      originalMessage: result.error,
    });
  }

  return {
    kind: "rejected",
    summary: `The captured output did not conform to this context's declared output schema (${result.structuredOutputIssues.length} issue(s)).`,
    issues: toOutputSchemaIssues(result.structuredOutputIssues),
    rejectedText: truncate(result.text),
    ...(result.structuredOutputRepair !== undefined
      ? { gateRepair: result.structuredOutputRepair }
      : {}),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string | undefined): string | null {
  if (text === undefined || text.length === 0) return null;
  return text.length <= MAX_REJECTED_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_REJECTED_TEXT_CHARS)}…`;
}
