import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/errors";
import { captureTraceContext, createLogger, runAsTrace } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  MergePreconditionFailed,
  toHaltReason,
  type DirtyPath,
} from "./errors";
import {
  runCircuitBreakerGate as defaultRunCircuitBreakerGate,
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";
import type {
  ExecutionTargetResolver,
  ExecutionTarget,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import type { PerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/workflow-graph/session-git-lock";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type { SoloContextCommitter } from "@/lib/workflow-graph/solo-context-committer";
import {
  applyLaneCommitSnapshot,
  type LaneCommitter,
} from "@/lib/workflow-graph/lane-committer";
import type { JoinRunner } from "@/lib/workflow-graph/join-runner";
import { classifyContextSchedulability } from "@/lib/workflow-graph/lane-readiness";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import {
  SESSION_LANE_ID,
  appendPendingJoin,
  findActiveJoin,
  materializeSessionLane,
  planContextJoin,
  planFinalPublishJoin,
} from "@/lib/workflow-graph/lane-join";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  SessionState,
} from "@/types";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import { hasPartialIterationProgress } from "./iteration-failure-with-progress";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import type {
  RecordPendingHaltReasonResult,
  ScheduleEligibleContextsResult,
} from "./workflow-manager";

export interface GraphWorkflowExecutionLoopInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  /**
   * Opt-in flag for session-lane participation (accepted design decision 10).
   * Defaults to `false` — every parallel chain runs on its own worktree lane
   * and is converged onto the session branch only at final publish. Callers
   * that have validated dirty-worktree/concurrent-job preconditions can pass
   * `true` to allow solo contexts to execute directly in the session worktree.
   */
  sessionLaneEnabled?: boolean;
}

export interface GraphWorkflowExecutionLoopWorkflowManager {
  scheduleEligibleContexts(input: {
    projectPath: string;
    sessionName: string;
    sessionLaneEnabled?: boolean;
  }): Promise<ScheduleEligibleContextsResult>;
  send(
    projectPath: string,
    sessionName: string,
    event: { type: "complete" },
  ): Promise<GraphWorkflowExecution>;
  recordPendingHaltReason(input: {
    projectPath: string;
    sessionName: string;
    reason: GraphWorkflowHaltReason;
    applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
  }): Promise<RecordPendingHaltReasonResult>;
  drainAndHalt(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<GraphWorkflowExecution>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  recoverRetryableIterationError?(
    projectPath: string,
    sessionName: string,
    input: { contextId: string; errorMessage: string },
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowExecutionLoopIterationOrchestrator {
  runIteration(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    contextId: string;
    executionTarget?: ExecutionTarget;
  }): Promise<GraphWorkflowIterationResult>;
}

export interface GraphWorkflowExecutionLoopDeps {
  workflowManager: GraphWorkflowExecutionLoopWorkflowManager;
  iterationOrchestrator: GraphWorkflowExecutionLoopIterationOrchestrator;
  parallelWorktrees: ParallelWorktrees;
  mergeMutex: PerSessionMergeMutex;
  sessionGitLock: SessionGitLock;
  mergeRunner: GraphMergeRunner;
  soloContextCommitter: SoloContextCommitter;
  laneCommitter: LaneCommitter;
  joinRunner: JoinRunner;
  executionTargetResolver: ExecutionTargetResolver;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * Optional override for the shared circuit-breaker gate primitive. The loop
   * routes the per-context "consecutive failures hit threshold" decision
   * through `runCircuitBreakerGate` so the halt vocabulary stays unified with
   * the iteration-orchestrator's gate-based circuit breaker.
   */
  runCircuitBreakerGate?: (
    input: RunCircuitBreakerGateInput,
  ) => CircuitBreakerGateResult;
  createJobId?: () => string;
  /**
   * Read tracked dirty paths from the session worktree. Used by the pre-batch
   * preflight to halt before scheduling worktree-isolation contexts whose
   * fan-in merge would inevitably fail. Default returns [] (clean), keeping
   * existing tests unchanged.
   */
  getSessionWorktreeDirtyPaths?: (input: {
    sessionWorktreePath: string;
  }) => Promise<DirtyPath[]>;
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

// -- Helpers ------------------------------------------------------------------

function isRetryableIterationError(error: unknown): boolean {
  return /stream closed|querysession (died|is dead|ended before)|processtransport is not ready for writing/i.test(
    getErrorMessage(error),
  );
}

// -- Execution loop -----------------------------------------------------------

const logger = createLogger("graph-workflow-execution-loop");

export function createGraphWorkflowExecutionLoop(
  deps: GraphWorkflowExecutionLoopDeps,
) {
  const runCircuitBreakerGate =
    deps.runCircuitBreakerGate ?? defaultRunCircuitBreakerGate;
  const createJobId = deps.createJobId ?? (() => randomUUID());

  function run(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<GraphWorkflowExecution> {
    return runAsTrace(
      `workflow:${input.execution.id}`,
      () => runImpl(input),
      captureTraceContext(),
    );
  }

  async function runImpl(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<GraphWorkflowExecution> {
    const key = loopKey(input.projectPath, input.sessionName);
    activeLoops.add(key);
    let execution = input.execution;
    const retryableRecoveryAttempts = new Map<string, number>();
    const inFlight = new Map<string, Promise<void>>();
    const execLogger = getExecutionLogger(execution.id);

    execLogger?.lifecycle("loop.started", {
      executionId: execution.id,
      activeContextIds: execution.activeContextIds,
    });
    logger.info("graph-workflow.loop.started", {
      executionId: execution.id,
    });

    async function recordHalt(reason: GraphWorkflowHaltReason): Promise<void> {
      const result = await deps.workflowManager.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason,
      });
      execution = result.execution;
    }

    async function readSessionWorktreeDirtyPaths(
      sessionWorktreePath: string,
    ): Promise<DirtyPath[]> {
      if (!deps.getSessionWorktreeDirtyPaths) return [];
      try {
        return await deps.getSessionWorktreeDirtyPaths({ sessionWorktreePath });
      } catch (err) {
        logger.warn("graph-workflow.preflight.dirty_read_failed", {
          executionId: execution.id,
          sessionWorktreePath,
          error: getErrorMessage(err),
        });
        return [];
      }
    }

    async function preflightSessionWorktreeForNextBatch(): Promise<boolean> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) return false;

      const needsWorktreeBatch =
        execution.workingDefinition.executionContexts.some((ctx) => {
          const state = execution.contextStates[ctx.id];
          if (!state) return false;
          if (state.status !== "pending" && state.status !== "ready")
            return false;
          return state.isolation === "worktree";
        });
      if (!needsWorktreeBatch) return false;

      const dirty = await readSessionWorktreeDirtyPaths(session.worktreePath);
      const trackedDirty = dirty.filter((p) => p.tracked);
      if (trackedDirty.length === 0) return false;

      const firstEligibleContextId =
        execution.workingDefinition.executionContexts.find((ctx) => {
          const state = execution.contextStates[ctx.id];
          if (!state) return false;
          if (state.status !== "pending" && state.status !== "ready")
            return false;
          return state.isolation === "worktree";
        })?.id ?? "";

      const haltReason = toHaltReason(
        new MergePreconditionFailed(
          `Target branch '${session.branchName}' has ${trackedDirty.length} uncommitted change(s)`,
          {
            targetBranch: session.branchName,
            dirtyPaths: trackedDirty,
            dirtyCount: trackedDirty.length,
          },
        ),
        { contextId: firstEligibleContextId, cause: "io" },
      );

      execLogger?.lifecycle("preflight.session_branch_dirty", {
        targetBranch: session.branchName,
        dirtyCount: trackedDirty.length,
        dirtyPaths: trackedDirty.slice(0, 5),
      });
      logger.info("graph-workflow.preflight.session_branch_dirty", {
        executionId: execution.id,
        targetBranch: session.branchName,
        dirtyCount: trackedDirty.length,
      });
      await recordHalt(haltReason);
      return true;
    }

    async function processPendingMergeRetry(): Promise<void> {
      while (execution.pendingMergeRetry.length > 0) {
        const contextId = execution.pendingMergeRetry[0];
        if (!contextId) break;
        const state = execution.contextStates[contextId];
        if (
          !state ||
          state.worktreePath === null ||
          state.branchName === null
        ) {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              next.pendingMergeRetry = next.pendingMergeRetry.filter(
                (id) => id !== contextId,
              );
              return next;
            },
          );
          const refreshed = await deps.workflowManager.getActive(
            input.projectPath,
            input.sessionName,
          );
          if (refreshed) execution = refreshed;
          continue;
        }
        execLogger?.lifecycle("merge.retry_attempted", { contextId });
        logger.info("graph-workflow.merge.retry_attempted", {
          executionId: execution.id,
          contextId,
        });
        await runFanInMerge(contextId, state.worktreePath, state.branchName);

        const refreshed = await deps.workflowManager.getActive(
          input.projectPath,
          input.sessionName,
        );
        if (refreshed) execution = refreshed;

        const refreshedState = execution.contextStates[contextId];
        if (refreshedState?.mergeStatus === "merged-success") {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              next.pendingMergeRetry = next.pendingMergeRetry.filter(
                (id) => id !== contextId,
              );
              return next;
            },
          );
          const post = await deps.workflowManager.getActive(
            input.projectPath,
            input.sessionName,
          );
          if (post) execution = post;
          continue;
        }
        // Merge failed again — halt path is already recorded by runFanInMerge.
        return;
      }
    }

    async function runFanInMerge(
      contextId: string,
      featureWorktreePath: string,
      featureBranchName: string,
    ): Promise<void> {
      execLogger?.iteration(contextId, "merge.queued", {
        branchName: featureBranchName,
        worktreePath: featureWorktreePath,
      });
      logger.info("graph-workflow.merge.queued", {
        executionId: execution.id,
        contextId,
        branchName: featureBranchName,
      });

      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              const cs = next.contextStates[contextId];
              if (cs) {
                cs.mergeStatus = "in-progress";
              }
              return next;
            },
          );

          execLogger?.iteration(contextId, "merge.started", {
            branchName: featureBranchName,
          });
          logger.info("graph-workflow.merge.started", {
            executionId: execution.id,
            contextId,
            branchName: featureBranchName,
          });

          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during fan-in merge`,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
                applyAdditionalMutation: (next) => {
                  const cs = next.contextStates[contextId];
                  if (cs) {
                    cs.mergeStatus = "merged-failed";
                    cs.lastMergeError = reason.message;
                  }
                },
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.merge.failed", {
              executionId: execution.id,
              contextId,
              reason: reason.message,
            });
            return;
          }

          let mergeStatus: "completed" | "failed" | "conflicts";
          let mergeError: string | null = null;
          let mergeConflictFiles: string[] = [];
          try {
            const output = await deps.sessionGitLock.withSessionGitLock(
              {
                projectPath: input.projectPath,
                sessionName: input.sessionName,
              },
              async () =>
                deps.mergeRunner.run({
                  jobId: createJobId(),
                  projectPath: input.projectPath,
                  projectName: input.projectName,
                  sessionName: input.sessionName,
                  contextId,
                  branchName: featureBranchName,
                  featureWorktreePath,
                  targetBranch: session.branchName,
                  targetWorktreePath: session.worktreePath,
                  message: `Graph workflow context ${contextId}`,
                }),
            );
            mergeStatus = output.status;
            mergeError = output.error;
            mergeConflictFiles = output.conflictFiles;
          } catch (error) {
            if (error instanceof MergePreconditionFailed) {
              const haltReason = toHaltReason(error, {
                contextId,
                cause: "io",
              });
              const haltResult =
                await deps.workflowManager.recordPendingHaltReason({
                  projectPath: input.projectPath,
                  sessionName: input.sessionName,
                  reason: haltReason,
                  applyAdditionalMutation: (next) => {
                    const cs = next.contextStates[contextId];
                    if (cs) {
                      cs.mergeStatus = "merged-failed";
                      cs.lastMergeError = error.message;
                    }
                  },
                });
              execution = haltResult.execution;
              logger.error("graph-workflow.merge.precondition_failed", {
                executionId: execution.id,
                contextId,
                targetBranch: error.targetBranch,
                dirtyCount: error.dirtyCount,
              });
              return;
            }
            mergeStatus = "failed";
            mergeError = getErrorMessage(error);
            mergeConflictFiles = [];
          }

          if (mergeStatus === "completed") {
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) => {
                const next = structuredClone(e);
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.mergeStatus = "merged-success";
                  cs.lastMergeError = null;
                }
                return next;
              },
            );

            execLogger?.iteration(contextId, "merge.completed", {
              branchName: featureBranchName,
            });
            logger.info("graph-workflow.merge.completed", {
              executionId: execution.id,
              contextId,
              branchName: featureBranchName,
            });

            const dispose = await deps.parallelWorktrees.dispose({
              projectPath: input.projectPath,
              worktreePath: featureWorktreePath,
              branchName: featureBranchName,
            });
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) => {
                const next = structuredClone(e);
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.cleanupStatus =
                    dispose.status === "removed" ? "removed" : "failed";
                }
                return next;
              },
            );
            execLogger?.lifecycle("parallel.cleanup_attempted", {
              contextId,
              status: dispose.status,
              reason: dispose.status === "failed" ? dispose.reason : undefined,
            });
            return;
          }

          const finalMergeStatus =
            mergeStatus === "conflicts" ? "conflicts" : "merged-failed";
          const haltReason: GraphWorkflowHaltReason = {
            type: "merge_failure",
            contextId,
            message: mergeError ?? "Fan-in merge failed",
            conflictFiles: mergeConflictFiles,
          };
          const haltResult = await deps.workflowManager.recordPendingHaltReason(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              reason: haltReason,
              applyAdditionalMutation: (next) => {
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.mergeStatus = finalMergeStatus;
                  cs.lastMergeError = mergeError;
                }
              },
            },
          );
          execution = haltResult.execution;
          logger.error("graph-workflow.merge.failed", {
            executionId: execution.id,
            contextId,
            mergeStatus: finalMergeStatus,
            error: mergeError,
            conflictFiles: mergeConflictFiles.length,
          });
        },
      );
    }

    async function runContextTask(contextId: string): Promise<void> {
      execLogger?.lifecycle("parallel.context_started", {
        contextId,
      });

      let isolation: "session" | "worktree" = "session";
      let featureWorktreePath: string | null = null;
      let featureBranchName: string | null = null;
      let featureLaneId: string | null = null;

      try {
        // Inner per-context iteration loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            await recordHalt({
              type: "recovery_error",
              message: `Session "${input.sessionName}" not found during iteration`,
            });
            return;
          }

          const target = deps.executionTargetResolver.resolve({
            execution,
            contextId,
            session,
          });
          isolation = target.isolation;
          featureLaneId = target.laneId;
          if (target.isolation === "worktree") {
            featureWorktreePath = target.worktreePath;
            featureBranchName = target.branchName;
          }

          let iterationResult: GraphWorkflowIterationResult;
          try {
            iterationResult = await deps.iterationOrchestrator.runIteration({
              projectPath: input.projectPath,
              projectName: input.projectName,
              sessionName: input.sessionName,
              contextId,
              executionTarget: target,
            });
            retryableRecoveryAttempts.delete(contextId);
          } catch (error) {
            if (hasPartialIterationProgress(error)) {
              retryableRecoveryAttempts.delete(contextId);
            }
            const recoveryAttempts =
              retryableRecoveryAttempts.get(contextId) ?? 0;
            const recoverRetryableIterationError =
              deps.workflowManager.recoverRetryableIterationError;
            const canRecover =
              isRetryableIterationError(error) &&
              recoveryAttempts < 1 &&
              recoverRetryableIterationError;

            if (!canRecover) {
              await recordHalt(
                toHaltReason(error, { contextId, cause: "sdk_error" }),
              );
              return;
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
              { contextId, errorMessage },
            );
            continue;
          }

          execution = iterationResult.execution;

          if (execution.status !== "running") {
            // Orchestrator-driven halt (e.g., signalHalt). Stop iterating;
            // the outer loop's drain-then-halt path takes over.
            return;
          }

          const contextState = execution.contextStates[contextId];
          const contextDef = execution.workingDefinition.executionContexts.find(
            (c) => c.id === contextId,
          );

          if (contextState?.status === "halted") {
            execLogger?.iteration(contextId, "loop.context_halted", {
              pendingHaltReason: execution.pendingHaltReason,
            });
            logger.info("graph-workflow.parallel.context_halted", {
              executionId: execution.id,
              contextId,
              haltReasonType: execution.pendingHaltReason?.type ?? null,
            });
            return;
          }

          if (contextState && contextDef) {
            const threshold =
              contextDef.circuitBreaker.consecutiveFailureThreshold ??
              DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
            const gateResult = runCircuitBreakerGate({
              failureCount: contextState.consecutiveFailureCount,
              threshold,
            });
            if (gateResult.status === "fail") {
              execLogger?.decision("circuit_breaker.tripped", {
                contextId,
                consecutiveFailureCount: contextState.consecutiveFailureCount,
                threshold,
              });
              await recordHalt({
                type: "circuit_breaker",
                contextId,
                condition: "retry_exhaustion",
                failureCount: contextState.consecutiveFailureCount,
                summary: null,
              });
              return;
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
            await recordHalt({
              type: "max_iterations",
              contextId,
              iterationCount: contextState.iterationCount,
            });
            return;
          }

          if (iterationResult.shouldContinueInContext) {
            execLogger?.iteration(contextId, "loop.continue_in_context", {
              conversationId: iterationResult.conversationId,
            });
            continue;
          }

          // Context completed all of its tasks — break out for fan-in merge.
          break;
        }
      } finally {
        execLogger?.lifecycle("parallel.context_finished", {
          contextId,
          isolation,
        });
      }

      if (
        isolation === "worktree" &&
        featureWorktreePath !== null &&
        featureBranchName !== null
      ) {
        if (featureLaneId !== null) {
          await runLaneCommit(
            contextId,
            featureLaneId,
            featureWorktreePath,
            featureBranchName,
          );
        } else {
          await runFanInMerge(
            contextId,
            featureWorktreePath,
            featureBranchName,
          );
        }
      } else if (isolation === "session") {
        await runSoloCommit(contextId);
      }
    }

    async function runLaneCommit(
      contextId: string,
      laneId: string,
      laneWorktreePath: string,
      laneBranchName: string,
    ): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          execLogger?.iteration(contextId, "lane_commit.started", {
            laneId,
            laneWorktreePath,
            laneBranchName,
          });
          logger.info("graph-workflow.lane_commit.started", {
            executionId: execution.id,
            contextId,
            laneId,
            laneBranchName,
          });

          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.laneCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                laneId,
                laneWorktreePath,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
                applyAdditionalMutation: (next) => {
                  const cs = next.contextStates[contextId];
                  if (cs) {
                    cs.mergeStatus = "merged-failed";
                    cs.lastMergeError = result.errorMessage;
                  }
                },
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.lane_commit.failed", {
              executionId: execution.id,
              contextId,
              laneId,
              error: result.errorMessage,
            });
            return;
          }

          if (result.status === "committed") {
            const snapshot = result.snapshot;
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) =>
                applyLaneCommitSnapshot(
                  {
                    ...e,
                    contextStates: {
                      ...e.contextStates,
                      ...(e.contextStates[contextId]
                        ? {
                            [contextId]: {
                              ...e.contextStates[contextId]!,
                              mergeStatus: "merged-success",
                              lastMergeError: null,
                            },
                          }
                        : {}),
                    },
                  },
                  laneId,
                  snapshot,
                ),
            );
            execLogger?.iteration(contextId, "lane_commit.completed", {
              laneId,
              sha: snapshot.sha,
              committedAt: snapshot.committedAt,
            });
            logger.info("graph-workflow.lane_commit.completed", {
              executionId: execution.id,
              contextId,
              laneId,
              sha: snapshot.sha,
            });
            return;
          }

          // status === "skipped" — no uncommitted changes on the lane. Still
          // mark the context as available in the lane so downstream contexts
          // (and any future join) see the work as ready, but do not append a
          // snapshot since no commit was made.
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              const lane = next.executionLanes[laneId];
              if (lane && !lane.includedContextIds.includes(contextId)) {
                lane.includedContextIds = [
                  ...lane.includedContextIds,
                  contextId,
                ];
              }
              const cs = next.contextStates[contextId];
              if (cs) {
                cs.mergeStatus = "merged-success";
              }
              return next;
            },
          );
          execLogger?.iteration(contextId, "lane_commit.skipped", {
            laneId,
            laneWorktreePath,
          });
          logger.info("graph-workflow.lane_commit.skipped", {
            executionId: execution.id,
            contextId,
            laneId,
          });
        },
      );
    }

    async function runSoloCommit(contextId: string): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during solo-context commit`,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.solo_commit.session_missing", {
              executionId: execution.id,
              contextId,
            });
            return;
          }

          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.soloContextCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                sessionWorktreePath: session.worktreePath,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.solo_commit.failed", {
              executionId: execution.id,
              contextId,
              error: result.errorMessage,
            });
            return;
          }

          execLogger?.iteration(contextId, "solo_commit.completed", {
            status: result.status,
          });
          logger.info("graph-workflow.solo_commit.recorded", {
            executionId: execution.id,
            contextId,
            status: result.status,
          });

          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const cs = e.contextStates[contextId];
              if (!cs || cs.laneId === null) return e;
              const lane = e.executionLanes[cs.laneId];
              if (!lane || lane.kind !== "session") return e;
              if (lane.includedContextIds.includes(contextId)) return e;
              const next = structuredClone(e);
              const nextLane = next.executionLanes[cs.laneId];
              if (nextLane) {
                nextLane.includedContextIds = [
                  ...nextLane.includedContextIds,
                  contextId,
                ];
              }
              return next;
            },
          );
        },
      );
    }

    async function runEligibleJoinIfAny(): Promise<"ran" | "halted" | "none"> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        await recordHalt({
          type: "recovery_error",
          message: `Session "${input.sessionName}" not found during join orchestration`,
        });
        return "halted";
      }

      execution = await deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (e) =>
          materializeSessionLane(e, {
            sessionLaneId: SESSION_LANE_ID,
            branchName: session.branchName,
            worktreePath: session.worktreePath,
            now: () => new Date().toISOString(),
          }),
      );

      let active = findActiveJoin(execution);
      if (!active) {
        const eligibleIds = getEligibleContextIds(
          execution.workingDefinition,
          execution,
        );
        let planned = null as ReturnType<typeof planContextJoin> | null;
        let plannedFor: "context" | "final_publish" | null = null;
        for (const contextId of eligibleIds) {
          const classification = classifyContextSchedulability({
            contextId,
            definition: execution.workingDefinition,
            execution,
          });
          if (classification.kind !== "wait-for-join") continue;
          planned = planContextJoin({
            contextId,
            execution,
            now: () => new Date().toISOString(),
            generateJoinId: () => createJobId(),
          });
          if (planned) {
            plannedFor = "context";
            break;
          }
        }

        if (!planned) {
          planned = planFinalPublishJoin({
            execution,
            sessionLaneId: SESSION_LANE_ID,
            now: () => new Date().toISOString(),
            generateJoinId: () => createJobId(),
          });
          if (planned) plannedFor = "final_publish";
        }

        if (!planned) return "none";

        const toPersist = planned;
        execution = await deps.workflowManager.mutateActive(
          input.projectPath,
          input.sessionName,
          (e) => appendPendingJoin(e, toPersist),
        );
        active = toPersist;
        execLogger?.lifecycle("join.planned", {
          joinId: planned.joinId,
          kind: planned.kind,
          contextId: planned.contextId,
          sourceLaneIds: planned.sourceLaneIds,
          targetLaneId: planned.targetLaneId,
        });
        logger.info("graph-workflow.join.planned", {
          executionId: execution.id,
          joinId: planned.joinId,
          kind: planned.kind,
          plannedFor,
          sourceLaneIds: planned.sourceLaneIds,
          targetLaneId: planned.targetLaneId,
        });
      }

      const join = active;
      execLogger?.lifecycle("join.started", {
        joinId: join.joinId,
        kind: join.kind,
        sourceLaneIds: join.sourceLaneIds,
        targetLaneId: join.targetLaneId,
      });
      logger.info("graph-workflow.join.started", {
        executionId: execution.id,
        joinId: join.joinId,
        kind: join.kind,
      });

      const result = await deps.joinRunner.run({
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        joinId: join.joinId,
        mutateActive: (mutator) =>
          deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            mutator,
          ),
      });

      const refreshed = await deps.workflowManager.getActive(
        input.projectPath,
        input.sessionName,
      );
      if (refreshed) execution = refreshed;

      if (result.status === "succeeded") {
        execLogger?.lifecycle("join.completed", {
          joinId: join.joinId,
          kind: join.kind,
        });
        return "ran";
      }

      const haltResult = await deps.workflowManager.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: {
          type: "join_failure",
          joinId: join.joinId,
          joinKind: join.kind,
          contextId: join.contextId,
          sourceLaneIds: join.sourceLaneIds,
          targetLaneId: join.targetLaneId,
          message: result.message,
          conflictFiles: result.conflictFiles,
        },
      });
      execution = haltResult.execution;
      execLogger?.lifecycle("join.failed", {
        joinId: join.joinId,
        kind: join.kind,
        failedSourceLaneId: result.failedSourceLaneId,
        conflictFiles: result.conflictFiles,
      });
      logger.error("graph-workflow.join.failed", {
        executionId: execution.id,
        joinId: join.joinId,
        kind: join.kind,
        message: result.message,
        conflictFiles: result.conflictFiles.length,
      });
      return "halted";
    }

    try {
      // Outer scheduling loop: schedule currently-eligible work, wait for the
      // next in-flight context or merge event to settle, refresh execution
      // state, and reschedule. Downstream contexts can become eligible the
      // moment an upstream context lands without waiting for the full wave to
      // drain.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (execution.status !== "running") {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          break;
        }

        if (execution.pendingHaltReason !== null) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          execution = await deps.workflowManager.drainAndHalt({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          });
          break;
        }

        if (execution.pendingMergeRetry.length > 0 && inFlight.size === 0) {
          await processPendingMergeRetry();
          if (execution.pendingHaltReason !== null) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          continue;
        }

        if (inFlight.size === 0) {
          const halted = await preflightSessionWorktreeForNextBatch();
          if (halted) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
        }

        const scheduleResult =
          await deps.workflowManager.scheduleEligibleContexts({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            sessionLaneEnabled: input.sessionLaneEnabled,
          });
        execution = scheduleResult.execution;

        if (scheduleResult.scheduled.kind === "none") {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          if (execution.pendingHaltReason !== null) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          const joinOutcome = await runEligibleJoinIfAny();
          if (joinOutcome === "halted") {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          if (joinOutcome === "ran") {
            continue;
          }
          execution = await deps.workflowManager.send(
            input.projectPath,
            input.sessionName,
            { type: "complete" },
          );
          break;
        }

        const scheduledContextIds =
          scheduleResult.scheduled.kind === "solo"
            ? [scheduleResult.scheduled.contextId]
            : scheduleResult.scheduled.contextIds;

        for (const contextId of scheduledContextIds) {
          if (inFlight.has(contextId)) continue;
          const task = runContextTask(contextId).finally(() => {
            inFlight.delete(contextId);
          });
          inFlight.set(contextId, task);
        }

        // Wait for the next in-flight context or merge event to settle, then
        // refresh and reschedule. Newly eligible downstream contexts are
        // picked up immediately instead of being held behind the slowest peer
        // in the current wave.
        if (inFlight.size > 0) {
          await Promise.race(inFlight.values());
        }

        const refreshed = await deps.workflowManager.getActive(
          input.projectPath,
          input.sessionName,
        );
        if (refreshed) {
          execution = refreshed;
        }
      }

      return execution;
    } catch (error) {
      execLogger?.lifecycle("loop.recovery_error", {
        error: getErrorMessage(error),
      });
      logger.error("graph-workflow.loop.recovery_error", {
        executionId: execution.id,
        error: getErrorMessage(error),
      });
      try {
        await deps.workflowManager.recordPendingHaltReason({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          reason: {
            type: "recovery_error",
            message: getErrorMessage(error),
          },
        });
      } catch (recordErr) {
        logger.error("graph-workflow.loop.record_halt_failed", {
          executionId: execution.id,
          error: getErrorMessage(recordErr),
        });
      }
      await Promise.allSettled(inFlight.values());
      const haltedExecution = await deps.workflowManager.drainAndHalt({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      return haltedExecution;
    } finally {
      activeLoops.delete(key);
    }
  }

  return { run };
}
