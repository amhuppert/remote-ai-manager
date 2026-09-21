import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getProjectDisplayName as getConversationProjectName } from "@/lib/projects/resolver";
/**
 * Dispatches the one advisory-response turn a passing round with fresh
 * advisories owes the implementer (D6/D7).
 *
 * The turn is an AgentCall on the context's implementer lane conversation, so
 * the advisories are answered by the lane that did the work rather than by a
 * stranger re-reading the diff. Schema validation is not re-implemented here:
 * `executeConversationTurn` routes the turn through the conversation actor into
 * the shared structured-output gate, which extracts and repairs on its own. This
 * module adds exactly one thing the gate cannot express — that the returned set
 * covers the delivered advisories exactly — and answers a violation the same way
 * the gate answers a schema failure, by asking again with the mismatch named.
 *
 * The dispositions it returns are the turn's own, or it returns none. A batch
 * that survives every attempt without a gate-validated set covering it fails the
 * turn exactly as an infrastructure failure does, because the alternatives are
 * both worse records: an advisory the implementer was shown and no one ever
 * disposed of, or a disposition the engine invented in its place. Neither is the
 * advisory blocking the context — the round's verdict is already banked and no
 * task is reopened. What failed is the engine's own protocol turn, and it fails
 * where every other unusable engine turn does, leaving the halt visible and the
 * batch undelivered rather than half-recorded.
 *
 * Declining is still free: `declined` with a one-line reason is the sanctioned
 * way to say no to every advisory in the batch, and it costs the turn nothing.
 * What is not optional is answering at all (R7).
 */

import { createLogger } from "@/lib/logging";
import {
  buildAdvisoryDispositionsOutputSchema,
  buildAdvisoryResponsePrompt,
  buildAdvisoryResponseRetryPrompt,
  parseAdvisoryDispositions,
  type RecordedAdvisoryDisposition,
} from "@/lib/workflow-graph/advisory-delivery";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import {
  composeImplementerLaneWriteEnvelope,
  resolveImplementerContinuationWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationAdvisory,
} from "@/lib/workflow-graph/schemas";
import { executeConversationTurn as defaultExecuteConversationTurn } from "@/lib/workflows/conversation/manager";
import type { ConversationTurnSpec } from "@/lib/workflows/conversation/turn-spec";
import {
  toTaskRunResult,
  type TaskRunResult,
} from "@/lib/workflows/conversation/turn-result";

const logger = createLogger("graph-workflow-advisory-response");

export interface GraphWorkflowAdvisoryResponseInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  /** The implementer lane conversation the turn rides. */
  conversationId: string;
  /** This round's fresh advisories, in delivery order. Never empty. */
  advisories: readonly GraphWorkflowValidationAdvisory[];
  executionTarget?: ExecutionTarget;
}

/**
 * A settled advisory-response turn: one gate-validated disposition per delivered
 * advisory, in delivered order. There is no second variant — a turn that cannot
 * produce this throws, so a caller holding one of these holds a complete batch.
 */
export interface GraphWorkflowAdvisoryResponseOutcome {
  dispositions: RecordedAdvisoryDisposition[];
}

