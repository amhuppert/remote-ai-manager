import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import { abortInProgressMerge as defaultAbortInProgressMerge } from "@/lib/git/worktree";
import type { ConflictEntry } from "@/lib/jobs/schemas";
import type { DeliveryGateHaltReason } from "@/lib/jobs/schemas";
import type { GraphMergeRunner } from "./graph-merge-runner";
import type { PerSessionMergeMutex } from "./per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/shared/lock-retry";
import { applyJoinProgress } from "./context-transitions";
import { remainingSourceLanes, resolveLaneConversationId } from "./lane-join";
import { buildJoinResolutionContext } from "./join-resolution-context";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflow-graph/schemas";
const logger = createLogger("graph-workflow-join-runner");

export type JoinRunnerMutateActive = (
  mutator: (
    execution: GraphWorkflowExecution,
  ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
) => Promise<GraphWorkflowExecution>;

interface JoinRunnerRunInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  joinId: string;
  mutateActive: JoinRunnerMutateActive;
}

type JoinRunResult =
  | { status: "succeeded" }
  | {
      status: "failed";
      message: string;
      conflictFiles: string[];
      failedSourceLaneId: string;
      haltReason: DeliveryGateHaltReason | null;
    };

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
  createJobId?(): string;
  now?(): string;
}

export function createJoinRunner(deps: JoinRunnerDeps): JoinRunner {
  const createJobId = deps.createJobId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());
  const abortInProgressMerge =
    deps.abortInProgressMerge ?? defaultAbortInProgressMerge;

  return {
    async run(input): Promise<JoinRunResult> {
      const { projectPath, projectName, sessionName, joinId, mutateActive } =
        input;

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
          };
        }

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

        const sourceWorktreePath = sourceLane.worktreePath;
        const resolutionContext =
          buildJoinResolutionContext(execution, currentJoin, sourceLaneId) ??
          undefined;
        const conversationId =
          resolveLaneConversationId(execution, sourceLaneId) ?? undefined;
        if (conversationId === undefined) {
          logger.warn("graph-workflow.join.lane_conversation_missing", {
            joinId,
            sourceLaneId,
            executionId: execution.id,
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

        try {
          const output = await deps.mergeMutex.withMergeMutex(
            { projectPath, sessionName },
            () =>
              deps.sessionGitLock.withSessionGitLock(
                { projectPath, sessionName },
                async () => {
                  // Self-healing preflight: a previously failed resolution
                  // leaves the source worktree mid-merge, and git refuses to
                  // start a new merge over one. An operator who resolved
                  // manually has committed, so nothing is aborted for them.
                  const staleAborted =
                    await abortInProgressMerge(sourceWorktreePath);
                  if (staleAborted) {
                    logger.info("graph-workflow.join.stale_merge_aborted", {
                      joinId,
                      sourceLaneId,
                      sourceWorktreePath,
                    });
                  }

                  const first = await runMerge();
                  if (first.status !== "conflicts") return first;

                  // One clean retry before surfacing the conflict: failed
                  // resolutions are frequently transient (structured-output
                  // parse failures, an agent giving up mid-run) and retrying
                  // on top of a half-resolved tree is worse than starting
                  // over.
                  logger.info("graph-workflow.join.conflict_retry", {
                    joinId,
                    sourceLaneId,
                    conflictFiles: first.conflictFiles.length,
                  });
                  await abortInProgressMerge(sourceWorktreePath);
                  return runMerge();
                },
              ),
          );
          mergeStatus = output.status;
          mergeError = output.error;
          mergeConflictFiles = output.conflictFiles;
          mergeConflictAnalysis = output.conflictAnalysis;
          mergeHaltReason = output.haltReason;
        } catch (err) {
          mergeStatus = "failed";
          mergeError = getErrorMessage(err);
          mergeConflictFiles = [];
          mergeHaltReason = null;
        }

        if (mergeStatus === "completed") {
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "running",
              addMergedSourceLaneId: sourceLaneId,
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
        const message =
          mergeError ??
          (mergeStatus === "ready-to-land"
            ? "Join merge prepared but target worktree was dirty; cannot land autonomously"
            : mergeStatus === "discarded"
              ? "Join merge was discarded"
              : "Join merge failed");
        execution = await mutateActive((e) =>
          applyJoinProgress(e, joinId, now(), {
            status: failureStatus,
            errorMessage: message,
            conflicts:
              mergeConflictFiles.length > 0
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
        });
        return {
          status: "failed",
          message,
          conflictFiles: mergeConflictFiles,
          failedSourceLaneId: sourceLaneId,
          haltReason: mergeHaltReason,
        };
      }
    },
  };
}
