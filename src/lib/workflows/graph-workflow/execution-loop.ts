import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  emit as defaultEmitStreamFrame,
  type GraphWorkflowStreamFrame,
} from "@/lib/workflow-graph/stream-registry";
import type { GraphWorkflowExecution, GraphWorkflowHaltReason } from "@/types";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";

export interface GraphWorkflowExecutionLoopInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}

export interface GraphWorkflowExecutionLoopDeps {
  workflowManager: {
    scheduleNextContext(
      projectPath: string,
      sessionName: string,
    ): Promise<GraphWorkflowExecution>;
    send(
      projectPath: string,
      sessionName: string,
      event:
        | { type: "complete" }
        | { type: "halt"; reason: GraphWorkflowHaltReason },
    ): Promise<GraphWorkflowExecution>;
    recoverRetryableIterationError?(
      projectPath: string,
      sessionName: string,
      input: { contextId: string; errorMessage: string },
    ): Promise<GraphWorkflowExecution>;
  };
  iterationOrchestrator: {
    runIteration(input: {
      projectPath: string;
      projectName: string;
      sessionName: string;
      contextId: string;
    }): Promise<GraphWorkflowIterationResult>;
  };
  emitStreamFrame?(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void;
}

function emitDone(
  deps: GraphWorkflowExecutionLoopDeps,
  projectPath: string,
  sessionName: string,
  reason: string,
): void {
  (deps.emitStreamFrame ?? defaultEmitStreamFrame)(projectPath, sessionName, {
    type: "done",
    reason,
  });
}

// -- Active loop registry -----------------------------------------------------

const activeLoops = new Set<string>();

function loopKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Check if an execution loop is currently running for the given session. */
export function isExecutionLoopActive(
  projectPath: string,
  sessionName: string,
): boolean {
  return activeLoops.has(loopKey(projectPath, sessionName));
}

/** Reset the active loop registry (for testing only). */
export function _resetActiveLoopsForTesting(): void {
  activeLoops.clear();
}

// -- Constants ----------------------------------------------------------------

const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

// -- Helpers ------------------------------------------------------------------

function isRetryableIterationError(error: unknown): boolean {
  return /stream closed|querysession died before prompt delivery|processtransport is not ready for writing/i.test(
    getErrorMessage(error),
  );
}

// -- Execution loop -----------------------------------------------------------

const logger = createLogger("graph-workflow-execution-loop");

export function createGraphWorkflowExecutionLoop(
  deps: GraphWorkflowExecutionLoopDeps,
) {
  async function run(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<GraphWorkflowExecution> {
    const key = loopKey(input.projectPath, input.sessionName);
    activeLoops.add(key);
    let execution = input.execution;
    const retryableRecoveryAttempts = new Map<string, number>();
    const execLogger = getExecutionLogger(execution.id);

    execLogger?.lifecycle("loop.started", {
      executionId: execution.id,
      activeContextId: execution.activeContextId,
    });
    logger.info("graph-workflow.loop.started", {
      executionId: execution.id,
    });

    try {
      while (execution.status === "running") {
        if (!execution.activeContextId) {
          execution = await deps.workflowManager.scheduleNextContext(
            input.projectPath,
            input.sessionName,
          );

          if (!execution.activeContextId) {
            execLogger?.lifecycle("loop.no_eligible_contexts");
            execution = await deps.workflowManager.send(
              input.projectPath,
              input.sessionName,
              { type: "complete" },
            );
            emitDone(deps, input.projectPath, input.sessionName, "completed");
            return execution;
          }
        }

        const contextId = execution.activeContextId;
        if (!contextId) {
          continue;
        }

        let iterationResult: GraphWorkflowIterationResult;
        try {
          iterationResult = await deps.iterationOrchestrator.runIteration({
            projectPath: input.projectPath,
            projectName: input.projectName,
            sessionName: input.sessionName,
            contextId,
          });
          retryableRecoveryAttempts.delete(contextId);
        } catch (error) {
          const recoveryAttempts =
            retryableRecoveryAttempts.get(contextId) ?? 0;
          const recoverRetryableIterationError =
            deps.workflowManager.recoverRetryableIterationError;
          const canRecover =
            isRetryableIterationError(error) &&
            recoveryAttempts < 1 &&
            recoverRetryableIterationError;

          if (!canRecover) {
            throw error;
          }

          const errorMessage = getErrorMessage(error);
          retryableRecoveryAttempts.set(contextId, recoveryAttempts + 1);
          execLogger?.decision("iteration.retryable_error_detected", {
            contextId,
            error: errorMessage,
            recoveryAttempt: recoveryAttempts + 1,
            maxRecoveryAttempts: 1,
          });
          logger.warn("graph-workflow.loop.retryable_iteration_error", {
            executionId: execution.id,
            contextId,
            error: errorMessage,
            recoveryAttempt: recoveryAttempts + 1,
          });
          execution = await recoverRetryableIterationError(
            input.projectPath,
            input.sessionName,
            {
              contextId,
              errorMessage,
            },
          );
          continue;
        }
        execution = iterationResult.execution;

        if (execution.status !== "running") {
          emitDone(
            deps,
            input.projectPath,
            input.sessionName,
            execution.haltReason?.type ?? execution.status,
          );
          return execution;
        }

        const contextState = execution.contextStates[contextId];
        const contextDef = execution.workingDefinition.executionContexts.find(
          (c) => c.id === contextId,
        );

        // Circuit breaker: halt if consecutive validation failures exceed threshold
        if (contextState && contextDef) {
          const threshold =
            contextDef.circuitBreaker.consecutiveFailureThreshold ??
            DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
          if (contextState.consecutiveFailureCount >= threshold) {
            execLogger?.decision("circuit_breaker.tripped", {
              contextId,
              consecutiveFailureCount: contextState.consecutiveFailureCount,
              threshold,
            });
            execution = await deps.workflowManager.send(
              input.projectPath,
              input.sessionName,
              {
                type: "halt",
                reason: {
                  type: "circuit_breaker",
                  contextId,
                  condition: "retry_exhaustion",
                  failureCount: contextState.consecutiveFailureCount,
                  summary: null,
                },
              },
            );
            emitDone(
              deps,
              input.projectPath,
              input.sessionName,
              "circuit_breaker",
            );
            return execution;
          }
        }

        if (
          contextState &&
          contextDef &&
          contextState.iterationCount >=
            contextDef.iterationPolicy.maxIterations
        ) {
          execLogger?.decision("max_iterations.reached", {
            contextId,
            iterationCount: contextState.iterationCount,
            maxIterations: contextDef.iterationPolicy.maxIterations,
          });
          execution = await deps.workflowManager.send(
            input.projectPath,
            input.sessionName,
            {
              type: "halt",
              reason: {
                type: "max_iterations",
                contextId,
                iterationCount: contextState.iterationCount,
              },
            },
          );
          emitDone(
            deps,
            input.projectPath,
            input.sessionName,
            "max_iterations",
          );
          return execution;
        }

        if (iterationResult.shouldContinueInContext) {
          execLogger?.iteration(contextId, "loop.continue_in_context", {
            conversationId: iterationResult.conversationId,
          });
          continue;
        }

        // All tasks completed — context is done, schedule next
        // (scheduleNextContext will mark the current context as completed)
      }

      emitDone(
        deps,
        input.projectPath,
        input.sessionName,
        execution.haltReason?.type ?? execution.status,
      );
      return execution;
    } catch (error) {
      execLogger?.lifecycle("loop.recovery_error", {
        error: getErrorMessage(error),
      });
      logger.error("graph-workflow.loop.recovery_error", {
        executionId: execution.id,
        error: getErrorMessage(error),
      });
      const haltedExecution = await deps.workflowManager.send(
        input.projectPath,
        input.sessionName,
        {
          type: "halt",
          reason: {
            type: "recovery_error",
            message: getErrorMessage(error),
          },
        },
      );
      emitDone(
        deps,
        input.projectPath,
        input.sessionName,
        haltedExecution.haltReason?.type ?? "recovery_error",
      );
      return haltedExecution;
    } finally {
      activeLoops.delete(key);
    }
  }

  return { run };
}
