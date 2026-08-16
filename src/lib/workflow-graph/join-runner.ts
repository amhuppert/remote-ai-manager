import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, type Logger } from "@/lib/logging";
import { abortInProgressMerge as defaultAbortInProgressMerge } from "@/lib/git/worktree";
import {
  inspectInProgressMerge as defaultInspectInProgressMerge,
  type InProgressMergeState,
} from "@/lib/git/conflict-markers";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import type { ConflictEntry } from "@/lib/jobs/schemas";
import type { DeliveryGateHaltReason } from "@/lib/jobs/schemas";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";
import type { MergeOutput } from "@/lib/workflows/merge/types";
import type { GraphMergeRunner } from "./graph-merge-runner";
import type { PerSessionMergeMutex } from "./per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/shared/lock-retry";
import type { MergeValidationMode } from "@/lib/workflows/validation-fix/types";
import { applyJoinProgress } from "./context-transitions";
import { remainingSourceLanes, resolveLaneConversationId } from "./lane-join";
import { buildJoinResolutionContext } from "./join-resolution-context";
import {
  laneMergeCommandIdentity,
  resolveLaneMergeRunValidationMode,
  type ReadLaneMergeRepoConfig,
} from "./lane-merge-validation";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflow-graph/schemas";
const defaultLogger = createLogger("graph-workflow-join-runner");

export type JoinRunnerMutateActive = (
  mutator: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
) => Promise<GraphWorkflowExecution>;

interface JoinRunnerRunInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  joinId: string;
  mutateActive: JoinRunnerMutateActive;
  /**
   * Execution lifecycle sink (execution-loop's execLogger). Sub-step records
   * (per-lane merge start/end, validation deferral, conflict retry) make join
   * wall clock attributable — without them a join is a single opaque
   * started→completed bracket. Optional: a missing sink only loses telemetry.
   */
  lifecycle?(event: string, fields: Record<string, unknown>): void;
}

type JoinRunResult =
  | { status: "succeeded" }
  | {
      status: "failed";
      message: string;
      conflictFiles: string[];
      failedSourceLaneId: string;
      haltReason: DeliveryGateHaltReason | null;
      /**
       * Set when the conflict resolver failed before reaching a verdict.
       * Carried onto the workflow halt so a resume can tell an exhausted quota
       * (nothing to retry into) from a merge worth another attempt.
       */
      resolutionFailure: AgentFailureClassification | null;
    };

/**
 * Why a failed merge attempt is worth the join's single clean retry, or null
 * when it is not.
 *
 * Retryability is the classification's own answer, not a status string: a
 * quota-exhausted resolver is down until capacity returns, and spending the
 * retry nine seconds later (incident 3edd5fd7) buys nothing while consuming
 * the budget a genuinely transient failure needs.
 */
function cleanRetryCause(
  output: MergeOutput,
): "conflicts" | "resolution_infrastructure" | null {
  if (output.status === "conflicts") return "conflicts";
  const haltReason = output.haltReason;
  if (
    output.status === "failed" &&
    haltReason?.type === "resolution_infrastructure" &&
    haltReason.failure.retryable
  ) {
    return "resolution_infrastructure";
  }
  return null;
}

/** Halt text naming the infrastructure that stopped the resolver. */
function resolutionInfrastructureMessage(
  failure: AgentFailureClassification,
): string {
  const hint =
    failure.retryAfterHint === undefined
      ? ""
      : ` (capacity hint: ${failure.retryAfterHint})`;
  return `Conflict resolution failed before reaching the conflict: ${failure.kind} — ${failure.message}${hint}`;
}

export interface JoinRunner {
  run(input: JoinRunnerRunInput): Promise<JoinRunResult>;
}

export interface JoinRunnerDeps {
  mergeRunner: GraphMergeRunner;
  sessionGitLock: SessionGitLock;
  mergeMutex: PerSessionMergeMutex;
  /** Aborts an unconcluded `git merge` (MERGE_HEAD present); returns whether
   *  an abort happened. Defaults to the real git helper. */
  abortInProgressMerge?(worktreePath: string): Promise<boolean>;
  /** Classifies an unconcluded merge before the preflight decides whether it
   *  may be discarded. Defaults to the real git helper. */
  inspectInProgressMerge?(worktreePath: string): Promise<InProgressMergeState>;
  /** Repairs private-index landing residue before a graph-owned worktree lane
   *  becomes either side of a merge. Production composition supplies the git
   *  helper; merge-runner tests that use synthetic paths may omit it. */
  resyncSharedIndex?(worktreePath: string): Promise<void>;
  readRepoConfig?: ReadLaneMergeRepoConfig;
  logger?: Logger;
  createJobId?(): string;
  now?(): string;
}

