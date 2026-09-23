import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getProjectDisplayName as getConversationProjectName } from "@/lib/projects/resolver";
/**
 * Dispatches the D2 format turn that captures a context's structured output.
 *
 * The turn is an AgentCall carrying the context's declared `outputSchema`,
 * continued on the context's EXISTING implementer lane conversation so the
 * payload is restated from the work the lane already did. It is a conversation
 * turn on the live runtime rather than a task run: the task-run path closes the
 * runtime and resumes the session through another transport without the lane's
 * instructions and tools, which changes the request prefix and forfeits the
 * backend's prompt cache for the whole conversation. Validation is not
 * re-implemented here: `executeConversationTurn` routes the turn through the
 * conversation actor into `executeAgentCall`, whose structured-output gate
 * performs candidate extraction fall-through plus bounded repair. This module
 * only translates that single verdict into the engine's capture vocabulary —
 * the same composition `advisory-response-runner.ts` uses on the same lane.
 */

import { createLogger } from "@/lib/logging";
import type { GraphWorkflowContextOutputCaptureInput } from "@/lib/workflow-graph/context-validation-coordinator";
import {
  buildOutputCapturePrompt,
  toOutputSchemaIssues,
  type GraphWorkflowContextOutputCaptureOutcome,
} from "@/lib/workflow-graph/context-output-capture";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import {
  composeImplementerLaneWriteEnvelope,
  resolveImplementerContinuationWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { executeConversationTurn as defaultExecuteConversationTurn } from "@/lib/workflows/conversation/manager";
import {
  toTaskRunResult,
  type TaskRunResult,
} from "@/lib/workflows/conversation/turn-result";

const logger = createLogger("graph-workflow-output-capture");

/**
 * Bound on the refused payload copied into the validation-failure record. The
 * record is persisted per attempt, so an agent that answers with a whole file
 * must not be able to grow the execution's event rows without limit.
 */
const MAX_REJECTED_TEXT_CHARS = 4_000;

export interface GraphWorkflowOutputCaptureRunnerDeps {
  executeConversationTurn?: typeof defaultExecuteConversationTurn;
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  resolveWorktreePath?(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
}

export function createGraphWorkflowOutputCaptureRunner(
  deps: GraphWorkflowOutputCaptureRunnerDeps = {},
) {
  const executeConversationTurn =
    deps.executeConversationTurn ?? defaultExecuteConversationTurn;
  const composeWriteEnvelope =
    deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;

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
    const writeEnvelopeResolution =
      await resolveImplementerContinuationWriteEnvelope(
        {
          executionId: input.execution.id,
          contextId: input.contextId,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          placement: context.placement,
          ...(input.executionTarget !== undefined
            ? { executionTarget: input.executionTarget }
            : {}),
        },
        {
          composeWriteEnvelope,
          ...(deps.resolveWorktreePath !== undefined
            ? { resolveWorktreePath: deps.resolveWorktreePath }
            : {}),
        },
      );
    if (!writeEnvelopeResolution.ok) {
      const message = `Cannot establish the output-capture write envelope for context "${input.contextId}": ${writeEnvelopeResolution.error}`;
      logger.error("graph-workflow.output_capture.write_envelope_failed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        conversationId: input.conversationId,
        backend: context.implementer.agent.backend,
        worktreePath: writeEnvelopeResolution.worktreePath,
        error: writeEnvelopeResolution.error,
      });
      throw new AgentTurnFailedError(message, {
        contextId: input.contextId,
        engine: context.implementer.agent.backend,
        cause: "unknown",
        originalMessage: message,
      });
    }
    const writeEnvelope = writeEnvelopeResolution.envelope;

    logger.info("graph-workflow.output_capture.turn_started", {
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      backend: context.implementer.agent.backend,
      retry: input.previousRejection !== undefined,
      fsWriteRestricted: writeEnvelope !== null,
    });

    const outputFormat = {
      type: "json_schema" as const,
      // The declared contract, verbatim: the gate validates against this exact
      // document, so anything less than the whole schema would validate a
      // different contract than the author wrote.
      schema: input.outputSchema,
    };
    const execution = await executeConversationTurn({
      binding: {
        kind: "durable",
        address: {
          projectPath: input.projectPath,
          target: targetFromStoreSessionName(
            getConversationProjectName(input.projectPath),
            input.sessionName,
            input.conversationId,
          ),
        },
        ...(input.executionTarget
          ? { worktreePath: input.executionTarget.worktreePath }
          : {}),
      },
      turn: {
        kind: "conversation_turn",
        promptText: prompt,
        autonomous: true,
        // Must equal the implementer turn's value: it feeds the runtime's
        // session instructions, and a mismatch rebuilds the runtime, which is
        // the cache loss this turn exists to avoid.
        askUserQuestionsEnabled: context.askUserQuestions.enabled,
        backend: context.implementer.agent.backend,
        outputFormat,
        structuredOutputTurns: "single",
        modelSelection: context.implementer.agent.modelSelection,
        ...(writeEnvelope !== null
          ? { fsWritePolicy: writeEnvelope.policy }
          : {}),
      },
      executionContext: {
        workflowContext: {
          executionId: input.execution.id,
          contextId: input.contextId,
        },
      },
      waitUntilReady: true,
    });
    const result = toTaskRunResult(
      execution.kind === "settled"
        ? execution.turn.outcome
        : {
            kind: "not_started",
            reason:
              execution.code === "cancelled" ? "cancelled" : "configuration",
            message: execution.message,
          },
      outputFormat,
    );

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
