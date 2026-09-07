import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getProjectDisplayName as getConversationProjectName } from "@/lib/projects/resolver";
/**
 * Dispatches the one advisory-response turn a passing round with fresh
 * advisories owes the implementer (D6/D7).
 *
 * The turn is an AgentCall on the context's implementer lane conversation, so
 * the advisories are answered by the lane that did the work rather than by a
 * stranger re-reading the diff. Schema validation is not re-implemented here:
 * `executeWorkflowTaskRun` routes the turn through the conversation actor into
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
import type { AgentBackendId } from "@/lib/shared/schemas";
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
import {
  executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun,
  type ExecuteWorkflowTaskRunInput,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";

const logger = createLogger("graph-workflow-advisory-response");

/**
 * Dispatches of the response turn per round.
 *
 * Two, not more: the first ask states the contract, and the second names the
 * exact identities the reply missed, invented, or answered twice. A third would
 * repeat the second word for word, so it would buy a retry of the model's mood
 * rather than of anything the engine can say differently.
 */
export const ADVISORY_RESPONSE_ATTEMPTS = 2;

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

interface ExecuteWorkflowTaskRunFn {
  (input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
}

export interface GraphWorkflowAdvisoryResponseRunnerDeps {
  executeWorkflowTaskRun?: ExecuteWorkflowTaskRunFn;
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  resolveWorktreePath?(
    projectPath: string,
    sessionName: string,
  ): Promise<string>;
  /** Per-turn wall-clock bound, resolved from the same backend defaults the
   *  validator and capture turns use. Omitted leaves the actor's default. */
  resolveTimeoutMs?(backend: AgentBackendId): Promise<number | undefined>;
}

export function createGraphWorkflowAdvisoryResponseRunner(
  deps: GraphWorkflowAdvisoryResponseRunnerDeps = {},
) {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
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

    const outputSchema = buildAdvisoryDispositionsOutputSchema(
      input.advisories,
    );
    const timeoutMs = await deps.resolveTimeoutMs?.(
      context.implementer.agent.backend,
    );
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
    let prompt = buildAdvisoryResponsePrompt({
      contextTitle: context.title,
      advisories: input.advisories,
    });
    let lastReason = "The advisory-response turn produced no dispositions.";

    for (let attempt = 1; attempt <= ADVISORY_RESPONSE_ATTEMPTS; attempt += 1) {
      logger.info("graph-workflow.advisory_response.turn_started", {
        executionId: input.execution.id,
        contextId: input.contextId,
        conversationId: input.conversationId,
        backend: context.implementer.agent.backend,
        advisoryCount: input.advisories.length,
        attempt,
        fsWriteRestricted: writeEnvelope !== null,
      });

      const result = await executeWorkflowTaskRun({
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
        kind: "task_run",
        executionClass: "governed-execution",
        executionProfile: "standard",
        prompt,
        outputFormat: { type: "json_schema", schema: outputSchema },
        modelSelection: context.implementer.agent.modelSelection,
        ...(writeEnvelope !== null
          ? { fsWritePolicy: writeEnvelope.policy }
          : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        origin: {
          source: "workflow",
          workflow: {
            executionId: input.execution.id,
            nodeId: input.contextId,
            iterationIndex:
              input.execution.contextStates[input.contextId]?.iterationCount ??
              0,
          },
        },
      });

      if (
        result.kind === "error" &&
        result.structuredOutputIssues === undefined
      ) {
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
          engine: context.implementer.agent.backend,
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
        return { dispositions: issues.dispositions };
      }

      lastReason = issues.issues.join(" ");
      logger.warn("graph-workflow.advisory_response.rejected", {
        executionId: input.execution.id,
        contextId: input.contextId,
        attempt,
        issueCount: issues.issues.length,
      });
      prompt = buildAdvisoryResponseRetryPrompt({
        contextTitle: context.title,
        advisories: input.advisories,
        issues: issues.issues,
      });
    }

    // Out of attempts with nothing the gate accepted. The advisories are not
    // delivered — the caller stamps delivery and disposition in one write, and
    // this failure is what stops it reaching either.
    const message = `The advisory-response turn returned no valid disposition set in ${ADVISORY_RESPONSE_ATTEMPTS} attempts: ${lastReason}`;
    logger.error("graph-workflow.advisory_response.exhausted", {
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      advisoryCount: input.advisories.length,
      attempts: ADVISORY_RESPONSE_ATTEMPTS,
    });
    throw new AgentTurnFailedError(message, {
      contextId: input.contextId,
      engine: context.implementer.agent.backend,
      cause: "sdk_error",
      originalMessage: message,
    });
  }

  return { runAdvisoryResponse };
}

function evaluate(
  result: TaskRunResult,
  advisories: readonly GraphWorkflowValidationAdvisory[],
):
  | { kind: "disposed"; dispositions: RecordedAdvisoryDisposition[] }
  | { kind: "rejected"; issues: string[] } {
  if (result.kind === "error") {
    return {
      kind: "rejected",
      issues: result.structuredOutputIssues ?? [
        "The advisory-response turn returned no dispositions.",
      ],
    };
  }
  if (result.kind === "text") {
    // `outputFormat` was set, so a text result means the gate accepted no
    // candidate and the actor still reported success.
    return {
      kind: "rejected",
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
    : { kind: "rejected", issues: parsed.issues };
}