function coveredContextIdsForLanes(
  execution: GraphWorkflowExecution,
  join: GraphWorkflowExecutionJoinState,
  laneIds: readonly string[],
): string[] {
  const covered = new Set<string>();
  for (const laneId of laneIds) {
    const contextIds =
      join.sourceLaneContextIds?.[laneId] ??
      execution.executionLanes[laneId]?.includedContextIds ??
      [];
    for (const contextId of contextIds) covered.add(contextId);
  }
  return [...covered];
}

export function createJoinRunner(deps: JoinRunnerDeps): JoinRunner {
  const createJobId = deps.createJobId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());
  const abortInProgressMerge =
    deps.abortInProgressMerge ?? defaultAbortInProgressMerge;
  const inspectInProgressMerge =
    deps.inspectInProgressMerge ?? defaultInspectInProgressMerge;
  const resyncSharedIndex = deps.resyncSharedIndex;
  const readRepoConfig = deps.readRepoConfig ?? defaultReadRepoConfig;
  const logger = deps.logger ?? defaultLogger;

  return {
    async run(input): Promise<JoinRunResult> {
      const {
        projectPath,
        projectName,
        sessionName,
        joinId,
        mutateActive,
        lifecycle,
      } = input;

      let execution = await mutateActive((e) =>
        applyJoinProgress(e, joinId, now(), { status: "running" }),
      );

      let join = execution.joins[joinId];
      if (!join) {
        const message = `Join ${joinId} not found`;
        logger.error("graph-workflow.join.missing", {
          joinId,
          executionId: execution.id,
        });
        return {
          status: "failed",
          message,
          conflictFiles: [],
          failedSourceLaneId: "",
          haltReason: null,
          resolutionFailure: null,
        };
      }

      const targetLane = execution.executionLanes[join.targetLaneId];
      if (!targetLane || targetLane.worktreePath === null) {
        const message = `Target lane ${join.targetLaneId} is missing or has no worktree path`;
        execution = await mutateActive((e) =>
          applyJoinProgress(e, joinId, now(), {
            status: "failed",
            errorMessage: message,
          }),
        );
        logger.error("graph-workflow.join.target_invalid", {
          joinId,
          targetLaneId: join.targetLaneId,
          executionId: execution.id,
        });
        return {
          status: "failed",
          message,
          conflictFiles: [],
          failedSourceLaneId: "",
          haltReason: null,
          resolutionFailure: null,
        };
      }

      const targetBranch = targetLane.branchName;
      const targetWorktreePath = targetLane.worktreePath;

      while (true) {
        const currentJoin: GraphWorkflowExecutionJoinState = join;
        const remaining = remainingSourceLanes(currentJoin);
        if (remaining.length === 0) {
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "succeeded",
              conflictGuidance: null,
            }),
          );
          logger.info("graph-workflow.join.completed", {
            joinId,
            kind: currentJoin.kind,
            targetLaneId: currentJoin.targetLaneId,
            executionId: execution.id,
          });
          return { status: "succeeded" };
        }

        const sourceLaneId = remaining[0]!;
        const sourceLane = execution.executionLanes[sourceLaneId];
        if (!sourceLane || sourceLane.worktreePath === null) {
          const message = `Source lane ${sourceLaneId} is missing or has no worktree path`;
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "failed",
              errorMessage: message,
            }),
          );
          logger.error("graph-workflow.join.source_invalid", {
            joinId,
            sourceLaneId,
            executionId: execution.id,
          });
          return {
            status: "failed",
            message,
            conflictFiles: [],
            failedSourceLaneId: sourceLaneId,
            haltReason: null,
            resolutionFailure: null,
          };
        }

        const laneMergeStartedMs = Date.parse(now());
        lifecycle?.("join.lane_merge.started", {
          joinId,
          sourceLaneId,
          remaining: remaining.length,
        });

        let mergeStatus:
          | "completed"
          | "failed"
          | "conflicts"
          | "ready-to-land"
          | "discarded";
        let mergeError: string | null = null;
        let mergeConflictFiles: string[] = [];
        let mergeConflictAnalysis: ConflictEntry[] | null = null;
        let mergeHaltReason: DeliveryGateHaltReason | null = null;
        let resolutionFailure: AgentFailureClassification | null = null;
        let completedMergeValidationMode: MergeValidationMode | null = null;
        // First-attempt conflict detail when the clean retry succeeds — the
        // retry's own output no longer knows the merge was ever conflicted.
        let cleanRetryConflicts: {
          files: string[];
          analysis: ConflictEntry[] | null;
        } | null = null;

        const sourceWorktreePath = sourceLane.worktreePath;
        const conversationId =
          resolveLaneConversationId(execution, sourceLaneId) ?? undefined;
        if (conversationId === undefined) {
          logger.warn("graph-workflow.join.lane_conversation_missing", {
            joinId,
            sourceLaneId,
            executionId: execution.id,
          });
        }
        try {
          const laneMergeValidation =
            execution.workingDefinition.laneMergeValidation;
          const shouldDeferValidation =
            laneMergeValidation.strategy === "final-only" &&
            currentJoin.kind !== "final_publish" &&
            remaining.length > 1;
          const coveredLaneIds = [
            ...new Set([
              ...(currentJoin.validationDebtSourceLaneIds ?? []),
              sourceLaneId,
            ]),
          ];
          const coveredContextIds = coveredContextIdsForLanes(
            execution,
            currentJoin,
            coveredLaneIds,
          );
          const resolutionContext =
            buildJoinResolutionContext(
              execution,
              currentJoin,
              sourceLaneId,
              coveredLaneIds,
            ) ?? undefined;

          const mergeCall = await deps.mergeMutex.withMergeMutex(
            { projectPath, sessionName },
            () =>
              deps.sessionGitLock.withSessionGitLock(
                { projectPath, sessionName },
                async () => {
                  // Self-healing preflight, ahead of both resyncs: a previously
                  // failed resolution leaves the source worktree mid-merge, git
                  // refuses to start a new merge over one, and the resync's own
                  // `reset --mixed HEAD` would erase MERGE_HEAD while leaving
                  // the marker-bearing files in place — destroying the evidence
                  // this abort depends on (incident 3edd5fd7). The resync then
                  // runs against the quiescent tree its contract assumes.
                  const staleMerge =
                    await inspectInProgressMerge(sourceWorktreePath);
                  if (staleMerge.kind === "resolved") {
                    // MERGE_HEAD with nothing left conflicting is what a human's
                    // finished hand-resolution looks like in the window before
                    // they commit it. Aborting would delete their work.
                    logger.error(
                      "graph-workflow.join.stale_merge_awaiting_commit",
                      { joinId, sourceLaneId, sourceWorktreePath },
                    );
                    return {
                      kind: "preflight_refused" as const,
                      message:
                        `Source lane ${sourceLaneId} holds a merge whose conflicts are resolved but not committed. ` +
                        `Commit the resolution in ${sourceWorktreePath} (or abort that merge), then resume.`,
                    };
                  }
                  if (staleMerge.kind === "unresolved") {
                    const staleAborted =
                      await abortInProgressMerge(sourceWorktreePath);
                    if (staleAborted) {
                      logger.info("graph-workflow.join.stale_merge_aborted", {
                        joinId,
                        sourceLaneId,
                        sourceWorktreePath,
                        unmergedFiles:
                          staleMerge.artifacts.unmergedFiles.length,
                        markerFiles: staleMerge.artifacts.markerFiles.length,
                      });
                    }
                  }

                  if (
                    sourceLane.kind === "worktree" &&
                    resyncSharedIndex !== undefined
                  ) {
                    await resyncSharedIndex(sourceWorktreePath);
                    logger.info("graph-workflow.join.source_index_resynced", {
                      joinId,
                      sourceLaneId,
                      sourceWorktreePath,
                    });
                  }

                  if (
                    targetLane.kind === "worktree" &&
                    resyncSharedIndex !== undefined
                  ) {
                    await resyncSharedIndex(targetWorktreePath);
                    logger.info("graph-workflow.join.target_index_resynced", {
                      joinId,
                      targetLaneId: currentJoin.targetLaneId,
                      targetWorktreePath,
                    });
                  }

                  const selectedValidationMode = shouldDeferValidation
                    ? ({ mode: "skip" } as const)
                    : await resolveLaneMergeRunValidationMode({
                        projectPath,
                        config: laneMergeValidation,
                        readRepoConfig,
                      });
                  const validationMode: MergeValidationMode =
                    selectedValidationMode.mode === "run"
                      ? {
                          ...selectedValidationMode,
                          coveredLaneIds,
                          ...(coveredContextIds.length > 0
                            ? { coveredContextIds }
                            : {}),
                        }
                      : selectedValidationMode;
                  if (validationMode.mode === "skip") {
                    logger.info("graph-workflow.join.validation_deferred", {
                      joinId,
                      sourceLaneId,
                      remaining: remaining.length,
                    });
                    lifecycle?.("join.validation_deferred", {
                      joinId,
                      sourceLaneId,
                      remaining: remaining.length,
                    });
                  }

                  const runMerge = () =>
                    deps.mergeRunner.run({
                      jobId: createJobId(),
                      projectPath,
                      projectName,
                      sessionName,
                      contextId: currentJoin.contextId ?? currentJoin.joinId,
                      branchName: sourceLane.branchName,
                      featureWorktreePath: sourceWorktreePath,
                      targetBranch,
                      targetWorktreePath,
                      message: `Graph workflow join ${currentJoin.kind} ${currentJoin.joinId}: ${sourceLaneId} -> ${currentJoin.targetLaneId}`,
                      conversationId,
                      decisions: currentJoin.conflictGuidance ?? undefined,
                      resolutionContext,
                      validationMode,
                      workflowExecutionId: execution.id,
                      // Final-publish joins land lanes on the session branch — still
                      // inside the execution's own workspace. The join carries the
                      // execution's provenance so the delivery gate enforces the proof
                      // floor here, but delivery itself (finalPublish → Delivered)
                      // belongs solely to the gated merge that lands on the project's
                      // delivery target.
                      ...(currentJoin.kind === "final_publish"
                        ? {
                            executionId: execution.id,
                            finalPublish: false,
                          }
                        : {}),
                    });

                  const first = await runMerge();
                  const retryCause = cleanRetryCause(first);
                  if (retryCause === null) {
                    return {
                      kind: "merged" as const,
                      output: first,
                      retriedConflicts: null,
                      validationMode,
                    };
                  }

                  // One clean retry before surfacing the failure: it is spent
                  // only on outcomes another attempt can change — a conflict a
                  // resolution attempt reached, or a retryable infrastructure
                  // failure — and retrying on top of a half-resolved tree is
                  // worse than starting over.
                  logger.info("graph-workflow.join.conflict_retry", {
                    joinId,
                    sourceLaneId,
                    retryCause,
                    conflictFiles: first.conflictFiles.length,
                  });
                  lifecycle?.("join.conflict_retry", {
                    joinId,
                    sourceLaneId,
                    retryCause,
                    conflictFileCount: first.conflictFiles.length,
                  });
                  await abortInProgressMerge(sourceWorktreePath);
                  return {
                    kind: "merged" as const,
                    output: await runMerge(),
                    retriedConflicts: {
                      files: first.conflictFiles,
                      analysis: first.conflictAnalysis,
                    },
                    validationMode,
                  };
                },
              ),
          );
          if (mergeCall.kind === "preflight_refused") {
            mergeStatus = "failed";
            mergeError = mergeCall.message;
            mergeConflictFiles = [];
            mergeHaltReason = null;
          } else {
            mergeStatus = mergeCall.output.status;
            mergeError = mergeCall.output.error;
            mergeConflictFiles = mergeCall.output.conflictFiles;
            mergeConflictAnalysis = mergeCall.output.conflictAnalysis;
            // The workflow halt vocabulary carries delivery-gate refusals only;
            // other merge halt reasons surface through the join's own failure
            // recording instead.
            mergeHaltReason =
              mergeCall.output.haltReason?.type === "delivery_gate_failed"
                ? mergeCall.output.haltReason
                : null;
            resolutionFailure =
              mergeCall.output.haltReason?.type === "resolution_infrastructure"
                ? mergeCall.output.haltReason.failure
                : null;
            cleanRetryConflicts = mergeCall.retriedConflicts;
            completedMergeValidationMode = mergeCall.validationMode;
          }
        } catch (err) {
          mergeStatus = "failed";
          mergeError = getErrorMessage(err);
          mergeConflictFiles = [];
          mergeHaltReason = null;
        }

        if (mergeStatus === "completed") {
          // A completed merge that carries conflict detail was resolved by a
          // smart-merge sub-turn; one resolved by the clean retry surfaces
          // only through the captured first-attempt detail. Either way the
          // join must not present as conflict-free (audit 1beec403 false
          // "clean merges" positive).
          const resolvedConflict =
            mergeConflictFiles.length > 0
              ? {
                  sourceLaneId,
                  files: mergeConflictFiles,
                  resolution: "sub_turn" as const,
                  analysis: mergeConflictAnalysis,
                }
              : cleanRetryConflicts !== null
                ? {
                    sourceLaneId,
                    files: cleanRetryConflicts.files,
                    resolution: "clean_retry" as const,
                    analysis: cleanRetryConflicts.analysis,
                  }
                : null;
          lifecycle?.("join.lane_merge.completed", {
            joinId,
            sourceLaneId,
            durationMs: Math.max(0, Date.parse(now()) - laneMergeStartedMs),
            validationMode: completedMergeValidationMode?.mode ?? null,
            conflictResolution: resolvedConflict?.resolution ?? null,
            conflictFileCount: resolvedConflict?.files.length ?? 0,
          });
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "running",
              addMergedSourceLaneId: sourceLaneId,
              ...(resolvedConflict
                ? { addResolvedConflict: resolvedConflict }
                : {}),
              ...(completedMergeValidationMode?.mode === "run"
                ? {
                    clearValidationDebt: true,
                    addValidationEvidence: {
                      sourceLaneIds: [
                        ...(completedMergeValidationMode.coveredLaneIds ?? []),
                      ],
                      contextIds: [
                        ...(completedMergeValidationMode.coveredContextIds ??
                          []),
                      ],
                      commandIdentity: laneMergeCommandIdentity(
                        completedMergeValidationMode,
                      ),
                      recordedAt: now(),
                    },
                  }
                : { addValidationDebtSourceLaneId: sourceLaneId }),
            }),
          );
          const refreshed = execution.joins[joinId];
          if (!refreshed) {
            const message = `Join ${joinId} disappeared after persisting progress`;
            logger.error("graph-workflow.join.disappeared", { joinId });
            return {
              status: "failed",
              message,
              conflictFiles: [],
              failedSourceLaneId: sourceLaneId,
              haltReason: null,
              resolutionFailure: null,
            };
          }
          join = refreshed;
          logger.info("graph-workflow.join.source_merged", {
            joinId,
            sourceLaneId,
            targetLaneId: join.targetLaneId,
            executionId: execution.id,
          });
          continue;
        }

        const failureStatus =
          mergeStatus === "conflicts" ? "conflicts" : "failed";
        lifecycle?.("join.lane_merge.failed", {
          joinId,
          sourceLaneId,
          durationMs: Math.max(0, Date.parse(now()) - laneMergeStartedMs),
          mergeStatus: failureStatus,
          conflictFileCount: mergeConflictFiles.length,
        });
        const message =
          resolutionFailure !== null
            ? resolutionInfrastructureMessage(resolutionFailure)
            : (mergeError ??
              (mergeStatus === "ready-to-land"
                ? "Join merge prepared but target worktree was dirty; cannot land autonomously"
                : mergeStatus === "discarded"
                  ? "Join merge was discarded"
                  : "Join merge failed"));
        execution = await mutateActive((e) =>
          applyJoinProgress(e, joinId, now(), {
            status: failureStatus,
            errorMessage: message,
            // An infrastructure failure never read these files, so recording
            // them as the join's conflict would blame content nothing
            // examined. They stay on the result as context for the halt.
            conflicts:
              resolutionFailure === null && mergeConflictFiles.length > 0
                ? {
                    files: mergeConflictFiles,
                    message,
                    analysis: mergeConflictAnalysis,
                  }
                : null,
            conflictGuidance: null,
          }),
        );
        logger.error("graph-workflow.join.source_merge_failed", {
          joinId,
          sourceLaneId,
          mergeStatus: failureStatus,
          conflictFiles: mergeConflictFiles.length,
          executionId: execution.id,
          haltReasonType: mergeHaltReason?.type ?? null,
          resolutionFailureKind: resolutionFailure?.kind ?? null,
          resolutionFailureRetryable: resolutionFailure?.retryable ?? null,
        });
        return {
          status: "failed",
          message,
          conflictFiles: mergeConflictFiles,
          failedSourceLaneId: sourceLaneId,
          haltReason: mergeHaltReason,
          resolutionFailure,
        };
      }
    },
  };
}