export interface GraphWorkflowAdvisoryResponseRunnerDeps {
  executeConversationTurn?: typeof defaultExecuteConversationTurn;
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  resolveWorktreePath?(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
}

export function createGraphWorkflowAdvisoryResponseRunner(
  deps: GraphWorkflowAdvisoryResponseRunnerDeps = {},
) {
  const executeConversationTurn =
    deps.executeConversationTurn ?? defaultExecuteConversationTurn;
  const composeWriteEnvelope =
    deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;

  async function runAdvisoryResponse(
    input: GraphWorkflowAdvisoryResponseInput,
  ): Promise<GraphWorkflowAdvisoryResponseOutcome> {
    const context = input.execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    if (!context) {
      throw new Error(
        `Execution context "${input.contextId}" was not found in the working definition`,
      );
    }

    const agent = context.implementer.agent;
    const outputFormat = {
      type: "json_schema" as const,
      schema: buildAdvisoryDispositionsOutputSchema(input.advisories),
    };
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
      const message = `Cannot establish the advisory-response write envelope for context "${input.contextId}": ${writeEnvelopeResolution.error}`;
      logger.error("graph-workflow.advisory_response.write_envelope_failed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        conversationId: input.conversationId,
        backend: agent.backend,
        worktreePath: writeEnvelopeResolution.worktreePath,
        error: writeEnvelopeResolution.error,
      });
      throw new AgentTurnFailedError(message, {
        contextId: input.contextId,
        engine: agent.backend,
        cause: "unknown",
        originalMessage: message,
      });
    }
    const writeEnvelope = writeEnvelopeResolution.envelope;
    async function dispatch(
      prompt: string,
      attempt: number,
      structuredOutputTurns: NonNullable<
        ConversationTurnSpec["structuredOutputTurns"]
      >,
    ) {
      logger.info("graph-workflow.advisory_response.turn_started", {
        executionId: input.execution.id,
        contextId: input.contextId,
        conversationId: input.conversationId,
        backend: agent.backend,
        advisoryCount: input.advisories.length,
        attempt,
        fsWriteRestricted: writeEnvelope !== null,
      });

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
          askUserQuestionsEnabled: false,
          backend: agent.backend,
          outputFormat,
          structuredOutputTurns,
          modelSelection: agent.modelSelection,
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

      if (result.kind === "error") {
        // The turn itself failed. Not the advisory channel's business: this is
        // the same infrastructure failure any engine-dispatched turn can suffer,
        // and swallowing it would let an aborted turn read as a context that
        // simply had nothing to say.
        logger.error("graph-workflow.advisory_response.turn_failed", {
          executionId: input.execution.id,
          contextId: input.contextId,
          conversationId: input.conversationId,
          aborted: result.aborted,
          error: result.error,
        });
        throw new AgentTurnFailedError(result.error, {
          contextId: input.contextId,
          engine: agent.backend,
          cause: result.aborted ? "abort" : "sdk_error",
          originalMessage: result.error,
        });
      }

      const issues = evaluate(result, input.advisories);
      if (issues.kind === "disposed") {
        logger.info("graph-workflow.advisory_response.disposed", {
          executionId: input.execution.id,
          contextId: input.contextId,
          attempt,
          dispositionCount: issues.dispositions.length,
        });
      } else {
        logger.warn("graph-workflow.advisory_response.rejected", {
          executionId: input.execution.id,
          contextId: input.contextId,
          attempt,
          issueCount: issues.issues.length,
        });
      }
      return issues;
    }

    let attempts = 1;
    let response = await dispatch(
      buildAdvisoryResponsePrompt({
        contextTitle: context.title,
        advisories: input.advisories,
      }),
      1,
      "work_then_format",
    );
    if (response.kind === "rejected") {
      attempts += 1;
      response = await dispatch(
        buildAdvisoryResponseRetryPrompt({
          contextTitle: context.title,
          advisories: input.advisories,
          issues: response.issues,
        }),
        attempts,
        "single",
      );
    }
    if (response.kind === "disposed")
      return { dispositions: response.dispositions };
    const lastReason = response.issues.join(" ");

    // Out of attempts with nothing the gate accepted. The advisories are not
    // delivered — the caller stamps delivery and disposition in one write, and
    // this failure is what stops it reaching either.
    const message = `The advisory-response turn returned no valid disposition set in ${attempts} attempts: ${lastReason}`;
    logger.error("graph-workflow.advisory_response.exhausted", {
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      advisoryCount: input.advisories.length,
      attempts,
    });
    throw new AgentTurnFailedError(message, {
      contextId: input.contextId,
      engine: agent.backend,
      cause: "sdk_error",
      originalMessage: message,
    });
  }

  return { runAdvisoryResponse };
}

function evaluate(
  result: Exclude<TaskRunResult, { kind: "error" }>,
  advisories: readonly GraphWorkflowValidationAdvisory[],
):
  | { kind: "disposed"; dispositions: RecordedAdvisoryDisposition[] }
  | { kind: "rejected" | "schema"; issues: string[] } {
  if (result.kind === "text") {
    // `outputFormat` was set, so a text result means the gate accepted no
    // candidate and the actor still reported success.
    return {
      kind: "schema",
      issues: [
        "The advisory-response turn returned no JSON payload for the dispositions schema.",
      ],
    };
  }

  const parsed = parseAdvisoryDispositions({
    structuredOutput: result.structuredOutput,
    delivered: advisories,
  });
  return parsed.ok
    ? { kind: "disposed", dispositions: parsed.dispositions }
    : {
        kind: parsed.kind === "schema" ? "schema" : "rejected",
        issues: parsed.issues,
      };
}
